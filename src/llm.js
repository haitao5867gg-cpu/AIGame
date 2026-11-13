'use strict';

// 第 2 / 5 节：调用 OpenAI 兼容 /chat/completions。
// - 零第三方依赖：用 Node 内置 fetch + AbortController 实现超时。
// - 每次调用（含失败）追加一行到 data/usage.jsonl。
// - 当日 token 用量达到上限时拒绝调用（抛出带 status / expose 的中文错误）。
// - LLM_MOCK=1：完全离线，按 purpose 返回确定性假 JSON：
//   建世界(world)、普通回合(turn)、事件开启/结算(turn 变体)、编年史(chapter)、新顶点(apex)。
// - LLM_EXTRA_BODY：JSON 字符串，解析成对象后合并进请求体（如 {"thinking":{"type":"disabled"}} 提速）；
//   解析失败或非 JSON 对象时忽略并告警。
// - 成人模式（src/adult-mode.js）：opts.route 或请求上下文 llmRoute 为 'adult' 时，改走成人模式网关
//   （ADULT_LLM_BASE + EXPLABS_API_KEY + ADULT_LLM_MODEL），用量记录带 route:'adult'，有自己的每日上限；
//   流式、思考进度、JSON 模式等调用方式不变。

const store = require('./store.js');
const context = require('./context.js');
const adultMode = require('./adult-mode.js');
const prefs = require('./prefs.js');

const PURPOSES = Object.freeze({
  WORLD: 'world',     // 建世界
  TURN: 'turn',       // 普通回合 / 事件开启 / 事件结算
  CHAPTER: 'chapter', // 编年史压缩
  APEX: 'apex',       // 新顶点
  EPITAPH: 'epitaph', // 前世墓志铭（死亡时额外调用）
  REBIRTH: 'rebirth', // 新一世开场（重生时额外调用）
  PROLOGUE: 'prologue', // 老世界补序章（GET /prologue 时额外调用）
  ITEMS_INFO: 'items-info', // 老物品补介绍（GET /items 时批量生成）
  GENRE: 'genre',       // 老世界补判题材（ensureGenre 的短调用）
  SUGGEST: 'suggest',   // 玩家点「灵感」生成下一步建议
  STATS: 'stats',       // 老世界补设计专属状态（GET /stats 时额外调用）
  PROFILE: 'profile',   // 后台总结玩家画像（summary / traits / wants）
  OUTLINE: 'outline',   // 叙事 v3：作者自用的隐藏大纲（卷节拍表 + 章卡）
  STORY: 'story',       // 叙事 v3：按五段任务书只写纯正文（流式）
  LEDGER: 'ledger',     // 叙事 v3：写完正文后从正文里记账（数值 / 物品 / 线索 / 灵感…）
  CHAPTER_CLOSE: 'chapter-close', // 叙事 v3：一章写完后的章摘要
  CHAPTER_PLAN: 'chapter-plan',   // 叙事 v3：规划下一章的章卡
});

// 由 seed 派生少量差异，保证「同一输入 → 同一输出」的确定性。
function hash(s) {
  let h = 2166136261 >>> 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

// 解析 LLM_EXTRA_BODY：空值静默返回 {}；非 JSON 对象或解析失败时忽略并告警。
// 单独导出，便于单测解析与告警行为。
function parseExtraBody(raw) {
  const text = raw == null ? '' : String(raw).trim();
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    console.warn('[llm] LLM_EXTRA_BODY 不是 JSON 对象，已忽略');
  } catch (_) {
    console.warn('[llm] LLM_EXTRA_BODY 解析失败（不是合法 JSON），已忽略');
  }
  return {};
}

// 按次覆盖请求体：先全局 LLM_EXTRA_BODY，再叠 opts.extraBody（同名覆盖；值为 null 表示删掉该键）。
function mergeExtraBody(globalBody, perCall) {
  const out = Object.assign({}, globalBody || {});
  if (perCall && typeof perCall === 'object' && !Array.isArray(perCall)) {
    for (const k of Object.keys(perCall)) {
      if (perCall[k] === null) delete out[k];
      else out[k] = perCall[k];
    }
  }
  return out;
}

// 成人模式网关（Experiential）上的 deepseek-v4.1-flash-uncensored 认 DeepSeek 原生的 thinking:{type}
// 和 reasoning_effort（2026-11-12 实测）；但不带任何思考参数时它默认要思考（强度 high），
// 带了 max_tokens 的短调用可能被思考吃光额度。所以调用方没指定时补一个 thinking disabled，其余原样透传。
function adaptAdultBody(body) {
  const out = Object.assign({}, body || {});
  const hasThinking = out.thinking && typeof out.thinking === 'object';
  const hasEffort = typeof out.reasoning_effort === 'string' && out.reasoning_effort;
  if (!hasThinking && !hasEffort) out.thinking = { type: 'disabled' };
  return out;
}

// ---- 流式叙事解码器 ----
// LLM 流式返回的是「正在生成的整个 JSON 对象」的片段，叙事位于 "narration":"..." 字符串里。
// 下面这组纯函数把累积的原始 JSON 文本增量解码出 narration 的纯文本：
// 每次 push 都从累积文本重新推导（JSON 很小，开销可忽略），因此天然支持任意 chunk 边界
// —— 键名、转义序列、\uXXXX、多字节中文都可能被从中间切开，也不会重复或漏发字符。

const SIMPLE_ESCAPES = Object.freeze({
  '"': '"', '\\': '\\', '/': '/',
  b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
});

function isHex4(s) {
  return /^[0-9a-fA-F]{4}$/.test(s);
}

// 读取从 start（指向开头引号）开始的一个 JSON 字符串 token（键或某个值）。
// 返回 { value, end, complete }；complete=false 表示还没读到结束引号（被 chunk 切开）。
function scanJsonString(raw, start) {
  let i = start + 1;
  let value = '';
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') return { value, end: i + 1, complete: true };
    if (c === '\\') {
      if (i + 1 >= raw.length) return { value, end: raw.length, complete: false };
      const e = raw[i + 1];
      if (e === 'u') {
        if (i + 6 > raw.length) return { value, end: raw.length, complete: false };
        const hex = raw.slice(i + 2, i + 6);
        value += isHex4(hex) ? String.fromCharCode(parseInt(hex, 16)) : '\uFFFD';
        i += 6;
      } else {
        value += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)
          ? SIMPLE_ESCAPES[e] : e;
        i += 2;
      }
    } else {
      value += c; // 普通字符，含多字节中文（在 JS 字符串里就是一个字符）
      i += 1;
    }
  }
  return { value, end: raw.length, complete: false };
}

// 从 narration 值的开头引号开始按 JSON 字符串规则增量解码，返回当前已能确定的前缀。
function scanNarrationValue(raw, q) {
  let i = q + 1;
  let out = '';
  let done = false;
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"') { done = true; break; } // 未转义的结束引号
    if (c === '\\') {
      if (i + 1 >= raw.length) break; // 转义序列被切开，等更多数据
      const e = raw[i + 1];
      if (e === 'u') {
        if (i + 6 > raw.length) break; // \uXXXX 被切开，等更多数据
        const hex = raw.slice(i + 2, i + 6);
        // 逐码元解码：代理对被 slice 成两个码元先后发出，消费端拼接后仍是合法码点。
        out += isHex4(hex) ? String.fromCharCode(parseInt(hex, 16)) : '\uFFFD';
        i += 6;
      } else {
        out += Object.prototype.hasOwnProperty.call(SIMPLE_ESCAPES, e)
          ? SIMPLE_ESCAPES[e] : e;
        i += 2;
      }
    } else {
      out += c; // 普通字符，含中文
      i += 1;
    }
  }
  return { text: out, done };
}

// 在累积的 JSON 文本里定位 "narration": 字段，返回其字符串值已解码出来的前缀。
// 只看「字符串 token 后面跟冒号」的键，因此字符串值里即便含 "narration" 字样也不会误判；
// narration 不是第一个字段时也能正确跳过前面的字段。
function decodeNarration(raw) {
  let i = 0;
  const n = raw.length;
  while (i < n) {
    if (raw[i] !== '"') { i += 1; continue; }
    const tok = scanJsonString(raw, i);
    if (!tok.complete) return { text: '', done: false }; // 字符串被切开，等更多数据
    let j = tok.end;
    while (j < n && /\s/.test(raw[j])) j += 1;
    if (j >= n) return { text: '', done: false };
    if (raw[j] === ':' && tok.value === 'narration') {
      j += 1;
      while (j < n && /\s/.test(raw[j])) j += 1;
      if (j >= n) return { text: '', done: false };
      if (raw[j] !== '"') return { text: '', done: false }; // 非字符串值（如 null）
      return scanNarrationValue(raw, j);
    }
    i = tok.end;
  }
  return { text: '', done: false };
}

// 状态机包装：push(片段) 增量喂入，每有解码出的新文本就回调 onDelta(newText)。
function createNarrationDecoder(onDelta) {
  let raw = '';
  let emitted = 0;
  return {
    push(chunk) {
      raw += chunk == null ? '' : String(chunk);
      const { text } = decodeNarration(raw);
      if (text.length > emitted) {
        const delta = text.slice(emitted);
        emitted = text.length;
        if (typeof onDelta === 'function') onDelta(delta);
      }
    },
    get value() { return decodeNarration(raw).text; },
    get raw() { return raw; },
  };
}

// ---- SSE 读取（流式 HTTP 用）----
// 把 Web ReadableStream / async iterable / 字符串统一成可 for-await 的字节（或文本）块。
function sseChunks(body) {
  if (body == null) return [];
  if (typeof body === 'string') return [body];
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    return {
      async *[Symbol.asyncIterator]() {
        while (true) {
          const r = await reader.read();
          if (r.done) break;
          yield r.value;
        }
      },
    };
  }
  return body; // 已是 async iterable
}

function handleSSELine(line, onData) {
  if (!line.startsWith('data:')) return;
  let data = line.slice(5);
  if (data.charAt(0) === ' ') data = data.slice(1);
  onData(data);
}

// 逐行解析 SSE 的 data: 行；用 TextDecoder(stream:true) 正确处理跨 chunk 切开的多字节 UTF-8。
async function readSSE(body, onData) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of sseChunks(body)) {
    if (chunk == null) continue;
    buf += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      handleSSELine(buf.slice(0, idx).replace(/\r$/, ''), onData);
      buf = buf.slice(idx + 1);
    }
  }
  buf += decoder.decode(); // flush 未完成的多字节序列
  if (buf) handleSSELine(buf.replace(/\r$/, ''), onData);
}

// ---- 确定性假数据 ----

function mockOrigins(m) {
  const identity = m && typeof m.identity === 'string' && m.identity.trim() ? m.identity.trim() : '';
  const list = [
    { title: '守夜会学徒', blurb: '跟着守夜人学看钟，消息灵通，但规矩多', style: '秩序', attrs: { 心智: 2, 声望: 2, 体魄: 1, 魅力: 1 }, item: { name: '更漏铜牌', desc: '守夜会学徒的腰牌，夜里能过关卡。', type: '信物' } },
    { title: '拾骨者', blurb: '在废墟里淘旧物，身手灵活，欠着黑市的钱', style: '冒险', attrs: { 体魄: 3, 气运: 2, 资源: 1 }, item: { name: '铁钩', desc: '翻废墟用的铁钩，也能防身。', type: '工具' } },
    { title: '落魄账房', blurb: '会算账识人心，手里没钱，认得不少人', style: '权谋', attrs: { 心智: 3, 魅力: 2, 资源: 1 }, item: { name: '旧账本', desc: '记着港里一半人的欠账。', type: '文书' } },
  ];
  if (identity) list.unshift({ title: identity.slice(0, 8), blurb: '按你写的：' + identity.slice(0, 30), style: '坚韧', custom: true, attrs: { 体魄: 2, 心智: 2, 魅力: 2 }, item: { name: '随身旧物', desc: '一件跟了你很久的旧物。', type: '杂物' } });
  return list.slice(0, 3);
}

function mockWorld(m) {
  const seed = m && m.seed ? String(m.seed) : '一句世界观';
  const n = hash(seed) % 7;
  const title = clip(seed, 10) + '·' + ['纪元', '残卷', '秘史', '长夜', '边境', '旧约', '回响'][n];
  return {
    genre: 'xuanhuan',
    hero: { name: (m && m.name) || '雾生', appearance: (m && m.appearance) || '一身旧袍' },
    origins: mockOrigins(m),
    bible: {
      title,
      tone: '苍茫而诡谲，暗流涌动',
      rules: ['力量皆有代价', '名字即契约', '夜行者不受欺', '旧债终须偿'],
      places: [
        { name: '灰烬港', desc: '终年落灰的旧港，船骸堆成山丘' },
        { name: '无灯塔', desc: '传说顶层藏着一封信，却无人见过亮灯' },
        { name: '枯井集市', desc: '以记忆而非钱币交易的黑市' },
      ],
      factions: [
        { name: '守夜会', desc: '掌管钟声与更漏', stance: '中立偏保守' },
        { name: '拾骨者', desc: '在废墟里淘换旧物', stance: '逐利' },
        { name: '缄默庭', desc: '不立文字的审判者', stance: '敌意未明' },
      ],
      npcs: [
        { name: '守夜人', role: '引路者', desc: '总在雾里提一盏不灭的灯', want: '守住钟声不乱，查清谁在偷改更漏', voice: '短句铁令，从不解释' },
        { name: '铸剑师', role: '匠人', desc: '只肯为记得名字的人锻铁', want: '寻回失传锻谱，重铸一把有名之剑', voice: '哄劝式隐喻，句句带笑' },
        { name: '拾骨少女', role: '线人', desc: '消息比刀快，笑里藏着价码', want: '攒够钱离开灰烬港，不再替人卖命', voice: '记账式冷语，只报数目' },
      ],
      start: {
        place: '灰烬港',
        period: '清晨',
        situation: '你在一条搁浅的船上醒来，手里攥着一封无字信。',
        items: ['一封无字信', '旧铜灯', '半张海图'],
        items_info: {
          '一封无字信': { desc: '一封没有落款的旧信，收信人不明，像藏着一段未了的约。', type: '信物' },
          '旧铜灯': { desc: '灯身斑驳却长明的旧铜灯，雾夜可照路，来历无人说得清。', type: '法器' },
          '半张海图': { desc: '残存半幅的航路图，标着一处不在任何册子上的岛屿。', type: '文书' },
        },
        // 开局关键时间/规则事实，锁定满月日期等时间线，写入 state.facts（叙事不得改写）。
        facts: ['满月在三日后', '城门每日戌时落锁', '报出真名会被登记'],
      },
      prologue: {
        world: '灰烬港是个终年落灰的旧港，船骸堆成山丘，守夜会掌着钟声与更漏，拾骨者在废墟里淘换旧物。这里的人以记忆而非钱币交易，名字一旦报出便会被登记，力量都暗中标好了代价。雾里总有人提灯走动，却没人说得清灯为谁而亮。',
        me: '你是在搁浅船骸间醒来的人，手里攥着一封无字信，没人认得你，你也记不清自己从哪来。你识字、警觉，擅长在别人开口前先看清局势；但你没有根基，也没有一个能替你作保的名字。',
        goal: '你想查清那封无字信究竟要交给谁，在这座把名字当契约的港里，挣一个不必躲藏的位置。',
        now: '此刻你在一条搁浅的船上醒来，雾里传来断续的钟声，手里那封无字信还不知要交给谁。你该先看清四周，再决定要不要向提灯走来的守夜人报出名字。',
      },
      eventThemes: ['魔族入侵', '宫廷政变', '天灾', '秘境开启', '商路断绝', '古神低语'],
      // 开局专属状态：2 个数值槽 + 1 个等级阶梯，名字带本世界（玄幻 / 灰烬港）的味道，
      // 让 LLM_MOCK 建出的世界也走真实设计路径（engine.createWorld 会消毒成 state.stats）。
      stats: [
        {
          name: '灵力', kind: 'gauge', icon: '✦', desc: '驱使术法的余地，运功耗去、打坐回补',
          max: 100, start: 68, drift: -2,
          warn: [
            { below: 30, label: '灵力不济', effect: '术法难以施展，强行运功会反噬' },
            { below: 10, label: '灵力枯竭', effect: '经脉刺痛、提不起劲', drain: '体魄' },
          ],
        },
        {
          name: '神识', kind: 'gauge', icon: '👁', desc: '心神清明程度，撞见怪事会损耗',
          max: 100, start: 80, drift: 0,
          warn: [
            { below: 25, label: '心神不宁', effect: '开始出现幻听幻视，难辨真假' },
          ],
        },
        {
          name: '境界', kind: 'rank', icon: '☯', desc: '修行层次，突破需机缘与代价',
          ranks: ['凡人', '炼气', '筑基', '金丹', '元婴', '化神'], start: 1,
        },
      ],
    },
    apex: {
      title: '隐秘王冠',
      hint: '北方的钟声',
      // 初始声望即为 6，条件刻意设为可达，便于跑通顶点检测 / 高光 / 刷新链路。
      condition: { attrs: { 声望: 6 } },
      achievedAt: null,
    },
  };
}

// 老世界补判题材：按 bible 的标题 / 基调 / 前几条规则，离线给一个合法 genre。
function mockGenre(m) {
  const text = [m && m.title, m && m.tone]
    .concat(Array.isArray(m && m.rules) ? m.rules : [])
    .join(' ');
  if (/恐怖|悬疑|诡|鬼|惊悚|阴森/.test(text)) return { genre: 'horror' };
  if (/系统|等级|游戏|副本|掉落|玩家/.test(text)) return { genre: 'game' };
  if (/都市|现代|公司|外卖|地铁|职场/.test(text)) return { genre: 'urban' };
  if (/日常|种田|经营|田园|温馨|小店/.test(text)) return { genre: 'cozy' };
  if (/修仙|仙|玄|境界|法宝|灵力|宗门/.test(text)) return { genre: 'xuanhuan' };
  return { genre: 'general' };
}

// 玩家点「灵感」：从一个固定的通用行动池里确定性挑 3 条。
// 去掉 avoid 中出现过的，按 avoid + turn 的 hash 选起点，保证「同输入同输出、avoid 不同结果不同」。
function mockSuggest(m) {
  const pool = [
    '先四下看看，找条退路',
    '找个人打听刚才的动静',
    '检查一下随身带的东西',
    '顺着声音摸过去看看',
    '先躲起来观察一会儿',
    '主动上前搭话，探探口风',
    '沿着来路退回去，别惊动他们',
    '把手里的东西亮出来试探反应',
    '绕到侧门，看看有没有别的出入口',
    '记下对方说的每句话，回头再琢磨',
    '先歇口气，等局面自己明朗些',
    '挑个最不起眼的角落藏好身形',
  ];
  const avoid = Array.isArray(m && m.avoid) ? m.avoid : [];
  const avoidSet = new Set(avoid.map((x) => String(x)));
  let candidates = pool.filter((x) => !avoidSet.has(x));
  // avoid 极端情况下把池子削到不足 3 条时，按池子顺序补回，保证始终输出 3 条。
  if (candidates.length < 3) {
    for (const x of pool) {
      if (candidates.length >= 3) break;
      if (!candidates.includes(x)) candidates.push(x);
    }
  }
  const start = hash(JSON.stringify(m && m.avoid || []) + (m && m.turn || 0)) % candidates.length;
  const out = [];
  for (let i = 0; i < 3; i++) out.push(candidates[(start + i) % candidates.length]);
  return { suggestions: out };
}

function mockTurn(m) {
  const turn = (m && m.turn) || 1;
  const timeSkip = m && m.timeSkip;
  // 分成 2~4 个短段落，段落间用 \n\n 分隔，台词单独成段（与回合 prompt 的分段要求一致）。
  const baseNarration = [
    `第${turn}回合，你顺着灰烬港的旧道继续前行，雾里传来断续的钟声。`,
    '守夜人提灯拦住去路：「钟声乱了，你听见了几下？」',
    '远处有人在低声交换消息，你停下脚步，权衡着下一步该信任谁。',
  ].join('\n\n');
  const out = {
    // 时光推进：叙事首句点明这段时间过去了，其余正文照旧。
    narration: timeSkip ? `${timeSkip.label}过去了。\n\n${baseNarration}` : baseNarration,
    state_diff: { 心智: 1 },
    items_add: turn % 5 === 0 ? ['一枚旧币'] : [],
    items_remove: [],
    // 新增物品的介绍与 items_add 同步给出（引擎只接受真正加入的名字）。
    items_info: turn % 5 === 0
      ? { '一枚旧币': { desc: '拾来的一枚磨损旧币，面文已模糊，或可换些小物。', type: '杂物' } }
      : {},
    npc_attitude: {},
    npc_updates: [], // 可选人物档案更新；下面按「确实出场的人物 / 原文」补合法条目，无变化保持空数组
    persona_tags: ['冒险'],
    suggestions: ['继续沿旧道探查', '向守夜人打听钟声', '先去枯井集市补给'],
    // 越界升级：约每 7 回合模拟一次越界行为，让引擎累计 oversteps、覆盖升级阶梯链路。
    overstep: turn % 7 === 0,
    // 偶数回合模拟玩家在私下独处、继续上一回合同一件事，触发安静模式链路。
    focus: turn % 2 === 0 ? 'private' : 'action',
    continuing: turn % 2 === 0,
    adult: false,
  };
  // 场景插图：每 3 回合给一幅值得画的画面，其余回合不出图。scene 只列名字，外貌交给参考图。
  if (turn % 3 === 1) {
    out.scene = {
      draw: true,
      place: '雾中钟楼',
      cast: ['你', '守夜人'],
      items: [],
      action: '你在左，提灯的守夜人在右拦住去路，雾气翻涌',
      place_en: 'a clock tower street in thick fog',
      light_en: 'dim lantern glow, swirling mist',
      people: [
        { who: '你', en: 'a traveler in an old robe stopping short', pos: 'left' },
        { who: '守夜人', en: 'a night watchman holding up a lantern, blocking the way', pos: 'right' },
      ],
    };
  } else {
    out.scene = { draw: false };
  }
  // 事实账本：约每 5 回合确立一条客观事实（≤30 字），覆盖 new_facts 字段。
  if (turn % 5 === 1) {
    out.new_facts = ['第' + turn + '回合：钟楼在黄昏敲三下'];
  }
  // 印记：每 4 回合留下一枚（≤16 字），每 8 回合了结一枚（文本须与已有完全一致）。
  if (turn % 4 === 0) out.marks_add = ['印记' + turn];
  if (turn % 8 === 0) out.marks_remove = ['印记' + (turn - 4)];
  // 未解之谜：每 3 回合埋一条（文本可预测），每 6 回合解开第 turn-3 回合埋的那条（完全一致）。
  if (turn % 3 === 0) out.threads_add = ['线索第' + turn + '条'];
  if (turn % 6 === 0) out.threads_resolve = ['线索第' + (turn - 3) + '条'];
  // 坊间传闻：约每 3 回合给一条（≤40 字），内容真假难辨、可作侧面暗示。
  if (turn % 3 === 0) {
    const rumors = [
      '守夜会的更漏昨夜快了一刻',
      '拾骨者在枯井淘到半页旧谱',
      '北边的钟声近来总在子夜响',
    ];
    out.rumor = rumors[Math.floor(turn / 3) % rumors.length];
  }
  // 地点与时间：偶尔移动到设定地点（或叙事里出现的地点），按节奏推进 0~2 个时段。
  if (turn % 4 === 0) {
    const places = ['无灯塔', '枯井集市', '灰烬港'];
    out.move_to = places[Math.floor(turn / 4) % places.length];
  }
  out.time_passes = turn % 6 === 0 ? 0 : (turn % 5 === 0 ? 2 : 1);
  // 事件开启：仅当引擎要求时给出 event.title / event.desc。
  if (m && m.needEvent) {
    const theme = m.theme || '秘境开启';
    out.event = {
      title: `${theme}·第${turn}回`,
      desc: `关于「${theme}」的风声骤然收紧，整座灰烬港都屏住了呼吸。`,
    };
  }
  // 事件结算：仅当引擎要求时给出 event_check（attr 为白名单属性，quality 0~3）。
  if (m && m.needSettlement) {
    // 新公式 score = min(体魄,20)*0.5 + quality*4 + rng(0~8)。
    // quality=3 时体魄 6 起评 3+12+0~8 = 15~23，最差只到「代价」、绝不「殒命」，
    // 让 mock 的长时间循环确定性地不死亡。
    out.event_check = { attr: '体魄', response_quality: 3 };
  }
  // 朗读提示：旁白段只给 mood/pace；NPC 台词段额外给 speaker（NPC 设定原名）。
  out.voice_hints = [
    { para: 0, mood: 'mysterious', pace: 'slow' },
    { para: 1, mood: 'tense', pace: 'normal', speaker: '守夜人' },
    { para: 2, mood: 'calm', pace: 'normal' },
  ];
  // NPC 长期档案：守夜人确实出现在上面这段叙事里，evidence 是 narration 的连续子串、
  // 公共值摘自原文。只给「确实出场的人物 / 原文」合法 npc_updates，不编造未登场人物、
  // 不把没发生的事写成已发生；第 1 回合给一次身份 / 描述线索，其后偶尔记一次真实出场
  // （不加新资料），其余回合保持空数组，不为测试填满资料、不强求每回合变化。
  // 这条固定证据只在该分支最终 narration 确实出现时才发：overstep / event / settlement
  // 等特殊分支各按自身实际叙事判断，绝不发出「证据不在原文」的自相矛盾夹具，也不改
  // 原故事来凑字段。
  const npcEvidence = '守夜人提灯拦住去路';
  if (out.narration.includes(npcEvidence)) {
    if (turn === 1) {
      out.npc_updates.push({
        name: '守夜人',
        kind: 'interaction',
        evidence: npcEvidence,
        known: {
          role: '守夜人',
          description: '守夜人提灯拦住去路',
        },
      });
    } else if (turn % 5 === 0) {
      out.npc_updates.push({ name: '守夜人', kind: 'interaction', evidence: npcEvidence });
    }
  }
  // 时光推进：跳跃结束时的时段，供引擎落定时钟（其余字段不变）。
  if (timeSkip) out.landing_period = '黄昏';
  // 世界专属状态：能拿到数值槽名字时，偶数回合 +10、奇数回合 -5，让 mock 回合走
  // 真实的 stats_diff → 引擎结算链路；拿不到（老存档 / 无数值槽）就不输出该字段。
  const statNames = Array.isArray(m && m.statNames)
    ? m.statNames.filter((n) => typeof n === 'string' && n) : [];
  if (statNames.length) {
    out.stats_diff = { [statNames[0]]: turn % 2 === 0 ? 10 : -5 };
  }
  return out;
}

function mockChapter(m) {
  const from = (m && m.fromTurn) || 1;
  const to = (m && m.toTurn) || 20;
  return {
    summary: (
      `第${from}至${to}回合，旅人在灰烬港与无灯塔之间辗转，几度卷入城中暗流；` +
      `钟声反复出现，守夜人的态度若即若离，旧信仍无一字。声名渐起，却也招来缄默庭的注视。`
    ).slice(0, 300),
  };
}

function mockApex(m) {
  const gen = (m && m.generation) || 2;
  return {
    title: ['隐秘王冠', '无冕之约', '沉钟之主', '雾中冠冕', '未名的加冕'][(gen - 1) % 5],
    hint: ['北方的钟声', '塔顶不灭的灯', '被抹去的第七更', '枯井深处的名字'][gen % 4],
    condition: { attrs: { 声望: 8 + gen } },
  };
}

// 前世墓志铭：≤80 字，确定性假数据。
function mockEpitaph(m) {
  const life = (m && m.life) || 1;
  const name = (m && m.name) || '旅人';
  return {
    epitaph: `第${life}世，${name}行过灰烬港的雾，听过无灯塔的钟，终没能等来那封信的落款。`,
  };
}

// 新一世开场：150~300 字，确定性假数据；覆盖「间隔 / 变化 / 有人隐约记得」四要素。
function mockRebirthOpening(m) {
  const life = (m && m.life) || 2;
  const name = (m && m.name) || '新旅人';
  return {
    opening: (
      `距上一世已过三年。灰烬港的雾比记忆里薄了些，旧钟楼在无人留意的清晨重新敲响，` +
      `城门落锁的时刻却因上一世那桩旧案提前了半刻，守夜会据此在名册上多添了一栏。` +
      `你以「${name}」之名在搁浅的船骸间醒来，手里仍攥着一封无字信——没人说得清它为何又回到你掌心，` +
      `就像没人说得清这一世为何仍从同一处滩头开始。` +
      `守夜人翻着更漏册抬眼时停了一瞬，像在辨认一张早该忘掉的脸，终究只把灯往你这边挪了半寸；` +
      `拾骨少女则把一句「你倒是像谁」咽了回去，低头继续数她的旧币。` +
      `第${life}世就这样开场：旧债没有随上一世埋进土里，满月仍在三日后，而世界已经悄悄改过一次规矩，` +
      `你得在这副陌生的面孔里，重新挣一个位置。`
    ),
  };
}

// 老世界补序章：mock 下返回一份合理的四段（now 写「此刻」的处境）。
function mockPrologue() {
  return {
    world: '灰烬港是个终年落灰的旧港，船骸堆成山丘，守夜会掌着钟声与更漏，拾骨者在废墟里淘换旧物。这里的人以记忆而非钱币交易，名字一旦报出便会被登记，力量都暗中标好了代价。雾里总有人提灯走动，却没人说得清灯为谁而亮。',
    me: '你是在搁浅船骸间醒来的人，手里攥着一封无字信，没人认得你，你也记不清自己从哪来。你识字、警觉，擅长在别人开口前先看清局势；但你没有根基，也没有一个能替你作保的名字。',
    goal: '你想查清那封无字信究竟要交给谁，在这座把名字当契约的港里，挣一个不必躲藏的位置。',
    now: '此刻守夜人正提灯朝你走来，钟声比往日乱了一拍。你该先决定要不要报出名字，再顺着更漏册上的异样问下去。',
  };
}

// 老物品补介绍：mock 下按请求名单逐个给一份简单介绍（确定性假数据）。
function mockItemsInfo(m) {
  const names = (m && Array.isArray(m.items)) ? m.items : [];
  const out = {};
  for (const name of names) {
    if (typeof name !== 'string' || !name.trim()) continue;
    out[name.trim()] = {
      desc: `随身的一件${name.trim()}，来历已不可考，却总在紧要处派上用场。`,
      type: '杂物',
    };
  }
  return out;
}

// 老世界补设计专属状态：按题材给 2 个合法数值槽（名字随题材变化），
// 让 LLM_MOCK 下 GET /stats 走真实的「模型设计 → normalizeStatsSpec 消毒 → 保存」链路。
// 后台总结玩家画像：返回确定性的 summary / traits / wants，供 LLM_MOCK 走真实链路。
// 叙事 v3 写正文：一段三段式的确定性假正文（含玩家行动），纯文本模式下就是全部正文。
function mockStory(m) {
  const action = m && m.action ? String(m.action) : '四下看看';
  const turn = m && Number.isSafeInteger(m.turn) ? m.turn : 1;
  return {
    narration: [
      `你决定${action}。雾从港口那边漫过来，钟声隔着水面传到耳边，一下，又一下。第${turn}回合，你把旧铜灯往身前提了提，灯光照出脚下湿滑的石阶。`,
      '守夜人站在石阶尽头，提灯的手没有动。「这么晚还出来，」他说，「你要找的人，不在这条街上。」你没接话，只是看着他灯罩上那道裂缝。',
      '远处有人吹了一声口哨，很短。守夜人的眼神往那边偏了一下，又落回你身上。你知道，他在等你先开口。',
    ].join('\n\n'),
  };
}

// 叙事 v3 记账：和普通回合 mock 同形，但不含 narration（正文已经写好）。
function mockLedger(m) {
  const out = mockTurn(m);
  delete out.narration;
  out.chapter = { beats_done: [], chapter_end: !!(m && m.chapterEnd) };
  return out;
}

function mockChapterClose(m) {
  const idx = m && Number.isSafeInteger(m.index) ? m.index : 1;
  return {
    title: `第${idx}章`,
    summary: `第${idx}章里，你在灰烬港的雾里查访无字信的来历，守夜人始终盯着你，拾骨少女开出了价码。章末，钟声在半夜多敲了一下。`,
    bridge: '钟声乱了，你决定去钟楼看看',
  };
}

function mockChapterPlan(m) {
  const idx = m && Number.isSafeInteger(m.index) ? m.index : 2;
  return { title: `第${idx}章·续`, goal: '顺着钟声查下去', start: '半夜的钟声', beats: ['钟楼的门开着', '有人在更漏旁留了记号'], end: '找到被调过的更漏', question: '是谁在改钟声', avoid: [] };
}

// 叙事 v3 隐藏大纲：一份合法的卷节拍表 + 3 张章卡（确定性假数据）。
function mockOutline() {
  return {
    premise: '无名者在灰烬港查清无字信的去处，也查清自己是谁',
    core_truth: '无字信是主角自己寄给十年后的自己的，写信的人就是失去记忆前的主角',
    hero_arc: '从只想自保的局外人，变成肯为港里人担责的人',
    volume: {
      title: '雾港之信', promise: '无字信背后藏着一段被抹去的约定', catalyst: '守夜人认出了信封上的火漆',
      crises: ['钟声被人偷改', '拾骨少女被缄默庭带走', '灰烬港封港'],
      midpoint: '信是主角自己写的', low: '主角被当成偷钟人通缉', payoff: '在钟楼里读出信的内容', hook: '信里提到的岛真的存在',
    },
    chapters: [
      { title: '搁浅', goal: '在港里站稳脚，弄清信从哪来', start: '在搁浅的船上醒来', beats: ['守夜人盘问来历', '枯井集市有人认得火漆'], end: '有人愿意替主角作保', question: '火漆上的纹样属于谁', avoid: ['不要揭开写信人的身份'] },
      { title: '乱钟', goal: '查出谁在偷改钟声', start: '钟声在半夜多敲了一下', beats: ['跟踪可疑的敲钟人', '缄默庭出面阻拦'], end: '找到被调过的更漏', question: '偷改钟声是为了掩盖什么', avoid: [] },
      { title: '封港', goal: '在封港前把信送出去', start: '港口贴出封港告示', beats: ['拾骨少女失踪', '铸剑师要一把有名之剑作交换'], end: '主角决定留下', question: '留下的代价是什么', avoid: [] },
    ],
  };
}

function mockProfile() {
  return {
    summary: '你行事谨慎，习惯先观察再动手，愿意与人结交，也偏爱带感情线的剧情。',
    traits: ['先观察后动手', '爱结交人', '喜欢感情线'],
    wants: '循序渐进、有人情味、留有余地的剧情',
  };
}

function mockStats(m) {
  const genre = (m && m.genre) || 'general';
  const byGenre = {
    xuanhuan: [['灵力', '✦'], ['神识', '👁']],
    urban: [['精力', '⚡'], ['心情', '☀']],
    game: [['能量', '⚡'], ['专注', '◎']],
    horror: [['理智', '👁'], ['体力', '❤']],
    cozy: [['心情', '☀'], ['体力', '❤']],
    general: [['精力', '⚡'], ['心情', '☀']],
  };
  const names = byGenre[genre] || byGenre.general;
  const g = (name, icon, start, drift, label, effect) => ({
    name, kind: 'gauge', icon, desc: `代表${name}的当前余量，会随行动与时段变化`,
    max: 100, start, drift,
    warn: [{ below: 25, label, effect }],
  });
  return {
    stats: [
      g(names[0][0], names[0][1], 60, -2, '偏低', '状态偏低，行动与叙事都要体现吃力'),
      g(names[1][0], names[1][1], 75, 0, '不稳', '状态起伏，判断容易出偏差'),
    ],
  };
}

function mockFor(purpose, m) {
  switch (purpose) {
    case 'npc_memory': return { npc_updates: [] };
    case PURPOSES.WORLD: return mockWorld(m);
    case PURPOSES.TURN: return mockTurn(m);
    case PURPOSES.CHAPTER: return mockChapter(m);
    case PURPOSES.APEX: return mockApex(m);
    case PURPOSES.EPITAPH: return mockEpitaph(m);
    case PURPOSES.REBIRTH: return mockRebirthOpening(m);
    case PURPOSES.PROLOGUE: return mockPrologue();
    case PURPOSES.ITEMS_INFO: return mockItemsInfo(m);
    case PURPOSES.GENRE: return mockGenre(m);
    case PURPOSES.SUGGEST: return mockSuggest(m);
    case PURPOSES.STATS: return mockStats(m);
    case PURPOSES.PROFILE: return mockProfile();
    case PURPOSES.OUTLINE: return mockOutline();
    case PURPOSES.STORY: return mockStory(m);
    case PURPOSES.LEDGER: return mockLedger(m);
    case PURPOSES.CHAPTER_CLOSE: return mockChapterClose(m);
    case PURPOSES.CHAPTER_PLAN: return mockChapterPlan(m);
    default: return mockTurn(m);
  }
}

// ---- 用量统计 ----

function dayKey(ts) {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

// UTC 日期口径（Cloudflare 每日免费额度按 UTC 零点重置）：YYYY-MM-DD。
function utcDayKey(ts) {
  const d = new Date(ts);
  return (
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getUTCDate()).padStart(2, '0')}`
  );
}

// 今日（UTC）Cloudflare 出图消耗的 Neurons 估算，纯函数。
// 有 neurons 字段的记录直接累加；没有 neurons 的成功记录按 175 估算（老记录）；别的 provider 不计。
function cloudflareNeuronsToday(rows, now) {
  const day = utcDayKey(now);
  let total = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || r.provider !== 'cloudflare') continue;
    if (utcDayKey(r.ts) !== day) continue;
    const n = r.neurons;
    if (n != null && n !== '' && Number.isFinite(Number(n))) total += Number(n);
    else if (r.ok) total += 175;
  }
  return total;
}

// 用量记录归属：没有 playerId 字段的老记录算 host 的。
function rowPlayerId(r) {
  return r && typeof r.playerId === 'string' && r.playerId ? r.playerId : 'host';
}

// 用量记录走的网关：成人模式记录带 route:'adult'，其余（含老记录）都算默认网关。
function rowRoute(r) {
  return r && r.route === adultMode.ROUTE ? adultMode.ROUTE : 'default';
}

// playerId 为空时统计全部记录；传了就只统计该玩家（无 playerId 的记录归 host）。
// route：'default' 只算默认网关，'adult' 只算成人模式，不传则两边都算。
function sumUsage(rows, filterDay, playerId, route) {
  let pt = 0;
  let ct = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (filterDay && dayKey(r.ts) !== filterDay) continue;
    if (playerId && rowPlayerId(r) !== playerId) continue;
    if (route && rowRoute(r) !== route) continue;
    pt += Number(r.prompt_tokens) || 0;
    ct += Number(r.completion_tokens) || 0;
  }
  return { prompt_tokens: pt, completion_tokens: ct, total: pt + ct };
}

// /api/usage/today：今天的 token 汇总 + 出图按提供方的成功 / 失败张数（同一 dayKey 时区口径）。
// 可选 playerId：传了就只统计该玩家的 token 与出图（无 playerId 的记录算 host），
// limit 由调用方按「全局 / 每人」选好传入；不传 playerId 则保持原行为（全局）。
function summarizeToday(rows, now, limit, playerId) {
  const day = dayKey(now);
  // 「今日对话 token」只算默认网关（朋友的网关）；成人模式另见 summarizeAdult。
  const t = sumUsage(rows, day, playerId, 'default');
  const lim = Number(limit) || 0;
  const byProvider = {};
  const total = { ok: 0, fail: 0 };
  let scenes = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object' || dayKey(r.ts) !== day) continue;
    if (playerId && rowPlayerId(r) !== playerId) continue;
    if (r.kind === 'scene' && r.ok) scenes += 1;
    if (r.kind !== 'image' && r.kind !== 'scene') continue;
    const p = String(r.provider || 'unknown');
    if (!byProvider[p]) byProvider[p] = { ok: 0, fail: 0 };
    const k = r.ok ? 'ok' : 'fail';
    byProvider[p][k] += 1;
    total[k] += 1;
  }
  return {
    date: day,
    tokens: {
      prompt: t.prompt_tokens, completion: t.completion_tokens, total: t.total,
      limit: lim, remaining: lim > 0 ? Math.max(0, lim - t.total) : null,
    },
    images: { byProvider, total, scenes },
  };
}

// 今日每个玩家的 token 用量（无 playerId 的记录算 host），按 total 降序，保证包含 host。
// total 只算默认网关，adult 是成人模式（单独记账）。纯函数，供 /api/usage/today 的 host 专属 players 字段使用。
function summarizePlayers(rows, now) {
  const day = dayKey(now);
  const map = new Map();
  map.set('host', { total: 0, adult: 0 });
  for (const r of rows) {
    if (!r || typeof r !== 'object' || dayKey(r.ts) !== day) continue;
    const id = rowPlayerId(r);
    const n = (Number(r.prompt_tokens) || 0) + (Number(r.completion_tokens) || 0);
    const cur = map.get(id) || { total: 0, adult: 0 };
    if (rowRoute(r) === adultMode.ROUTE) cur.adult += n;
    else cur.total += n;
    map.set(id, cur);
  }
  return Array.from(map, ([id, v]) => ({ id, total: v.total, adult: v.adult }))
    .sort((a, b) => (b.total + b.adult) - (a.total + a.adult) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// 成人模式的 token 账本（纯函数）：今日 + 累计；传 playerId 只算该玩家。limit 由调用方按全局 / 每人选好传入。
function summarizeAdult(rows, now, limit, playerId) {
  const day = dayKey(now);
  const t = sumUsage(rows, day, playerId, adultMode.ROUTE);
  const all = sumUsage(rows, null, playerId, adultMode.ROUTE);
  const lim = Number(limit) || 0;
  return {
    date: day,
    tokens: {
      prompt: t.prompt_tokens, completion: t.completion_tokens, total: t.total,
      limit: lim, remaining: lim > 0 ? Math.max(0, lim - t.total) : null,
    },
    cumulative: { prompt: all.prompt_tokens, completion: all.completion_tokens, total: all.total },
  };
}

function createClient(cfg, dataDir) {
  const mock = !!cfg.LLM_MOCK;
  const timeout = cfg.LLM_TIMEOUT_MS > 0 ? cfg.LLM_TIMEOUT_MS : 90000;
  const dailyLimit = Number(cfg.LLM_DAILY_TOKEN_LIMIT) || 0;
  const playerDailyLimit = Number(cfg.LLM_PLAYER_DAILY_TOKEN_LIMIT) || 0;
  const adultDailyLimit = Number(cfg.ADULT_LLM_DAILY_TOKEN_LIMIT) || 0;
  const adultPlayerDailyLimit = Number(cfg.ADULT_LLM_PLAYER_DAILY_TOKEN_LIMIT) || 0;
  // 两个网关：默认（朋友的网关）和成人模式（Experiential）。Key 只进请求头，绝不进日志或用量记录。
  const gateways = {
    default: {
      route: 'default',
      base: String(cfg.LLM_BASE || '').replace(/\/+$/, ''),
      apiKey: String(cfg.LLM_API_KEY || ''),
      extraBody: parseExtraBody(cfg.LLM_EXTRA_BODY),
      missing: '未配置 LLM_BASE，无法调用真实模型',
    },
    adult: {
      route: adultMode.ROUTE,
      base: String(cfg.ADULT_LLM_BASE || '').replace(/\/+$/, ''),
      apiKey: String(cfg.EXPLABS_API_KEY || '').trim(),
      extraBody: parseExtraBody(cfg.ADULT_LLM_EXTRA_BODY),
      model: String(cfg.ADULT_LLM_MODEL || '').trim() || 'deepseek-v4.1-flash-uncensored',
      missing: '成人模式还没配置好：服务器缺少 EXPLABS_API_KEY（在 Experiential 后台 Settings → API Keys 创建后写进 .env）',
    },
  };

  // opts.route 显式给出（含 null）时以它为准，否则看请求上下文；只认 'adult'，其余都走默认网关。
  function routeFor(o) {
    const r = Object.prototype.hasOwnProperty.call(o, 'route') ? o.route : context.currentLlmRoute();
    return r === adultMode.ROUTE ? adultMode.ROUTE : 'default';
  }

  function rows() {
    return store.readJsonl(store.usagePath(dataDir));
  }

  function todayTokens(now, route) {
    return sumUsage(rows(), dayKey(now), null, route || 'default').total;
  }

  // 某玩家今天的 token 用量（无 playerId 的老记录算 host）。
  function playerTodayTokens(now, playerId, route) {
    return sumUsage(rows(), dayKey(now), playerId, route || 'default').total;
  }

  // 成人模式单独一套上限，和默认网关互不占用。
  function assertAdultLimit(now) {
    if (adultDailyLimit > 0 && todayTokens(now, adultMode.ROUTE) >= adultDailyLimit) {
      const err = new Error(`成人模式今日 token 用量已达上限 ${adultDailyLimit}，明天再来吧`);
      err.status = 429;
      err.expose = true;
      throw err;
    }
    const playerId = context.currentPlayerId();
    if (adultPlayerDailyLimit > 0 && playerId && playerId !== 'host'
      && playerTodayTokens(now, playerId, adultMode.ROUTE) >= adultPlayerDailyLimit) {
      const err = new Error(`你今天的成人模式 token 用量已达上限 ${adultPlayerDailyLimit}，明天再来吧`);
      err.status = 429;
      err.expose = true;
      throw err;
    }
  }

  function assertLimit(now, route) {
    if (route === adultMode.ROUTE) return assertAdultLimit(now);
    // 全局上限：逻辑保持不变。
    if (dailyLimit > 0 && todayTokens(now) >= dailyLimit) {
      const err = new Error(`今日 token 用量已达上限 ${dailyLimit}，拒绝调用 LLM`);
      err.status = 429;
      err.expose = true;
      throw err;
    }
    // 每人每日上限：只拦当前来客，别人不受影响（主人只受全局上限约束；无玩家身份时不启用）。
    const playerId = context.currentPlayerId();
    if (playerDailyLimit > 0 && playerId && playerId !== 'host' && playerTodayTokens(now, playerId) >= playerDailyLimit) {
      const err = new Error(`你今天的 token 用量已达上限 ${playerDailyLimit}，明天再来吧`);
      err.status = 429;
      err.expose = true;
      throw err;
    }
  }

  function appendUsage(rec, route) {
    // 成人模式记录带 route:'adult'（单独记账）；默认网关的记录形状保持不变。
    store.appendUsage(dataDir, route === adultMode.ROUTE ? Object.assign({}, rec, { route }) : rec);
  }

  function missingGateway(gw) {
    const err = new Error(gw.missing);
    err.status = gw.route === adultMode.ROUTE ? 503 : 500;
    err.expose = true;
    return err;
  }

  function fakeTokens(messages, content) {
    let chars = 0;
    for (const m of Array.isArray(messages) ? messages : []) {
      chars += String((m && m.content) || '').length;
    }
    return {
      prompt_tokens: Math.max(1, Math.ceil(chars / 3)),
      completion_tokens: Math.max(1, Math.ceil(String(content).length / 3)),
    };
  }

  async function httpChat(gw, model, messages, responseFormat, requestOptions) {
    const ro = requestOptions || {};
    const requestTimeout = Number.isSafeInteger(ro.timeoutMs) && ro.timeoutMs > 0 ? Math.min(timeout, ro.timeoutMs) : timeout;
    const { base, apiKey } = gw;
    if (!base || (gw.route === adultMode.ROUTE && !apiKey)) throw missingGateway(gw);
    // extraBody 的键合并进请求体；model/messages/response_format 由本层决定，不被外部覆盖。
    const merged = mergeExtraBody(gw.extraBody, ro.extraBody);
    const payload = Object.assign(gw.route === adultMode.ROUTE ? adaptAdultBody(merged) : merged, {
      model,
      messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }],
      response_format: { type: responseFormat === false ? 'text' : 'json_object' },
    });
    if (Number.isSafeInteger(ro.maxTokens) && ro.maxTokens > 0) payload.max_tokens = ro.maxTokens;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    let resp;
    try {
      resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        clearTimeout(timer);
        const e = new Error(`LLM 调用超时（${requestTimeout} ms）`);
        e.status = 504;
        e.expose = true;
        throw e;
      }
      clearTimeout(timer);
      const e = new Error(`LLM 网络请求失败：${err && err.message ? err.message : err}`);
      e.status = 502;
      e.expose = true;
      throw e;
    }
    if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch (_) { /* 忽略读取错误 */ }
      clearTimeout(timer);
      const e = new Error(`LLM 接口返回 ${resp.status}：${clip(text, 200)}`);
      e.status = 502;
      e.expose = true;
      throw e;
    }
    let data;
    try { data = await resp.json(); } catch (_) {
      clearTimeout(timer);
      const e = new Error('LLM 返回不是合法 JSON');
      e.status = 502;
      e.expose = true;
      throw e;
    }
    clearTimeout(timer);
    const content =
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') {
      const e = new Error('LLM 返回缺少 choices[0].message.content');
      e.status = 502;
      e.expose = true;
      throw e;
    }
    const u = (data && data.usage) || {};
    return {
      content,
      usage: {
        prompt_tokens: Number(u.prompt_tokens) || 0,
        completion_tokens: Number(u.completion_tokens) || 0,
      },
    };
  }

  // 流式版 httpChat：请求带 stream:true，逐条读取 SSE 的 data: 行，累积 content，
  // 并把每个 content 片段喂给叙事解码器（每有解码出的新文本回调 onDelta）。
  // 返回 { content, usage }，content 为拼接后的完整文本，交由上层照常解析/校验/落库。
  // ro（可选）：{ extraBody, plainText, onThinking }。plainText 时不走叙事解码器，正文片段原样回调；
  // onThinking(累计思考字数) 在流里出现 reasoning_content 时回调（首次立即，之后最多每 800ms 一次），
  // 思考内容本身不返回、不记录（可能含作者大纲，绝不能给玩家看）。
  async function httpChatStream(gw, model, messages, responseFormat, onDelta, ro) {
    const sro = ro || {};
    const { base, apiKey } = gw;
    if (!base || (gw.route === adultMode.ROUTE && !apiKey)) throw missingGateway(gw);
    const merged = mergeExtraBody(gw.extraBody, sro.extraBody);
    const payload = Object.assign(gw.route === adultMode.ROUTE ? adaptAdultBody(merged) : merged, {
      model,
      messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }],
      response_format: { type: responseFormat === false ? 'text' : 'json_object' },
      stream: true,
      stream_options: { include_usage: true },
    });
    const headers = { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let resp;
    try {
      resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        const e = new Error(`LLM 流式调用超时（${timeout} ms）`);
        e.status = 504;
        e.expose = true;
        throw e;
      }
      const e = new Error(`LLM 网络请求失败：${err && err.message ? err.message : err}`);
      e.status = 502;
      e.expose = true;
      throw e;
    }
    clearTimeout(timer);
    if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch (_) { /* 忽略读取错误 */ }
      const e = new Error(`LLM 接口返回 ${resp.status}：${clip(text, 200)}`);
      e.status = 502;
      e.expose = true;
      throw e;
    }
    const decoder = sro.plainText
      ? { push(t) { if (typeof onDelta === 'function') onDelta(t); } }
      : createNarrationDecoder(onDelta);
    let fullContent = '';
    let prompt_tokens = 0;
    let completion_tokens = 0;
    let thinkChars = 0;
    let thinkAt = 0;
    let progressAt = 0;
    // idleTimeoutMs（可选，建世界用）：连接上之后这么久一个字节都没收到，就当流停住了，中止并报 504。
    // 不传时和原来一样（回合流式有前端看门狗兜底）。
    const idleMs = Number.isSafeInteger(sro.idleTimeoutMs) && sro.idleTimeoutMs > 0 ? sro.idleTimeoutMs : 0;
    let idleTimer = null;
    let stalled = false;
    const kick = () => {
      if (!idleMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { stalled = true; controller.abort(); }, idleMs);
    };
    kick();
    try {
      await readSSE(resp.body, (dataLine) => {
        kick();
        if (!dataLine || dataLine === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(dataLine); } catch (_) { return; }
        // 部分实现把用量放在最后一个 chunk（需 stream_options.include_usage，这里被动接收）。
        if (chunk && chunk.usage) {
          prompt_tokens = Number(chunk.usage.prompt_tokens) || prompt_tokens;
          completion_tokens = Number(chunk.usage.completion_tokens) || completion_tokens;
        }
        const choices = chunk && chunk.choices;
        const d = choices && choices[0] && choices[0].delta;
        // DeepSeek 原生叫 reasoning_content；OpenRouter 风格的网关叫 reasoning。
        const reasoning = d && (typeof d.reasoning_content === 'string' ? d.reasoning_content : d.reasoning);
        if (typeof reasoning === 'string' && reasoning) {
          const first = thinkChars === 0;
          thinkChars += reasoning.length;
          const nowMs = Date.now();
          if (typeof sro.onThinking === 'function' && (first || nowMs - thinkAt >= 800)) {
            thinkAt = nowMs;
            try { sro.onThinking(thinkChars); } catch (_) { /* 回调出错不影响读流 */ }
          }
        }
        const delta = d && d.content;
        if (typeof delta === 'string' && delta) {
          fullContent += delta;
          decoder.push(delta);
        }
        // onProgress({chars, think})：已写字数 / 已思考字数（建世界进度条用），最多每 500ms 一次。
        if (typeof sro.onProgress === 'function' && (delta || reasoning)) {
          const nowMs = Date.now();
          if (nowMs - progressAt >= 500) {
            progressAt = nowMs;
            try { sro.onProgress({ chars: fullContent.length, think: thinkChars }); } catch (_) { /* 忽略 */ }
          }
        }
      });
    } catch (err) {
      if (stalled) {
        const e = new Error(`LLM 流式输出停住了（${idleMs} ms 没有新内容）`);
        e.status = 504;
        e.expose = true;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(idleTimer);
    }
    if (typeof sro.onProgress === 'function') {
      try { sro.onProgress({ chars: fullContent.length, think: thinkChars }); } catch (_) { /* 忽略 */ }
    }
    // 用量缺失时按文本估算，保证 events.jsonl 的 usage 聚合不为 0。
    if (prompt_tokens === 0 && completion_tokens === 0) {
      const est = fakeTokens(messages, fullContent);
      prompt_tokens = est.prompt_tokens;
      completion_tokens = est.completion_tokens;
    }
    return {
      content: fullContent,
      usage: { prompt_tokens, completion_tokens },
    };
  }

  // 返回 { content, model, usage:{prompt_tokens,completion_tokens}, ms, ok }
  // 本次调用走哪个网关、用哪个模型、发哪些消息。成人模式：所有用途都用 ADULT_LLM_MODEL，
  // 并在第一条 system 末尾追加成人模式规则（出图翻译等传 adultPolicy:false 的调用不追加）。
  // 写正文（purpose=story）那一次调用再叠上玩家在菜单里选的思考强度 / 发挥（prefs.adultLlm）。
  function prepare(o) {
    const route = routeFor(o);
    const gw = gateways[route];
    const model = route === adultMode.ROUTE ? gw.model : (o.model || cfg.LLM_MODEL);
    const raw = o.messages || [];
    const messages = route === adultMode.ROUTE && o.adultPolicy !== false ? adultMode.withPolicy(raw) : raw;
    let opts = o;
    if (route === adultMode.ROUTE && o.purpose === PURPOSES.STORY) {
      let settings = null;
      try { settings = prefs.getPrefs(dataDir, context.currentPlayerId() || 'host').adultLlm; } catch (_) { settings = null; }
      opts = Object.assign({}, o, { extraBody: mergeExtraBody(o.extraBody, adultMode.storyParams(settings)) });
    }
    return { route, gw, model, messages, opts };
  }

  async function complete(opts) {
    const o = opts || {};
    const now = Date.now();
    const { route, gw, model, messages, opts: ro } = prepare(o);
    assertLimit(now, route);
    const purpose = o.purpose || PURPOSES.TURN;

    if (mock) {
      const content = JSON.stringify(mockFor(purpose, o.mock));
      const usage = fakeTokens(messages, content);
      appendUsage({
        ts: now, model, purpose,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        ms: 1, ok: true,
      }, route);
      return { content, model, usage, ms: 1, ok: true };
    }

    const t0 = Date.now();
    try {
      const r = await httpChat(gw, model, messages, o.responseFormat, ro);
      const ms = Date.now() - t0;
      appendUsage({
        ts: now, model, purpose,
        prompt_tokens: r.usage.prompt_tokens,
        completion_tokens: r.usage.completion_tokens,
        ms, ok: true,
      }, route);
      return { content: r.content, model, usage: r.usage, ms, ok: true };
    } catch (err) {
      const ms = Date.now() - t0;
      appendUsage({ ts: now, model, purpose, prompt_tokens: 0, completion_tokens: 0, ms, ok: false }, route);
      throw err;
    }
  }

  // 流式版 complete：参数与 complete 一致，额外接收 onDelta(新叙事文本)。
  // 返回 { content, model, usage, ms, ok }，content 为流结束后的完整文本；
  // 上层拿到 content 后的解析/校验/落库流程与非流式完全一致。
  async function completeStream(opts, onDelta) {
    const o = opts || {};
    const now = Date.now();
    const { route, gw, model, messages, opts: ro } = prepare(o);
    assertLimit(now, route);
    const purpose = o.purpose || PURPOSES.TURN;

    if (mock) {
      const mocked = mockFor(purpose, o.mock);
      let content = JSON.stringify(mocked);
      let narration = '';
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed.narration === 'string') narration = parsed.narration;
      } catch (_) { /* 无 narration 字段时不回调 */ }
      // 纯文本模式：mock 的 narration 就是全部正文（没有 narration 字段时用整个 JSON 串）。
      if (o.plainText) {
        content = narration || content;
        narration = content;
      }
      if (typeof o.onThinking === 'function') {
        try { o.onThinking(1); } catch (_) { /* 忽略 */ }
      }
      // 建世界进度：分 8 步报告已写字数；LLM_MOCK_DELAY_MS 给界面检查放慢（默认不等）。
      if (typeof o.onProgress === 'function') {
        const delay = Number(process.env.LLM_MOCK_DELAY_MS) || 0;
        for (let k = 1; k <= 8; k++) {
          if (delay) await new Promise((r) => setTimeout(r, delay / 8));
          try { o.onProgress({ chars: Math.round(content.length * k / 8), think: 0 }); } catch (_) { /* 忽略 */ }
        }
      }
      // 把假叙事切成小块，每块间隔约 30ms 回调，模拟流式。
      const size = 6;
      for (let i = 0; i < narration.length; i += size) {
        await new Promise((r) => setTimeout(r, 30));
        if (typeof onDelta === 'function') onDelta(narration.slice(i, i + size));
      }
      const ms = Date.now() - now;
      const usage = fakeTokens(messages, content);
      appendUsage({
        ts: now, model, purpose,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        ms, ok: true,
      }, route);
      return { content, model, usage, ms, ok: true };
    }

    const t0 = Date.now();
    try {
      const r = await httpChatStream(gw, model, messages, o.plainText ? false : o.responseFormat, onDelta, ro);
      const ms = Date.now() - t0;
      appendUsage({
        ts: now, model, purpose,
        prompt_tokens: r.usage.prompt_tokens,
        completion_tokens: r.usage.completion_tokens,
        ms, ok: true,
      }, route);
      return { content: r.content, model, usage: r.usage, ms, ok: true };
    } catch (err) {
      const ms = Date.now() - t0;
      appendUsage({ ts: now, model, purpose, prompt_tokens: 0, completion_tokens: 0, ms, ok: false }, route);
      throw err;
    }
  }

  // GET /api/usage：today / cumulative 只算默认网关，成人模式单列在 adult 里。
  function summarizeUsage(now) {
    const ts = now == null ? Date.now() : now;
    const all = rows();
    return {
      date: dayKey(ts),
      today: sumUsage(all, dayKey(ts), null, 'default'),
      cumulative: sumUsage(all, null, null, 'default'),
      limit: dailyLimit,
      adult: {
        today: sumUsage(all, dayKey(ts), null, adultMode.ROUTE),
        cumulative: sumUsage(all, null, null, adultMode.ROUTE),
        limit: adultDailyLimit,
      },
    };
  }

  // playerId 为空：保持原行为（全局今日、全局上限）。
  // 传了 playerId：只统计该玩家，tokens.limit/remaining 用每人上限。
  function usageToday(now, playerId) {
    const lim = playerId ? playerDailyLimit : dailyLimit;
    return summarizeToday(rows(), now == null ? Date.now() : now, lim, playerId);
  }

  // 成人模式账本：不传 playerId = 全局（全局上限），传了 = 该玩家（每人上限）。
  function adultUsageToday(now, playerId) {
    const lim = playerId ? adultPlayerDailyLimit : adultDailyLimit;
    const out = summarizeAdult(rows(), now == null ? Date.now() : now, lim, playerId);
    out.model = gateways.adult.model;
    return out;
  }

  return { complete, completeStream, summarizeUsage, usageToday, adultUsageToday, mock, PURPOSES };
}

module.exports = {
  createClient, PURPOSES, parseExtraBody, summarizeToday, summarizePlayers, summarizeAdult, cloudflareNeuronsToday,
  createNarrationDecoder, decodeNarration, readSSE, adaptAdultBody,
};
