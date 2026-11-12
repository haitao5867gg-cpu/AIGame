'use strict';

// 第 3 / 4 / 5 节编排层：建世界、执行回合、重生、编年史压缩、顶点检测与刷新。
// 只做「组装 prompt → llm → 解析 → engine → 存储」，规则与数值全部交给 engine.js。
// 所有写操作经 store.withWorldLock 串行，保证同一世界不会并发推进回合。

const crypto = require('node:crypto');
const store = require('./store.js');
const engine = require('./engine.js');
const eventLog = require('./event-log.js');
const npcExtraction = require('./npc-extraction.js');
const llm = require('./llm.js');
const prompts = require('./prompts.js');
const prefs = require('./prefs.js');
const context = require('./context.js');
const genres = require('./genres.js');
const profiles = require('./profiles.js');
const outlineMod = require('./outline.js');
const historyMod = require('./history.js');
const writingMode = require('./writing-mode.js');

// 正在后台总结画像的玩家（key = dataDir + playerId，避免多个 createGame 实例互相误判）。
// 后台总结在 takeTurn 里「不 await」发起，靠 finally 从这里移除，防止同一玩家重复触发。
const summarizingProfiles = new Set();

// 带状态码的可暴露错误；server.js 统一转成 {error:"中文说明"}。
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.expose = true;
  }
}
function httpError(status, message) {
  return new HttpError(status, message);
}

// 墓志铭模板兜底：LLM 失败 / 输出缺失时使用，绝不阻塞本回合落库与重生。
function templateEpitaph(info) {
  const i = info || {};
  return (
    `第${i.life || 1}世，${i.name || '无名旅人'}走过${i.turns || 0}个回合，` +
    `终因${i.cause || '力竭'}长眠于此。名字会淡去，旧债与旧交却留在风里。`
  );
}

// 从 LLM 解析结果里取墓志铭；缺失 / 非法时用模板兜底，并截到 ≤80 字。
// 纯函数，单独导出便于单测兜底路径。
function epitaphFromParsed(parsed, info) {
  let text = parsed && typeof parsed.epitaph === 'string' ? parsed.epitaph.trim() : '';
  if (!text) text = templateEpitaph(info);
  return text.slice(0, engine.EPITAPH_MAX);
}

// 新一世开场：150~300 字。
const REBIRTH_OPENING_MIN = 150;
const REBIRTH_OPENING_MAX = 300;

// 新一世开场模板兜底：LLM 失败 / 输出过短时使用，仍覆盖「间隔 / 变化 / 有人隐约记得」四要素。
// 纯函数，绝不含 apex / Key 等内部信息，便于单测兜底路径。
function templateRebirthOpening(info) {
  const i = info || {};
  const name = i.name || '无名旅人';
  const life = i.life || 2;
  const place = i.place || '旧地';
  const title = i.title || '这片天地';
  const gap = i.gap || '许多时日';
  return (
    `距上一世已有${gap}。${title}还在，${place}的晨雾却比记忆里淡了些：` +
    '你上一世留在名册上的那笔旧账，被人抄进了新的册页，街口的盘查也因之紧了半分，' +
    '连报出真名要登记的规矩都多添了一道。' +
    `你以「${name}」之名在${place}醒来，手里攥着一件说不清来路的旧物，像是从未离开，又像头一遭落脚；` +
    '石上那行墓志铭还没被雨水冲净，只是没人肯当着你的面念出来。' +
    `第${life}世就这样开场。守夜的人抬眼时顿了顿，没叫破，只低声说了句「这身影倒是眼熟」；` +
    '也有人把话咽回去，装作从没见过。' +
    '世界没有重来，只是换了一副面孔继续往前走，而你得在这一副面孔里，重新挣一个位置。'
  );
}

// 重生开场的上下文：世界标题 / 起点、上一世墓志铭、新身份（facts / npcAttitude 由 prompt 直接读 state）。
function rebirthInfo(state) {
  const s = state || {};
  const last = (Array.isArray(s.pastLives) ? s.pastLives.slice(-1)[0] : null) || {};
  const b = s.bible || {};
  return {
    life: s.life || 2,
    prevLife: last.life || Math.max(1, (s.life || 2) - 1),
    name: (s.character && s.character.name) || '无名旅人',
    appearance: (s.character && s.character.appearance) || '',
    prevName: last.name || '无名旅人',
    epitaph: last.epitaph || '',
    cause: last.cause || '力竭',
    title: b.title || '',
    place: s.location || (b.start && b.start.place) || '',
  };
}

// 从 LLM 解析结果里取开场；失败 / 过短用模板兜底，并截到 ≤300 字。
function openingFromParsed(parsed, info) {
  let text = parsed && typeof parsed.opening === 'string' ? parsed.opening.trim() : '';
  if (text.length < REBIRTH_OPENING_MIN) text = templateRebirthOpening(info);
  return text.slice(0, REBIRTH_OPENING_MAX);
}

function newWorldId() {
  return 'w' + crypto.randomBytes(8).toString('hex');
}

// 取 [nextTurn-19, nextTurn] 的 20 回合记录用于压缩编年史。
// 当前回合的 event 还没写进 events.jsonl（appendEvent 在 resolveTurn 之后），
// 因此这里显式把当前回合补进窗口，保证第 20 回合压的是 1~20 而不是 1~19。
function chapterEventWindow(events, nextTurn, current) {
  const fromTurn = Math.max(1, nextTurn - 19);
  const window = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.turn >= fromTurn && e.turn <= nextTurn)
    .slice();
  if (current && !window.some((e) => e.turn === nextTurn)) window.push(current);
  window.sort((a, b) => a.turn - b.turn);
  return window;
}

// 把 applied（引擎消毒后的 diff）转成给前端展示的小徽章（公开数据，不含内部字段）。
// statsDrains 可选：回合结果 / 事件记录里的 stats_drains，用于生成警戒扣属性的 drain 徽章。
function badgesFromApplied(applied, statsDrains) {
  const a = applied && typeof applied === 'object' ? applied : {};
  const badges = [];
  const diff = a.state_diff && typeof a.state_diff === 'object' ? a.state_diff : {};
  for (const key of Object.keys(diff)) {
    if (!engine.ATTRS.includes(key)) continue;
    const d = Number(diff[key]);
    if (!Number.isFinite(d) || d === 0) continue;
    badges.push({ type: 'attr', name: key, delta: d });
  }
  // 世界专属状态：本回合直接造成的变化（引擎已消毒、键为已有状态名）。
  const sd = a.stats_diff && typeof a.stats_diff === 'object' ? a.stats_diff : {};
  for (const name of Object.keys(sd)) {
    const d = Number(sd[name]);
    if (!Number.isFinite(d) || d === 0) continue;
    badges.push({ type: 'stat', name, delta: d });
  }
  for (const name of Array.isArray(a.items_add) ? a.items_add : []) {
    if (typeof name === 'string' && name) badges.push({ type: 'item-add', name });
  }
  for (const name of Array.isArray(a.items_remove) ? a.items_remove : []) {
    if (typeof name === 'string' && name) badges.push({ type: 'item-remove', name });
  }
  const npc = a.npc_attitude && typeof a.npc_attitude === 'object' ? a.npc_attitude : {};
  for (const name of Object.keys(npc)) {
    const d = Number(npc[name]);
    if (!Number.isFinite(d) || d === 0) continue;
    badges.push({ type: 'npc', name, delta: d });
  }
  // 生效警戒的后果：每回合扣 1 点基础属性（name 用属性名，label 用警戒状态名）。
  for (const dr of Array.isArray(statsDrains) ? statsDrains : []) {
    if (!dr || typeof dr !== 'object') continue;
    const attr = dr.attr;
    if (typeof attr !== 'string' || !engine.ATTRS.includes(attr)) continue;
    badges.push({
      type: 'drain', name: attr, delta: -1,
      label: typeof dr.label === 'string' ? dr.label : '',
    });
  }
  return badges;
}

// 场景插图公开字段：新格式字段「有就带」，兼容老存档只有 draw/desc 的记录。
function toPublicScene(sc) {
  const out = { draw: true, desc: sc.desc };
  if (typeof sc.place === 'string') out.place = sc.place;
  if (Array.isArray(sc.cast)) out.cast = sc.cast;
  if (Array.isArray(sc.items)) out.items = sc.items;
  if (typeof sc.action === 'string') out.action = sc.action;
  return out;
}

// 时光推进公开字段：逐字段取，类型不对就不输出；无有效字段时整体不输出。
function publicTimeSkip(ts) {
  if (!ts || typeof ts !== 'object' || Array.isArray(ts)) return null;
  const out = {};
  if (typeof ts.span === 'string') out.span = ts.span;
  if (typeof ts.days === 'number' && Number.isFinite(ts.days)) out.days = ts.days;
  if (typeof ts.label === 'string') out.label = ts.label;
  if (typeof ts.plan === 'string') out.plan = ts.plan;
  return Object.keys(out).length ? out : null;
}

// events.jsonl 的单条记录 → 只保留公开字段，绝不把 apex / twist / raw / proposal / rejected / usage 带出去。
function toPublicLogRecord(rec) {
  const e = rec && typeof rec === 'object' ? rec : {};
  const ev = e.event && typeof e.event === 'object' ? e.event : null;
  const st = e.settlement && typeof e.settlement === 'object' ? e.settlement : null;
  const d = e.death && typeof e.death === 'object' ? e.death : null;
  const ts = publicTimeSkip(e.timeSkip);
  return {
    ...(ts ? { timeSkip: ts } : {}),
    ...(e.chapter && typeof e.chapter === 'object' && Number.isSafeInteger(e.chapter.index)
      ? { chapter: { index: e.chapter.index, title: typeof e.chapter.title === 'string' ? e.chapter.title : '' } }
      : {}),
    ...(e.applied && Array.isArray(e.applied.suggestions)
      ? { suggestions: e.applied.suggestions.filter((x) => typeof x === 'string').slice(0, 3) }
      : {}),
    turn: e.turn,
    life: e.life,
    action: typeof e.action === 'string' ? e.action : '',
    narration: typeof e.narration === 'string' ? e.narration : '',
    // 重生开场是独立的一条公开叙事，前端进入新一世时按开场样式回放。
    ...(e.rebirthOpening === true ? { rebirthOpening: true } : {}),
    badges: badgesFromApplied(e.applied, e.stats_drains),
    event: ev ? {
      theme: ev.theme, title: ev.title, desc: ev.desc, startedTurn: ev.startedTurn,
    } : null,
    settlement: st ? {
      theme: st.theme, title: st.title, tier: st.tier, attr: st.attr,
      score: st.score,
      effects: st.effects && typeof st.effects === 'object' ? Object.assign({}, st.effects) : {},
    } : null,
    death: d ? {
      reason: d.reason, life: d.life, inheritedReputation: d.inheritedReputation,
    } : null,
    ...(e.scene && e.scene.draw === true ? { scene: toPublicScene(e.scene) } : {}),
    voice_hints: engine.normalizeVoiceHints(e.voice_hints),
    ts: e.ts,
  };
}

// 从 events.jsonl 原始记录中挑出「可见」记录（供 /log 与导出回放）。
// 具体实现已提到 src/event-log.js 作为共享纯函数：NPC 档案回填 / 历史 / AI 资料
// 与这里复用同一份 canonical 过滤，确保撤回旧分支不能复活。game.js 保留同名导出
// 以兼容既有调用方与测试，行为与 eventLog.visibleEventRecords 完全一致。
//  - {type:'undo'} 是撤回标记，不是叙事，隐藏；标记前一条 turn === undoneTurn 的记录一并隐藏；
//  - 用「位置」而非全局回合号集合判定：撤回后再走一步会复用同一回合号，新记录仍可见。
function visibleEventRecords(events) {
  return eventLog.visibleEventRecords(events);
}

// 取被撤回回合的行动文字：最近一条 turn === undoneTurn 的回合记录，供前端填回输入框。
function lastTurnAction(events, undoneTurn) {
  const list = Array.isArray(events) ? events : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i];
    if (e && e.type !== 'undo' && e.rebirthOpening !== true && e.turn === undoneTurn) {
      return typeof e.action === 'string' ? e.action : '';
    }
  }
  return '';
}

// 老存档把 recent 每条正文固定截到 300 字，这个长度是「可能被截断、需补回」的轻量判据。
// 它是旧 RECENT_NARRATION_MAX 的历史值，已不再是当前上限；新引擎落库的是完整正文（≤1200），
// 命中 300 的概率很低，因此恢复一轮、后续回合正常落库后基本不再需要读日志。
const LEGACY_RECENT_NARRATION_MAX = 300;

// 把 state.recent 里被旧版截短的正文，从本世界「可见」事件记录补回完整长度。
// 纯函数：events 由调用方读入，不碰文件 IO、不改入参；无变化时返回原 state 引用。
//  - 只改现有 recent 条目的 narration，绝不增删条目、不改其它字段、不凭空造剧情 / 数值。
//  - 匹配签名 = turn + action + rebirthOpening：区分正常回合 / 重生开场，避免把同一回合号的
//    重生开场与上一世尾回合串文；用 visibleEventRecords 复用现有撤回语义，同回合号被撤回
//    又重写时只认「当前可见」的记录，绝不复活撤回正文。
//  - 仅当完整正文以现有（截断）正文为前缀时才替换，不匹配则沿用原记录。
//  - 结果与当前引擎边界一致：每条 ≤ RECENT_NARRATION_MAX、最多 RECENT_MAX 条（6×1200 硬上限）。
function restoreRecentNarration(state, events) {
  const s = state;
  const recent = s && Array.isArray(s.recent) ? s.recent : null;
  if (!recent || recent.length === 0) return s;

  let visible;
  try {
    // visibleEventRecords 已隐藏 undo 标记及其前一条被撤回记录；这里再过滤出有正文的记录。
    visible = visibleEventRecords(events).filter(
      (e) => e && typeof e.narration === 'string' && e.narration.length > 0,
    );
  } catch (_) {
    return s;
  }

  let changed = false;
  const next = recent.map((r) => {
    if (!r || typeof r !== 'object' || typeof r.narration !== 'string') return r;
    let narration = r.narration;
    // 仅对「看起来被截断」的条目尝试补回；已完整（或本就 ≥ 上限）的条目不动。
    if (visible.length && narration && narration.length < engine.RECENT_NARRATION_MAX) {
      const sigAction = typeof r.action === 'string' ? r.action : '';
      const sigOpening = r.rebirthOpening === true;
      let match = null;
      for (const e of visible) {
        if (e.turn !== r.turn) continue;
        if ((typeof e.action === 'string' ? e.action : '') !== sigAction) continue;
        if ((e.rebirthOpening === true) !== sigOpening) continue;
        match = e; // 取最后一条可见匹配 = 当前版本（撤回重写后即新版本）
      }
      if (match && match.narration.length > narration.length
          && match.narration.startsWith(narration)) {
        narration = match.narration;
      }
    }
    const capped = narration.slice(0, engine.RECENT_NARRATION_MAX);
    if (capped === r.narration) return r;
    changed = true;
    return Object.assign({}, r, { narration: capped });
  });

  // 最多保留最近 RECENT_MAX 条（只裁掉超出的最旧条目，不新增）。
  const cappedRecent = next.length > engine.RECENT_MAX ? next.slice(-engine.RECENT_MAX) : next;
  if (cappedRecent !== next) changed = true;
  if (!changed) return s;
  return Object.assign({}, s, { recent: cappedRecent });
}

// 编排层：只在「执行一回合、拼提示词前」做一次轻量恢复；普通读（getWorld / log / export）
// 不经过这里，不会为了恢复去扫整个世界日志。缺日志 / 读失败 / 无匹配都退回原 state，
// 绝不写回磁盘（完整 recent 会在本回合正常落库时自然沿用）。
function maybeRestoreRecent(dataDir, worldId, state) {
  try {
    const recent = state && Array.isArray(state.recent) ? state.recent : [];
    const needs = recent.some(
      (r) => r && typeof r.narration === 'string'
        && r.narration.length === LEGACY_RECENT_NARRATION_MAX,
    );
    if (!needs) return state;
    const events = store.readEvents(dataDir, worldId);
    return restoreRecentNarration(state, events);
  } catch (_) {
    return state; // 恢复失败绝不破坏现有读存档 / 回合流程
  }
}

// 旧存档 NPC 档案「只读回填」缓存：key = dataDir + worldId，value = { revision, hydrated }。
// 缓存的是 hydrateNpcMemory(state, events) 的结果，只在内存里给读路径用，绝不写回磁盘；
// 命中时返回副本，避免 ensureGenre / setGenre 等调用方改动共享对象。
// revision 取 store.worldRevision（state/events 的 mtime+size，外加 inode 兜底），
// 撤回 / 重走同 turn 改变文件字节即失效，不依赖 world.turn，绝不复活旧分支记忆。
const npcHydrationCache = new Map();

// 回填缓存有界 LRU：全局 Map 会随访问过的世界数无限增长，给一个合理上限；
// 命中 / 写入都把项移到「最近使用」末尾，超限淘汰最久未用的首项。纯内存，
// 不新增持久文件 / 依赖，也不改真实存档；删除 / 不存在世界另见 loadState / deleteWorld 清理。
const NPC_HYDRATION_CACHE_MAX = 64;

function rememberHydration(cacheKey, value) {
  if (npcHydrationCache.has(cacheKey)) npcHydrationCache.delete(cacheKey);
  npcHydrationCache.set(cacheKey, value);
  while (npcHydrationCache.size > NPC_HYDRATION_CACHE_MAX) {
    npcHydrationCache.delete(npcHydrationCache.keys().next().value);
  }
}

function npcHydrationCacheSize() {
  return npcHydrationCache.size;
}

function cloneForRead(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function createGame(cfg, dataDir) {
  const client = llm.createClient(cfg, dataDir);
  const turnModel = cfg.LLM_MODEL;
  const worldModel = cfg.LLM_MODEL_WORLD;

  // 记录每次 LLM 调用的用量，供 events.jsonl 的 usage 字段聚合。
  async function call(purpose, model, messages, mockCtx, usages, extra) {
    const res = await client.complete(Object.assign({}, extra || {}, {
      purpose,
      model,
      messages,
      responseFormat: 'json_object',
      mock: mockCtx,
    }));
    if (usages) usages.push(res.usage);
    return res;
  }

  // 流式调用：逐段回调 onDelta，返回与 complete 相同形状的结果。
  async function callStream(purpose, model, messages, mockCtx, usages, onDelta) {
    const res = await client.completeStream({
      purpose,
      model,
      messages,
      responseFormat: 'json_object',
      mock: mockCtx,
    }, onDelta);
    if (usages) usages.push(res.usage);
    return res;
  }

  // 调用 + 解析；解析失败重试 1 次，再失败则报错且不推进回合。
  async function callParsed(purpose, model, messages, mockCtx, usages, extra) {
    let lastContent = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call(purpose, model, messages, mockCtx, usages, extra);
      lastContent = res.content;
      const parsed = prompts.parseJson(res.content);
      if (parsed) return { parsed, content: res.content };
    }
    throw httpError(502, '模型输出无法解析为 JSON，本回合未推进，请稍后重试');
  }

  // 后台画像总结：据最近亲手写的行动归纳「你是什么样的玩家」。
  // 全程 try/catch 静默失败，画像出错绝不影响回合；调用方不 await。
  async function summarizeProfile(playerId) {
    try {
      const profile = profiles.getProfile(dataDir, playerId);
      const pp = await callParsed('profile', turnModel,
        prompts.buildProfileMessages(profile), { turns: profile.turns }, []);
      const parsed = pp.parsed || {};
      profiles.applySummary(dataDir, playerId, {
        summary: parsed.summary,
        traits: parsed.traits,
        wants: parsed.wants,
      }, Date.now());
    } catch (_) {
      // 总结失败静默：绝不因为总结影响回合。
    }
  }

  // 距上次总结 >= 15 回合且无进行中的总结时，后台发起一次。
  // 不 await：直接在请求处理的异步链里发起即可继承 AsyncLocalStorage（用量记到该玩家头上）。
  function maybeSummarizeProfile(playerId, profile) {
    if (profile.turns - profile.summaryTurn < 15) return;
    const key = `${dataDir}\u0000${playerId}`;
    if (summarizingProfiles.has(key)) return;
    summarizingProfiles.add(key);
    summarizeProfile(playerId)
      .catch(() => {})
      .finally(() => summarizingProfiles.delete(key));
  }

  // 主回合调用（可流式）：首尝试走流式并逐段回调 onDelta；
  // 解析失败时的重试一律走非流式（不再回调 delta）。拿到 content 之后的
  // 解析 / 校验 / 落库流程与非流式完全一致。
  async function callTurnParsed(purpose, model, messages, mockCtx, usages, onDelta) {
    if (typeof onDelta === 'function') {
      const res = await callStream(purpose, model, messages, mockCtx, usages, onDelta);
      const parsed = prompts.parseJson(res.content);
      if (parsed) return { parsed, content: res.content };
      // 流式输出无法解析 → 非流式重试一次。
      const retry = await call(purpose, model, messages, mockCtx, usages);
      const parsed2 = prompts.parseJson(retry.content);
      if (parsed2) return { parsed: parsed2, content: retry.content };
      throw httpError(502, '模型输出无法解析为 JSON，本回合未推进，请稍后重试');
    }
    return callParsed(purpose, model, messages, mockCtx, usages);
  }

  // 死亡时额外调用一次回合模型，据本世经历写墓志铭；
  // 任何失败（网络 / 超时 / 额度 / 解析）都回退模板，不影响回合落库与后续重生。
  async function composeEpitaph(state, death, deathTurn, usages) {
    const dead = (state && state.character) || {};
    const info = {
      life: death.life,
      name: dead.name || '无名旅人',
      turns: deathTurn - (dead.bornTurn == null ? 0 : dead.bornTurn),
      cause: death.reason,
    };
    let parsed = null;
    try {
      const ep = await callParsed(
        'epitaph', turnModel,
        prompts.buildEpitaphMessages(state, info),
        { life: info.life, name: info.name, cause: info.cause }, usages,
      );
      parsed = ep.parsed;
    } catch (_) { /* 失败时 parsed 保持 null，交给模板兜底 */ }
    return {
      life: info.life,
      name: info.name,
      epitaph: epitaphFromParsed(parsed, info),
      turns: info.turns,
      cause: info.cause,
    };
  }

  // 重生时额外调用一次回合模型，据世界设定 / 上一世墓志铭 / facts / npcAttitude 写「新一世开场」。
  // 任何失败（网络 / 超时 / 额度 / 解析 / 输出过短）都回退模板，绝不阻断重生落库。
  async function composeRebirthOpening(state, usages) {
    const info = rebirthInfo(state);
    let parsed = null;
    try {
      const rp = await callParsed(
        'rebirth', turnModel,
        prompts.buildRebirthOpeningMessages(state, info),
        { life: info.life, name: info.name }, usages,
      );
      parsed = rp.parsed;
    } catch (_) { /* 失败时 parsed 保持 null，交给模板兜底 */ }
    return openingFromParsed(parsed, info);
  }

  function publicWorld(state) {
    return engine.toPublicState(state);
  }

  // 当前是否可撤回：存在 .prev 快照、非死亡待重生、且备份与当前处于同一世（未跨越重生）。
  function undoAvailableFor(state, worldId) {
    if (!store.hasUndoBackup(dataDir, worldId)) return false;
    if (state.awaitingRebirth || (state.character && state.character.alive === false)) return false;
    const prev = store.readUndoBackup(dataDir, worldId);
    if (prev && Number(prev.life) !== Number(state.life)) return false;
    return true;
  }

  // 把 undoAvailable 附加到公开状态上，供前端显隐「撤回这一步」按钮。
  function withUndoFlag(publicState, state, worldId) {
    publicState.undoAvailable = undoAvailableFor(state, worldId);
    return publicState;
  }

  // 读取世界状态；老存档缺少新玩法字段时自动补默认值，不报错。
  // 旧格式 NPC 档案：从 canonical 可见 events 只读回填，缓存按 state/events 文件 revision
  // （不是 world.turn）判失效，避免图片轮询 / 人物详情反复全量扫描，且 undo / 重走同 turn
  // 不会串回旧分支记忆。回填只在内存、不写 state 文件、不调 LLM；缺日志 / 旧字段继续玩、
  // 不造历史；新格式（npcMemoryVersion 已达标）正常回合保存后不再扫描全史。
  function loadState(worldId) {
    const cacheKey = `${dataDir}\u0000${worldId}`;
    const raw = store.loadWorld(dataDir, worldId);
    if (!raw) {
      // 世界已删除 / 不存在：清掉可能残留的旧档回填缓存，不让失效世界占着有界缓存。
      npcHydrationCache.delete(cacheKey);
      return null;
    }
    const state = engine.normalizeState(raw);
    if (!engine.needsNpcHydration(state)) {
      npcHydrationCache.delete(cacheKey);
      return state;
    }
    let revision;
    try {
      revision = store.worldRevision(dataDir, worldId);
    } catch (_) {
      revision = null;
    }
    const cached = npcHydrationCache.get(cacheKey);
    if (cached && revision !== null && cached.revision === revision) {
      rememberHydration(cacheKey, cached); // 命中：维持 LRU 顺序，不重复全史扫描
      return cloneForRead(cached.hydrated); // 命中返回深拷贝，调用方改动不污染缓存
    }
    let events = [];
    try {
      events = store.readEvents(dataDir, worldId);
    } catch (_) {
      // 缺日志 / 读失败：用空事件回填（仅保留 bible / attitude 基线），继续玩、不造历史。
      events = [];
    }
    // hydrateNpcMemory 内部复用共享 canonical 过滤（visibleEventEntries），撤回分支被排除。
    const hydrated = engine.hydrateNpcMemory(state, events);
    rememberHydration(cacheKey, { revision, hydrated });
    return cloneForRead(hydrated);
  }

  // ---- 建世界 ----
  async function buildWorld(input) {
    const data = input || {};
    const seed = typeof data.seed === 'string' ? data.seed.trim() : '';
    if (!seed) throw httpError(400, '请用一句话描述世界观（seed 不能为空）');
    const name = (typeof data.name === 'string' && data.name.trim()) || '无名旅人';
    const appearance = (typeof data.appearance === 'string' && data.appearance.trim()) || '一袭布衣';
    const id = newWorldId();

    return store.withWorldLock(id, async () => {
      const usages = [];
      const wp = await callParsed(
        'world', worldModel,
        prompts.buildWorldMessages(seed, { name, appearance }),
        { seed, name, appearance }, usages,
      );
      const bible = wp.parsed.bible;
      const apex = wp.parsed.apex;
      if (!bible || typeof bible !== 'object' || !apex || typeof apex !== 'object') {
        throw httpError(502, '建世界模型输出缺少 bible 或 apex，请重试');
      }
      // 题材：玩家手选（body.genre 非 'auto'）优先于模型判断；最终由 engine.createWorld 归一。
      const picked = typeof data.genre === 'string' ? data.genre : '';
      const rawGenre = (picked && picked !== 'auto') ? picked : wp.parsed.genre;
      let state;
      try {
        state = engine.createWorld(
          { id, seed, name, appearance, bible, apex, alloc: data.alloc, genre: rawGenre },
          { rng: Math.random, now: Date.now() },
        );
      } catch (err) {
        throw httpError(400, err && err.message ? err.message : '属性点分配非法');
      }
      // 新世界继承玩家画像：画像已成熟（turns≥10）时用 seedPersona 覆盖初始 persona。
      // 只改新世界的初始 persona，不动引擎；读取失败一律忽略，绝不影响建世界。
      try {
        const seedPersona = profiles.seedPersona(
          profiles.getProfile(dataDir, context.currentPlayerId() || 'host'),
        );
        if (seedPersona) state.persona = seedPersona;
      } catch (_) { /* 画像读取失败不影响建世界 */ }
      // 叙事 v3：建世界时顺带生成作者自用的隐藏大纲；失败不阻断建世界，第一回合再补。
      if (cfg.NARRATIVE_STYLE === 'v3') {
        await ensureOutlineOnState(state, [], usages);
      }
      store.saveWorld(dataDir, state);
      return publicWorld(state);
    });
  }

  // 叙事 v3：确保 state 上有合法的隐藏大纲（调用方须已持有该世界的锁，这里不再加锁）。
  // 新世界：按设定规划；老世界：带上已发生的故事，从眼下接着规划，第 1 章就是正在进行的这一章。
  // 成功写回 state.outline 和 state.chapter；任何失败都不抛错，返回 false，下一回合再试。
  async function ensureOutlineOnState(state, events, usages) {
    try {
      const existing = outlineMod.normalizeOutline(state.outline);
      if (existing) {
        if (!state.chapter || !Number.isSafeInteger(state.chapter.index)) {
          state.chapter = outlineMod.freshChapter((state.turn || 0) + 1);
        }
        return true;
      }
      const isNew = !(state.turn > 0);
      const history = isNew ? null : historyMod.buildStoryHistory(events, state, {
        budget: cfg.STORY_HISTORY_BUDGET,
      });
      // 大纲用写正文的强模型、低强度思考（深度思考要等好几分钟，建世界等不起）。
      const wc = writingMode.writingCall(cfg, 'fine');
      const op = await callParsed(
        'outline', wc.model,
        prompts.buildOutlineMessages(state, { history }),
        { title: state.bible && state.bible.title }, usages || [], { extraBody: wc.extraBody },
      );
      const outline = outlineMod.normalizeOutline(op.parsed);
      if (!outline) return false;
      state.outline = outline;
      state.chapter = outlineMod.freshChapter((state.turn || 0) + 1);
      return true;
    } catch (_) {
      return false;
    }
  }

  // ---- 读 ----
  // 已排队后台补判题材的世界，避免重复触发（ensureGenre 完成后自动移除）。
  const pendingGenre = new Set();

  // 老世界补题材：世界锁内读状态，已有合法 genre 直接返回；
  // 否则用一次很短的 LLM 调用（只给 bible.title / tone / rules 前 3 条）判断并保存，
  // 失败按 general 保存；任何异常都不抛错影响游戏。
  async function ensureGenre(worldId) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) return null;
      if (genres.GENRES.includes(state.genre)) return state.genre;
      const bible = state.bible || {};
      const rules = Array.isArray(bible.rules) ? bible.rules.slice(0, 3) : [];
      const messages = [
        { role: 'system', content: '根据下面这点世界观信息判断题材，只输出一个 JSON 对象：' +
          '{"genre":"xuanhuan|urban|game|horror|cozy|general"}。不要解释，不要输出其他字段。' },
        { role: 'user', content: [
          `标题：${bible.title || ''}`,
          `基调：${bible.tone || ''}`,
          `规则：${rules.join('；')}`,
        ].join('\n') },
      ];
      let judged = 'general';
      try {
        const gp = await callParsed('genre', turnModel, messages,
          { title: bible.title, tone: bible.tone, rules }, []);
        judged = genres.normalizeGenre(gp.parsed && gp.parsed.genre);
      } catch (_) { judged = 'general'; }
      state.genre = judged;
      try { store.saveWorld(dataDir, state); } catch (_) { /* 落库失败也不抛错 */ }
      return judged;
    });
  }

  // 手选题材：世界锁内改并保存，返回归一后的 genre。
  async function setGenre(worldId, genre) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) throw httpError(404, '世界不存在或已被移入回收站');
      state.genre = genres.normalizeGenre(genre);
      store.saveWorld(dataDir, state);
      return state.genre;
    });
  }

  // 玩家点「灵感」：只读当前局面，请模型给 3 条下一步行动，供前端填进输入框。
  // 不加世界锁、不保存、不改 state；失败也不动存档。
  async function suggestActions(worldId, input) {
    store.assertWorldId(worldId);
    const state = loadState(worldId);
    if (!state) throw httpError(404, '世界不存在或已被移入回收站');
    if (state.awaitingRebirth || (state.character && state.character.alive === false)) {
      throw httpError(409, '这一世已经结束，先开启新的一世吧');
    }
    const rawAvoid = input && Array.isArray(input.avoid) ? input.avoid : [];
    const avoid = rawAvoid
      .filter((x) => typeof x === 'string')
      .map((x) => x.trim().slice(0, 80))
      .filter((x) => x)
      .slice(-12);
    // 带当前玩家的画像视图（ready 时「灵感」会据此猜玩家最可能想做的事）。
    // 出错 / 画像未就绪就不传，提示词与不带画像时完全一致。
    let profileView;
    try {
      profileView = profiles.publicProfile(
        profiles.getProfile(dataDir, context.currentPlayerId() || 'host'),
      );
    } catch (_) {
      profileView = undefined;
    }
    const gp = await callParsed('suggest', turnModel,
      prompts.buildSuggestMessages(state, { avoid, profile: profileView }),
      { avoid, turn: state.turn }, []);
    const seen = new Set(avoid);
    const suggestions = [];
    const items = (gp.parsed && Array.isArray(gp.parsed.suggestions)) ? gp.parsed.suggestions : [];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      let text = item.trim();
      // 去掉开头的序号 / 项目符号 / 引号 / 「你」「我」（可能叠加），以及结尾的句号 / 引号。
      for (let guard = 0; guard < 8; guard++) {
        const before = text;
        text = text.replace(/^[0-9]+[.、)）:：]?\s*/, '');
        text = text.replace(/^[-*•—–]\s*/, '');
        text = text.replace(/^[「『“‘"']+/, '');
        text = text.replace(/^(你|我)/, '');
        text = text.replace(/^\s+/, '');
        if (text === before) break;
      }
      text = text.replace(/[。.!！？?…」』”’"']+$/, '').trim().slice(0, 60);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      suggestions.push(text);
      if (suggestions.length >= 3) break;
    }
    if (!suggestions.length) throw httpError(502, '这次没想出新点子，再点一次试试');
    return { suggestions };
  }

  async function getWorld(worldId) {
    store.assertWorldId(worldId);
    const state = loadState(worldId);
    if (!state) throw httpError(404, '世界不存在或已被移入回收站');
    // 老世界没有 genre：后台触发一次补判并保存，不阻塞本次返回。
    if (!genres.GENRES.includes(state.genre) && !pendingGenre.has(worldId)) {
      pendingGenre.add(worldId);
      Promise.resolve()
        .then(() => ensureGenre(worldId))
        .catch(() => {})
        .finally(() => pendingGenre.delete(worldId));
    }
    return withUndoFlag(publicWorld(state), state, worldId);
  }

  // 老世界补序章：世界锁内读状态，已有合法 bible.prologue 直接返回；
  // 否则用回合模型（cfg.LLM_MODEL）一次调用补写四段，失败返回 null，绝不抛错影响游戏。
  async function ensurePrologue(worldId) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) return null;
      const existing = engine.normalizePrologue(state.bible && state.bible.prologue);
      if (existing) return existing;
      let prologue = null;
      try {
        const rp = await callParsed(
          'prologue', turnModel,
          prompts.buildPrologueMessages(state),
          { name: state.character && state.character.name }, [],
        );
        prologue = engine.normalizePrologue(rp.parsed);
      } catch (_) { /* LLM 报错 / 解析失败 → prologue 保持 null，绝不抛错 */ }
      if (!prologue) return null;
      state.bible = state.bible || {};
      state.bible.prologue = prologue;
      store.saveWorld(dataDir, state);
      return prologue;
    });
  }

  // 老世界补设计专属状态：世界锁内读状态，已有非空 state.stats 直接返回公开视图；
  // 否则用回合模型一次调用补设计，经 normalizeStatsSpec 消毒后写入并保存。
  // 任何异常（含 LLM 报错 / 落库失败）都不抛给调用方：最坏返回 []；世界不存在返回 null。
  async function ensureStats(worldId) {
    try {
      store.assertWorldId(worldId);
      return await store.withWorldLock(worldId, async () => {
        const state = loadState(worldId);
        if (!state) return null;
        if (Array.isArray(state.stats) && state.stats.length) {
          return engine.publicStats(state.stats);
        }
        let spec = null;
        try {
          const rp = await callParsed(
            'stats', turnModel,
            prompts.buildStatsMessages(state),
            { genre: state.genre }, [],
          );
          spec = rp.parsed && rp.parsed.stats;
        } catch (_) { /* LLM 报错 / 解析失败 → spec 保持 null，交给题材兜底 */ }
        // normalizeStatsSpec(null, genre) 本身会给题材兜底，故失败路径也有合法设计。
        const cleaned = engine.normalizeStatsSpec(spec, state.genre);
        state.stats = cleaned;
        try { store.saveWorld(dataDir, state); } catch (_) { /* 落库失败也不抛错 */ }
        return engine.publicStats(cleaned);
      });
    } catch (_) {
      return [];
    }
  }

  // 老物品补介绍：世界锁内找出 character.items 中缺介绍的物品，用回合模型一次批量生成，
  // 校验后写回并保存；任何失败都返回现有介绍，绝不抛错影响游戏。
  // 返回按 character.items 顺序的 [{name,desc,type}]，供 GET /items 直接带出。
  async function ensureItemInfo(worldId) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) return [];
      const items = (state.character && Array.isArray(state.character.items)) ? state.character.items : [];
      const info = (state.itemInfo && typeof state.itemInfo === 'object') ? state.itemInfo : {};
      const missing = items.filter((n) => typeof n === 'string' && n.trim()
        && !(info[n] && typeof info[n] === 'object' && typeof info[n].desc === 'string' && info[n].desc));
      if (missing.length) {
        try {
          const rp = await callParsed(
            'items-info', turnModel,
            prompts.buildItemsInfoMessages(state, missing),
            { items: missing }, [],
          );
          const cleaned = engine.cleanItemInfo(rp.parsed, missing);
          if (Object.keys(cleaned).length) {
            state.itemInfo = Object.assign({}, info, cleaned);
            store.saveWorld(dataDir, state);
          }
        } catch (_) { /* LLM 报错 / 解析失败 → 返回现有介绍，绝不抛错 */ }
      }
      const finalInfo = (state.itemInfo && typeof state.itemInfo === 'object') ? state.itemInfo : {};
      return items.map((name) => {
        const meta = (finalInfo[name] && typeof finalInfo[name] === 'object') ? finalInfo[name] : {};
        return {
          name,
          desc: typeof meta.desc === 'string' ? meta.desc : '',
          type: typeof meta.type === 'string' ? meta.type : '',
        };
      });
    });
  }

  function listWorlds() {
    return store.listWorlds(dataDir);
  }

  function usage() {
    return client.summarizeUsage(Date.now());
  }

  function usageToday(playerId) {
    return client.usageToday(Date.now(), playerId);
  }

  // 收集某位已公开人物的「全部」履历：复用 getNpcHistory 的排他 eventIndex 游标逐页翻，
  // 直到 hasMore=false，绝不只取前 20/50 条。任何「声称还有记录却无法安全推进」的异常
  // （空页、hasMore 与 nextCursor 不一致、游标不前进 / 倒退循环、guard 耗尽、实收条目
  // 少于 total）都明确抛带状态码的安全错误中止，绝不 break 后返回 entries 不足却 total
  // 更大的半份「完整」导出；正常 120+ 条、before=0 翻到最旧合成开场仍能读全。
  const MAX_HISTORY_PAGES = 10000; // 分页安全上限：远超任何真实世界页数，仅防异常游标死循环
  function collectNpcHistory(state, rawEvents, npcId) {
    const limit = engine.HISTORY_LIMIT_MAX;
    const first = engine.getNpcHistory(state, rawEvents, npcId, { limit });
    if (!first) return null;
    const entries = first.history.entries.slice();
    const total = first.history.total;

    // 校验一页并返回下一页游标；异常一律抛安全错误，绝不静默 break。
    // prevCursor 为 null 表示首调用（before 未给），只校验游标本身、不做「必须变小」比较。
    function advance(page, prevCursor) {
      const h = page && page.history;
      if (!h || !Array.isArray(h.entries)) {
        throw httpError(500, '人物履历分页数据异常，导出中止');
      }
      if (!h.entries.length) {
        throw httpError(500, '人物履历返回空页，导出中止');
      }
      if (!h.hasMore) return null; // 正常收尾
      const c = h.nextCursor;
      if (c === null || c === undefined) {
        throw httpError(500, '人物履历分页游标缺失（hasMore 与 nextCursor 不一致），导出中止');
      }
      if (!Number.isInteger(c) || c < 0 || (prevCursor !== null && c >= prevCursor)) {
        throw httpError(500, '人物履历分页游标未推进 / 倒退循环，导出中止');
      }
      return c;
    }

    let cursor = advance(first, null);
    let pages = 1; // 首调用已计入
    while (cursor !== null) {
      if (pages >= MAX_HISTORY_PAGES) {
        throw httpError(500, '人物履历分页超过安全上限，导出中止');
      }
      const page = engine.getNpcHistory(state, rawEvents, npcId, { before: cursor, limit });
      const next = advance(page, cursor); // 先校验，异常时绝不把半页并进结果返回
      entries.push(...page.history.entries);
      cursor = next;
      pages += 1;
    }
    if (entries.length !== total) {
      throw httpError(500, `人物履历收集不完整（实收 ${entries.length} / total ${total}），导出中止`);
    }
    return { profile: first.profile, history: { entries, total } };
  }

  // GET /api/worlds/:id/export：保持「去私密」语义（公开状态 + 公开日志），
  // 并额外导出完整公开 NPC 档案 / 履历（遍历分页收集全部原文，不含
  // original / internal / want / apex 等私有资料）。
  // 这是给玩家分享的公开导出，不是服务器 state/events 完整备份：后者含私有字段，
  // 用途与权限都不同；需要完整历史请以服务器文件备份为准。
  function exportWorld(worldId) {
    store.assertWorldId(worldId);
    const state = loadState(worldId);
    if (!state) throw httpError(404, '世界不存在或已被移入回收站');
    const rawEvents = store.readEvents(dataDir, worldId);
    // 人物集合以「有效当前档案」为准：loadState 已处理旧迁移，state 里已接纳的当前角色 /
    // traits 不因旧日志全缺 / 只剩部分记录被重建抹掉（旧版先无条件 hydrate 再取集合会丢档案）。
    // 两处都只取 established===true 的公开字典：current 保住有效 schema1 当前档案，
    // event 再并上仅由 canonical 可见叙事 / 事件建立、state 里仍是基线的人物，保证不漏人。
    // 历史只从剩余 canonical 日志由 getNpcHistory 分页收集，不造记录、不补全成完整原文。
    const currentProfiles = engine.publicNpcProfiles(state);
    const eventProfiles = engine.publicNpcProfiles(engine.hydrateNpcMemory(state, rawEvents));
    const npcArchive = {};
    for (const npcId of new Set([...Object.keys(currentProfiles), ...Object.keys(eventProfiles)])) {
      const detail = collectNpcHistory(state, rawEvents, npcId);
      if (detail) npcArchive[npcId] = detail;
    }
    return {
      state: engine.toPublicState(state),
      events: visibleEventRecords(rawEvents).map(toPublicLogRecord),
      npcArchive, // 完整公开档案 + 全量履历原文（已由 getNpcHistory 过滤 internal）
    };
  }

  // 人物档案详情（只读）：GET /api/worlds/:id/npcs/:npcId 的数据来源。
  // 复用共享契约 getNpcHistory（canonical 可见记录、公共投影、原始 eventIndex 游标分页）。
  // 不存在 / 未公开 / 不属于本世界的人物返回 null；读路径不写盘、不调 LLM / 出图 / TTS。
  function getNpcDetail(worldId, npcId, opts) {
    store.assertWorldId(worldId);
    const state = loadState(worldId);
    if (!state) return null;
    const rawEvents = store.readEvents(dataDir, worldId);
    return engine.getNpcHistory(state, rawEvents, npcId, opts);
  }

  // GET /api/worlds/:id/log?limit=50：从 events.jsonl 读最近 N 条，只返回公开字段。
  // 撤回标记本身不展示，被撤回的那一回合也跳过。
  function getWorldLog(worldId, rawLimit) {
    store.assertWorldId(worldId);
    if (!loadState(worldId)) {
      throw httpError(404, '世界不存在或已被移入回收站');
    }
    let limit = Number(rawLimit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(Math.floor(limit), 200);
    const visible = visibleEventRecords(store.readEvents(dataDir, worldId));
    return visible.slice(Math.max(0, visible.length - limit)).map(toPublicLogRecord);
  }

  // ---- 执行一回合 ----
  // onDelta 可选：传入时主回合走流式并逐段回调叙事文本；整个过程仍在该世界互斥锁内。
  async function takeTurn(worldId, input, onDelta, hooks) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      let state = loadState(worldId);
      if (!state) throw httpError(404, '世界不存在或已被移入回收站');
      if (!engine.canTakeTurn(state)) {
        throw httpError(409, '本世已终，请先提交重生（POST /rebirth）');
      }
      // 老存档兼容：仅在本回合、拼提示词前把被截短的 recent 正文从本世界事件日志补回。
      // 普通读不经过此处；恢复只读不写盘，本回合正常落库时自然沿用完整 recent。
      state = maybeRestoreRecent(dataDir, worldId, state);
      let action = typeof (input && input.action) === 'string' ? input.action : '';
      // 时光推进：校验参数；非法直接 400，不推进回合。有效时覆盖本回合 action。
      let timeSkip = null;
      const rawSkip = input && input.timeSkip;
      if (rawSkip !== undefined && rawSkip !== null) {
        timeSkip = engine.normalizeTimeSkip(rawSkip);
        if (!timeSkip) throw httpError(400, '时光推进参数无效');
        action = `【时光推进·${timeSkip.label}】${timeSkip.plan || '按眼下的日子过下去'}`;
      }
      // 叙事 v3：先按五段任务书写纯正文（流式），再从正文里记账，最后照旧交给引擎结算。
      if (cfg.NARRATIVE_STYLE === 'v3') {
        return takeStoryTurn(worldId, state, action, timeSkip, onDelta, hooks || {});
      }
      const rng = Math.random;
      const now = Date.now();
      const plan = engine.planTurn(state, { rng, timeSkip: timeSkip || undefined });
      const nextTurn = plan.nextTurn;

      const needChapter = plan.needChapter;
      // 与 engine.resolveTurn 的判定保持一致：已达成且高光期结束后换新 apex。
      const needNewApex = !!(
        state.apex && state.apex.achievedAt != null && nextTurn > state.highlightUntilTurn
      );

      const usages = [];
      // 成人模式按当前请求的玩家判定：主人总开关开 且 该玩家 adult 为 true 才用「开」档。
      const adultPrompt = prefs.adultModeOn(dataDir, context.currentPlayerId());

      // 1) 主回合调用：叙事 + 提议 + （开启事件时）event / （结算事件时）event_check。
      // 数值槽名字列表：供 LLM_MOCK 的回合夹具产出 stats_diff（真实模型不需要）。
      const statNames = (Array.isArray(state.stats) ? state.stats : [])
        .filter((st) => st && typeof st === 'object' && st.kind !== 'rank'
          && typeof st.name === 'string' && st.name)
        .map((st) => st.name);
      const turnCtx = {
        turn: nextTurn,
        action,
        theme: plan.theme,
        needEvent: plan.opening,
        needSettlement: plan.settling,
        timeSkip: timeSkip || undefined,
        statNames,
      };
      const tp = await callTurnParsed(
        'turn', turnModel,
        prompts.buildTurnMessages(state, plan, action, {
          adult: adultPrompt,
          narrativeStyle: cfg.NARRATIVE_STYLE,
          timeSkip: timeSkip || undefined,
        }),
        turnCtx, usages, onDelta,
      );
      const out = tp.parsed;
      const proposal = {
        narration: out.narration,
        state_diff: out.state_diff,
        stats_diff: out.stats_diff,
        items_add: out.items_add,
        items_remove: out.items_remove,
        items_info: out.items_info, // 新增物品介绍，引擎只接受实际加入的名字
        npc_attitude: out.npc_attitude,
        persona_tags: out.persona_tags,
        suggestions: out.suggestions,
        new_facts: out.new_facts,
        marks_add: out.marks_add,
        marks_remove: out.marks_remove,
        threads_add: out.threads_add,
        threads_resolve: out.threads_resolve,
        rumor: out.rumor,
        move_to: out.move_to,
        time_passes: out.time_passes,
        overstep: out.overstep, // 本回合玩家行为是否越界（引擎据此累计 state.oversteps）
        scene: out.scene, // 场景插图提议（draw/desc），交给引擎 normalizeScene 校验后写进回合结果
        voice_hints: out.voice_hints, // 朗读提示，交给引擎 normalizeVoiceHints 校验
        focus: out.focus, // 玩家本回合在做的事（安静模式判定用）
        continuing: out.continuing, // 是否继续上一回合同一件事（安静模式判定用）
        adult: out.adult, // 本回合是否含成人露骨内容
        npc_updates: out.npc_updates, // 可选人物档案更新；引擎校验后只落私有 result.npc_memory
        landing_period: out.landing_period, // 时光推进：跳跃结束时的时段（仅 plan.timeSkip 回合生效）
      };
      const data = {
        action,
        proposal,
        plan,
        raw: tp.content,
      };
      if (plan.opening && out.event) data.event = out.event;
      if (plan.settling && out.event_check) data.event_check = out.event_check;

      // 2) 编年史压缩（世界模型）；失败不阻断玩家回合，下一回合再试。
      if (needChapter) {
        try {
          const fromTurn = Math.max(1, nextTurn - 19);
          // 当前回合尚未写入 events.jsonl，显式补进压缩窗口，保证包含第 20 回合本身。
          const current = {
            turn: nextTurn,
            life: state.life,
            action,
            narration: typeof out.narration === 'string' ? out.narration : '',
          };
          const chapterEvents = chapterEventWindow(
            visibleEventRecords(store.readEvents(dataDir, worldId)), nextTurn, current,
          );
          const cp = await callParsed(
            'chapter', worldModel,
            prompts.buildChapterMessages(state, chapterEvents),
            { fromTurn, toTurn: nextTurn }, usages,
          );
          if (cp.parsed && typeof cp.parsed.summary === 'string') {
            data.chapterSummary = cp.parsed.summary;
          }
        } catch (_) { /* 压缩失败下回合重试 */ }
      }

      // 3) 新顶点（世界模型）；失败不阻断玩家回合。
      if (needNewApex) {
        try {
          const ap = await callParsed(
            'apex', worldModel,
            prompts.buildApexMessages(state),
            { generation: (state.apex.generation || 1) + 1 }, usages,
          );
          if (ap.parsed && typeof ap.parsed === 'object') data.newApex = ap.parsed;
        } catch (_) { /* 下一回合再试 */ }
      }

      const resolved = engine.resolveTurn(state, data, { rng, now });
      if (resolved.invalid) {
        // 无效回合：不推进 turn、不写状态、不记 events，让前端重试。
        throw httpError(422, resolved.error || '本回合无效，请重试');
      }

      const npcExtractionInfo = await npcExtraction.completeMemory(
        client, turnModel, state, resolved, action, usages,
      );

      // 死亡：额外调用一次回合模型写墓志铭并入 state.pastLives。
      // 失败 / 超时都回退模板，绝不阻断本回合落库与后续重生。
      let finalState = resolved.state;
      if (resolved.result.death) {
        const entry = await composeEpitaph(
          state, resolved.result.death, resolved.result.turn, usages,
        );
        finalState = engine.applyEpitaph(finalState, entry);
      }

      // 撤回备份：写本回合新状态之前，把当前可变文件（state.json）复制为 .prev 快照。
      // 流式与普通回合都经由 takeTurn，且已在该世界互斥锁内，故在此统一备份一次。
      store.backupForUndo(dataDir, worldId);
      store.saveWorld(dataDir, finalState);

      const usageAgg = { prompt_tokens: 0, completion_tokens: 0 };
      for (const u of usages) {
        usageAgg.prompt_tokens += Number(u.prompt_tokens) || 0;
        usageAgg.completion_tokens += Number(u.completion_tokens) || 0;
      }
      store.appendEvent(dataDir, worldId, {
        turn: resolved.result.turn,
        life: resolved.result.life,
        action: resolved.result.action,
        raw: resolved.result.raw,
        proposal: resolved.result.proposal,
        applied: resolved.result.applied,
        stats_drift: resolved.result.stats_drift || {},
        stats_drains: resolved.result.stats_drains || [],
        rejected: resolved.result.rejected,
        narration: resolved.result.narration,
        event: resolved.result.event || null,
        settlement: resolved.result.settlement || null,
        death: resolved.result.death || null,
        apex: resolved.result.apex || null,
        twist: resolved.result.twist || null, // 导演转折只进 events.jsonl，不进公开状态 / 公开 log
        npc_memory: resolved.result.npc_memory || [], // 私有：仅内部 events.jsonl，绝不进公开 applied / 响应 / log
        npc_memory_extraction: npcExtractionInfo, // 私有补档诊断，不进公开响应
        scene: resolved.result.scene || null,
        voice_hints: resolved.result.voice_hints || [],
        adult: resolved.result.adult === true,
        ...(resolved.result.timeSkip ? { timeSkip: resolved.result.timeSkip } : {}),
        usage: usageAgg,
        ts: resolved.result.ts,
      });

      // 玩家画像：回合成功落库后记录本回合（失败路径不会走到这里）。
      // 后台总结在请求异步链里直接发起，继承 AsyncLocalStorage（用量记到该玩家头上）。
      try {
        const playerId = context.currentPlayerId() || 'host';
        const applied = resolved.result.applied || {};
        const tags = Array.isArray(applied.persona_tags) ? applied.persona_tags : [];
        const bible = finalState.bible || {};
        const updated = profiles.recordTurn(dataDir, playerId, {
          tags,
          action,
          genre: finalState.genre,
          title: bible.title,
          adult: resolved.result.adult === true,
          now,
        });
        maybeSummarizeProfile(playerId, updated);
      } catch (_) {
        // 画像出错绝不影响回合。
      }

      const result = engine.toPublicTurnResult(resolved.result, finalState);
      // 服务端徽章：回合结果也带出 stat / drain 徽章（前端展示是下一个任务）。
      result.badges = badgesFromApplied(resolved.result.applied, resolved.result.stats_drains);
      if (result.state) withUndoFlag(result.state, finalState, worldId);
      return result;
    });
  }


  // ---- 叙事 v3：写正文与记账分两步 ----

  // 写正文模型偶尔会加标题、「第几节」、说明或残留 JSON：只保留正文本身。
  function cleanProse(text) {
    let t = String(text == null ? '' : text).replace(/\r\n/g, '\n').trim();
    t = t.replace(/^```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '');
    const lines = t.split('\n');
    while (lines.length && /^\s*(#{1,6}\s|第\s*[0-9一二三四五六七八九十百]+\s*[节章回]|正文[：:]|\*\*[^*]{1,30}\*\*\s*$)/.test(lines[0])) lines.shift();
    t = lines.join('\n').trim();
    const jsonTail = t.search(/\n\s*\{\s*"[a-z_]+"\s*:/);
    if (jsonTail > 0) t = t.slice(0, jsonTail).trim();
    t = t.replace(/\n{3,}/g, '\n\n');
    // 超过 v3 正文上限时在段落或句子边界收住，避免引擎在半句话处截断。
    const max = engine.STORY_NARRATION_MAX || 2400;
    if (t.length > max) {
      const head = t.slice(0, max);
      const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('。'), head.lastIndexOf('」'));
      t = (cut > max * 0.6 ? head.slice(0, cut + 1) : head).trim();
    }
    return t;
  }

  // 到期伏笔：活跃线索里预计回收章 <= 当前章的那些。
  function dueThreadsOf(state) {
    const meta = state.threadMeta && typeof state.threadMeta === 'object' ? state.threadMeta : {};
    const idx = state.chapter && Number.isSafeInteger(state.chapter.index) ? state.chapter.index : 1;
    return (Array.isArray(state.threads) ? state.threads : [])
      .filter((t) => meta[t] && Number(meta[t].dueChapter) <= idx);
  }

  async function takeStoryTurn(worldId, state, action, timeSkip, onDelta, hooks) {
    const rng = Math.random;
    const now = Date.now();
    const usages = [];
    const playerId = context.currentPlayerId() || 'host';
    let events = [];
    try { events = store.readEvents(dataDir, worldId); } catch (_) { events = []; }
    await ensureOutlineOnState(state, events, usages);
    if (!state.chapter || !Number.isSafeInteger(state.chapter.index)) {
      state.chapter = outlineMod.freshChapter((state.turn || 0) + 1);
    }
    const history = historyMod.buildStoryHistory(events, state, { budget: cfg.STORY_HISTORY_BUDGET });
    const plan = engine.planTurn(state, { rng, timeSkip: timeSkip || undefined, storyMode: true });
    const nextTurn = plan.nextTurn;
    const card = outlineMod.currentCard(state);
    const chapterIndex = state.chapter.index;
    const chapterTurn = (Number(state.chapter.turns) || 0) + 1;
    const adultPrompt = prefs.adultModeOn(dataDir, context.currentPlayerId());
    let mode = 'fine';
    try { mode = prefs.getPrefs(dataDir, playerId).writing; } catch (_) { mode = 'fine'; }
    const wc = writingMode.writingCall(cfg, mode);
    const dueThreads = dueThreadsOf(state);
    const statNames = (Array.isArray(state.stats) ? state.stats : [])
      .filter((st) => st && st.kind !== 'rank' && typeof st.name === 'string' && st.name)
      .map((st) => st.name);

    // 1) 写正文：纯文本流式，思考进度经 hooks.onThinking 往外传（思考内容本身不外传）。
    const sr = await client.completeStream({
      purpose: llm.PURPOSES.STORY,
      model: wc.model,
      extraBody: wc.extraBody,
      plainText: true,
      onThinking: typeof hooks.onThinking === 'function' ? hooks.onThinking : undefined,
      messages: prompts.buildWriterMessages(state, {
        action, history, card, chapterTurn, adult: adultPrompt,
        timeSkip: timeSkip || undefined, plan, dueThreads,
      }),
      mock: { action, turn: nextTurn },
    }, onDelta);
    usages.push(sr.usage);
    const prose = cleanProse(sr.content);
    if (prose.length < engine.NARRATION_MIN) throw httpError(502, '这一节没写出来，请重试');

    // 2) 记账：快速模型从正文里抽字段；失败不阻断——正文已经写好，回合照样落库。
    const lc = writingMode.ledgerCall(cfg);
    let ledger = null;
    let ledgerFailed = false;
    try {
      const lp = await callParsed(
        llm.PURPOSES.LEDGER, lc.model,
        prompts.buildLedgerMessages(state, { action, prose, card, chapterTurn, timeSkip: timeSkip || undefined, plan }),
        { turn: nextTurn, action, statNames, needEvent: plan.opening, needSettlement: plan.settling, timeSkip: timeSkip || undefined },
        usages, { extraBody: lc.extraBody },
      );
      ledger = lp.parsed;
    } catch (_) {
      ledger = null;
    }
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
      ledger = { time_passes: 1, suggestions: [] };
      ledgerFailed = true;
    }

    // 伏笔：v3 的 threads_add 可以是 {text, due}；交给引擎的只要文本，预计回收章另记在 threadMeta。
    const threadDue = {};
    const threadTexts = [];
    for (const t of Array.isArray(ledger.threads_add) ? ledger.threads_add : []) {
      const text = typeof t === 'string' ? t : (t && typeof t.text === 'string' ? t.text : '');
      if (!text || !text.trim()) continue;
      threadTexts.push(text);
      const due = t && typeof t === 'object' && Number.isFinite(Number(t.due)) ? Math.min(3, Math.max(1, Math.round(Number(t.due)))) : 2;
      threadDue[text.trim()] = due;
    }

    const proposal = {
      narration: prose,
      state_diff: ledger.state_diff,
      stats_diff: ledger.stats_diff,
      items_add: ledger.items_add,
      items_remove: ledger.items_remove,
      items_info: ledger.items_info,
      npc_attitude: ledger.npc_attitude,
      persona_tags: ledger.persona_tags,
      suggestions: ledger.suggestions,
      new_facts: ledger.new_facts,
      marks_add: ledger.marks_add,
      marks_remove: ledger.marks_remove,
      threads_add: threadTexts.slice(0, 1), // v3：每回合最多新埋 1 条线索
      threads_resolve: ledger.threads_resolve,
      rumor: ledger.rumor,
      move_to: ledger.move_to,
      // v3：记账没写时间就按「没过多久」处理（引擎缺省是推进一个时段，会让时钟比正文跑得快）。
      time_passes: ledger.time_passes === undefined || ledger.time_passes === null ? 0 : ledger.time_passes,
      overstep: ledger.overstep,
      scene: ledger.scene,
      voice_hints: ledger.voice_hints,
      focus: ledger.focus,
      continuing: ledger.continuing,
      adult: ledger.adult,
      npc_updates: ledger.npc_updates,
      landing_period: ledger.landing_period,
    };
    const data = { action, proposal, plan, raw: JSON.stringify(ledger) };
    if (plan.opening && ledger.event) data.event = ledger.event;
    if (plan.settling && ledger.event_check) data.event_check = ledger.event_check;

    const resolved = engine.resolveTurn(state, data, { rng, now, storyMode: true });
    if (resolved.invalid) throw httpError(422, resolved.error || '本回合无效，请重试');

    const npcExtractionInfo = await npcExtraction.completeMemory(
      client, turnModel, state, resolved, action, usages,
    );

    let finalState = resolved.state;
    if (resolved.result.death) {
      const entry = await composeEpitaph(state, resolved.result.death, resolved.result.turn, usages);
      finalState = engine.applyEpitaph(finalState, entry);
    }

    // 章节进度与伏笔账本（私有）。
    const ledgerChapter = ledger.chapter && typeof ledger.chapter === 'object' ? ledger.chapter : {};
    finalState.chapter = Object.assign({}, state.chapter, { turns: chapterTurn });
    if (ledgerChapter.chapter_end === true) finalState.chapter.pendingClose = true;
    else delete finalState.chapter.pendingClose;
    const prevThreads = Array.isArray(state.threads) ? state.threads : [];
    const meta = {};
    const oldMeta = state.threadMeta && typeof state.threadMeta === 'object' ? state.threadMeta : {};
    for (const t of Array.isArray(finalState.threads) ? finalState.threads : []) {
      if (oldMeta[t]) { meta[t] = oldMeta[t]; continue; }
      if (prevThreads.includes(t)) continue;
      const key = Object.keys(threadDue).find((k) => k === t || k.startsWith(t) || t.startsWith(k));
      meta[t] = { plantedTurn: nextTurn, dueChapter: chapterIndex + (key ? threadDue[key] : 2) };
    }
    finalState.threadMeta = meta;

    store.backupForUndo(dataDir, worldId);
    store.saveWorld(dataDir, finalState);
    // 一章写完（记账判定收章，或本章已写满 7 节）：排在本回合之后、下一回合之前收章并规划下一章。
    // 不 await：玩家先拿到本回合结果；同一世界的下一回合会在锁里排在收章后面。
    if (!finalState.awaitingRebirth && (finalState.chapter.pendingClose || finalState.chapter.turns >= 7)) {
      store.withWorldLock(worldId, () => closeChapter(worldId)).catch(() => {});
    }

    const usageAgg = { prompt_tokens: 0, completion_tokens: 0 };
    for (const u of usages) {
      usageAgg.prompt_tokens += Number(u && u.prompt_tokens) || 0;
      usageAgg.completion_tokens += Number(u && u.completion_tokens) || 0;
    }
    store.appendEvent(dataDir, worldId, {
      turn: resolved.result.turn,
      life: resolved.result.life,
      action: resolved.result.action,
      raw: resolved.result.raw,
      proposal: resolved.result.proposal,
      applied: resolved.result.applied,
      stats_drift: resolved.result.stats_drift || {},
      stats_drains: resolved.result.stats_drains || [],
      rejected: resolved.result.rejected,
      narration: resolved.result.narration,
      event: resolved.result.event || null,
      settlement: resolved.result.settlement || null,
      death: resolved.result.death || null,
      apex: resolved.result.apex || null,
      twist: resolved.result.twist || null,
      npc_memory: resolved.result.npc_memory || [],
      npc_memory_extraction: npcExtractionInfo,
      scene: resolved.result.scene || null,
      voice_hints: resolved.result.voice_hints || [],
      adult: resolved.result.adult === true,
      ...(resolved.result.timeSkip ? { timeSkip: resolved.result.timeSkip } : {}),
      story: { style: 'v3', writing: wc.mode, model: wc.model, ledger_failed: ledgerFailed },
      chapter: { index: chapterIndex, title: (card && card.title) || '' },
      ledger_chapter: ledgerChapter,
      usage: usageAgg,
      ts: resolved.result.ts,
    });

    try {
      const applied = resolved.result.applied || {};
      const tags = Array.isArray(applied.persona_tags) ? applied.persona_tags : [];
      const bible = finalState.bible || {};
      const updated = profiles.recordTurn(dataDir, playerId, {
        tags, action, genre: finalState.genre, title: bible.title,
        adult: resolved.result.adult === true, now,
      });
      maybeSummarizeProfile(playerId, updated);
    } catch (_) { /* 画像出错绝不影响回合 */ }

    const result = engine.toPublicTurnResult(resolved.result, finalState);
    result.badges = badgesFromApplied(resolved.result.applied, resolved.result.stats_drains);
    if (result.state) withUndoFlag(result.state, finalState, worldId);
    return result;
  }

  // 收章：章摘要（快速模型，只依据正文，公开）+ 规划下一章章卡（写正文的强模型，私有）。
  // 已在世界锁内执行（由 takeStoryTurn 排队）。任何失败都吞掉：摘要缺失也照样换章，章卡用兜底。
  // 不写 .prev 撤回快照：撤回本回合时会回到回合开始前的状态，收章一并撤销。
  async function closeChapter(worldId) {
    try {
      const state = loadState(worldId);
      if (!state || !state.chapter || state.awaitingRebirth) return;
      if (!(state.chapter.pendingClose || state.chapter.turns >= 7)) return;
      const usages = [];
      const idx = state.chapter.index;
      const card = outlineMod.currentCard(state);
      const events = store.readEvents(dataDir, worldId);
      const records = visibleEventRecords(events).filter((e) => e && e.type !== 'undo'
        && Number(e.life) === Number(state.life) && typeof e.narration === 'string' && e.narration
        && e.turn >= state.chapter.startTurn && e.turn <= state.turn);
      let close = null;
      try {
        const lc = writingMode.ledgerCall(cfg);
        const cp = await callParsed(llm.PURPOSES.CHAPTER_CLOSE, lc.model,
          prompts.buildChapterCloseMessages(state, records, card), { index: idx }, usages, { extraBody: lc.extraBody });
        close = cp.parsed;
      } catch (_) { close = null; }
      const title = (close && typeof close.title === 'string' && close.title.trim()) ? close.title.trim().slice(0, 10)
        : ((card && card.title) || ('第' + idx + '章'));
      const entry = {
        index: idx,
        title,
        fromTurn: state.chapter.startTurn,
        toTurn: state.turn,
        summary: close && typeof close.summary === 'string' ? close.summary.trim().slice(0, 400) : '',
        bridge: close && typeof close.bridge === 'string' ? close.bridge.trim().slice(0, 40) : '',
      };
      state.chapters = (Array.isArray(state.chapters) ? state.chapters : []).filter((c) => c && c.index !== idx).concat([entry]);
      // 规划下一章。
      let nextCard = null;
      try {
        const wc = writingMode.writingCall(cfg, 'fine');
        const np = await callParsed(llm.PURPOSES.CHAPTER_PLAN, wc.model,
          prompts.buildNextChapterMessages(state, { recentRecords: records.slice(-2), dueThreads: dueThreadsOf(state) }),
          { index: idx + 1 }, usages, { extraBody: wc.extraBody });
        nextCard = outlineMod.normalizeChapterCard(np.parsed, idx + 1);
      } catch (_) { nextCard = null; }
      const outline = state.outline && typeof state.outline === 'object' ? state.outline : { chapters: [] };
      const chapters = Array.isArray(outline.chapters) ? outline.chapters.slice() : [];
      if (!nextCard) {
        nextCard = chapters.find((c) => c && c.index === idx + 1)
          || { index: idx + 1, title: '第' + (idx + 1) + '章', goal: '顺着眼下的局面继续', start: entry.bridge || '', beats: [], end: '', question: '', avoid: [] };
      }
      const pos = chapters.findIndex((c) => c && c.index === idx + 1);
      if (pos >= 0) chapters[pos] = nextCard; else chapters.push(nextCard);
      outline.chapters = chapters;
      state.outline = outline;
      state.chapter = { index: idx + 1, startTurn: state.turn + 1, turns: 0 };
      store.saveWorld(dataDir, state);
    } catch (_) {
      // 收章失败不影响玩家：下一回合还是当前章，满 7 节会再试。
    }
  }

  // ---- 撤回上一步 ----
  // 在该世界互斥锁内执行：有 .prev 快照才允许；死亡回合 / 重生之后返回 409 并说明。
  // 恢复 state.json、删除 .prev（只能撤回一步），并向 events.jsonl 追加
  // {type:'undo', undoneTurn, ts}（日志只追加不删除）。
  async function undoTurn(worldId) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) throw httpError(404, '世界不存在或已被移入回收站');
      if (!store.hasUndoBackup(dataDir, worldId)) {
        throw httpError(409, '没有可以撤回的回合');
      }
      if (state.awaitingRebirth || (state.character && state.character.alive === false)) {
        throw httpError(409, '死亡回合不能撤回，请先重生开始新一世');
      }
      const prev = store.readUndoBackup(dataDir, worldId);
      if (prev && Number(prev.life) !== Number(state.life)) {
        throw httpError(409, '重生之后不能撤回上一世的回合');
      }

      const undoneTurn = state.turn;
      const undoneAction = lastTurnAction(store.readEvents(dataDir, worldId), undoneTurn);

      store.restoreUndoBackup(dataDir, worldId);
      store.appendEvent(dataDir, worldId, { type: 'undo', undoneTurn, ts: Date.now() });

      const restored = loadState(worldId);
      const out = withUndoFlag(publicWorld(restored), restored, worldId);
      out.undoneTurn = undoneTurn;
      out.undoneAction = undoneAction;
      return out;
    });
  }

  // ---- 重生 ----
  async function rebirth(worldId, input) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) throw httpError(404, '世界不存在或已被移入回收站');
      if (!state.awaitingRebirth) throw httpError(409, '当前并未等待重生');
      const r = engine.rebirth(state, input || {});
      if (r.error) throw httpError(400, r.error);

      // 调一次 LLM_MODEL 生成「新一世开场」；失败用模板兜底，绝不阻断重生。
      const usages = [];
      const opening = await composeRebirthOpening(r.state, usages);
      const finalState = engine.applyRebirthOpening(r.state, opening);
      store.saveWorld(dataDir, finalState);

      // 作为该世第一条叙事写入 events.jsonl（公开记录），前端回放时按开场样式显示。
      const usageAgg = { prompt_tokens: 0, completion_tokens: 0 };
      for (const u of usages) {
        usageAgg.prompt_tokens += Number(u.prompt_tokens) || 0;
        usageAgg.completion_tokens += Number(u.completion_tokens) || 0;
      }
      store.appendEvent(dataDir, worldId, {
        turn: finalState.turn,
        life: finalState.life,
        action: '',
        narration: opening,
        rebirthOpening: true,
        applied: {
          state_diff: {}, items_add: [], items_remove: [], npc_attitude: {},
          persona_tags: [], persona: {}, suggestions: [], narration: '',
        },
        rejected: [],
        event: null,
        settlement: null,
        death: null,
        apex: null,
        twist: null,
        usage: usageAgg,
        ts: Date.now(),
      });
      return publicWorld(finalState);
    });
  }

  // ---- 删除（移入 _trash）----
  async function deleteWorld(worldId) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const dest = store.deleteWorld(dataDir, worldId);
      if (!dest) throw httpError(404, '世界不存在');
      // 世界已移入回收站：清掉旧档回填缓存里对应项，不让已删除世界占着有界缓存。
      npcHydrationCache.delete(`${dataDir}\u0000${worldId}`);
      return { deleted: true };
    });
  }

  // 当前存档「可见历史」里应当出图的场景；撤回的回合已由 visibleEventRecords 排除。
  // sceneKey 规则放在 server.js 里算，保持 game.js 不依赖 images.js。
  function listScenes(worldId) {
    return visibleEventRecords(store.readEvents(dataDir, worldId))
      .filter((e) => e && e.scene && e.scene.draw === true)
      .map((e) => ({ turn: e.turn, life: e.life, desc: e.scene.desc }));
  }

  return {
    buildWorld, getWorld, ensurePrologue, ensureStats, ensureItemInfo, ensureGenre, setGenre, listWorlds, takeTurn, rebirth, deleteWorld, usage, usageToday, getWorldLog,
    exportWorld, undoTurn, listScenes, getNpcDetail, suggestActions,
  };
}

module.exports = {
  createGame, HttpError, httpError,
  chapterEventWindow, badgesFromApplied, toPublicLogRecord,
  visibleEventRecords, lastTurnAction,
  restoreRecentNarration, maybeRestoreRecent, LEGACY_RECENT_NARRATION_MAX,
  templateEpitaph, epitaphFromParsed,
  templateRebirthOpening, openingFromParsed, rebirthInfo,
  REBIRTH_OPENING_MIN, REBIRTH_OPENING_MAX,
  NPC_HYDRATION_CACHE_MAX, npcHydrationCacheSize,
};
