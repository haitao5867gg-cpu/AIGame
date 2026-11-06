'use strict';

// 第 3 / 4 / 5 节编排层：建世界、执行回合、重生、编年史压缩、顶点检测与刷新。
// 只做「组装 prompt → llm → 解析 → engine → 存储」，规则与数值全部交给 engine.js。
// 所有写操作经 store.withWorldLock 串行，保证同一世界不会并发推进回合。

const crypto = require('node:crypto');
const store = require('./store.js');
const engine = require('./engine.js');
const llm = require('./llm.js');
const prompts = require('./prompts.js');

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
function badgesFromApplied(applied) {
  const a = applied && typeof applied === 'object' ? applied : {};
  const badges = [];
  const diff = a.state_diff && typeof a.state_diff === 'object' ? a.state_diff : {};
  for (const key of Object.keys(diff)) {
    if (!engine.ATTRS.includes(key)) continue;
    const d = Number(diff[key]);
    if (!Number.isFinite(d) || d === 0) continue;
    badges.push({ type: 'attr', name: key, delta: d });
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

// events.jsonl 的单条记录 → 只保留公开字段，绝不把 apex / twist / raw / proposal / rejected / usage 带出去。
function toPublicLogRecord(rec) {
  const e = rec && typeof rec === 'object' ? rec : {};
  const ev = e.event && typeof e.event === 'object' ? e.event : null;
  const st = e.settlement && typeof e.settlement === 'object' ? e.settlement : null;
  const d = e.death && typeof e.death === 'object' ? e.death : null;
  return {
    turn: e.turn,
    life: e.life,
    action: typeof e.action === 'string' ? e.action : '',
    narration: typeof e.narration === 'string' ? e.narration : '',
    // 重生开场是独立的一条公开叙事，前端进入新一世时按开场样式回放。
    ...(e.rebirthOpening === true ? { rebirthOpening: true } : {}),
    badges: badgesFromApplied(e.applied),
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

// 从 events.jsonl 原始记录中挑出「可见」记录（供 /log 与导出回放）：
//  - {type:'undo'} 是撤回标记，不是叙事，隐藏；
//  - 每条撤回标记紧跟在被撤回回合记录之后（日志只追加不删除，且撤回在世界锁内紧接回合发生），
//    因此把标记前一条 turn === undoneTurn 的记录一并隐藏。
// 用「位置」而非全局回合号集合判定：撤回后再走一步会复用同一回合号，新记录位于标记之后、仍可见。
function visibleEventRecords(events) {
  const list = Array.isArray(events) ? events : [];
  const hidden = new Set();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.type !== 'undo') continue;
    hidden.add(i);
    const prev = list[i - 1];
    if (prev && prev.type !== 'undo' && prev.turn === e.undoneTurn) hidden.add(i - 1);
  }
  const out = [];
  for (let i = 0; i < list.length; i++) if (!hidden.has(i)) out.push(list[i]);
  return out;
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

function createGame(cfg, dataDir) {
  const client = llm.createClient(cfg, dataDir);
  const turnModel = cfg.LLM_MODEL;
  const worldModel = cfg.LLM_MODEL_WORLD;

  // 记录每次 LLM 调用的用量，供 events.jsonl 的 usage 字段聚合。
  async function call(purpose, model, messages, mockCtx, usages) {
    const res = await client.complete({
      purpose,
      model,
      messages,
      responseFormat: 'json_object',
      mock: mockCtx,
    });
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
  async function callParsed(purpose, model, messages, mockCtx, usages) {
    let lastContent = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await call(purpose, model, messages, mockCtx, usages);
      lastContent = res.content;
      const parsed = prompts.parseJson(res.content);
      if (parsed) return { parsed, content: res.content };
    }
    throw httpError(502, '模型输出无法解析为 JSON，本回合未推进，请稍后重试');
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
  function loadState(worldId) {
    const state = store.loadWorld(dataDir, worldId);
    return state ? engine.normalizeState(state) : null;
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
      let state;
      try {
        state = engine.createWorld(
          { id, seed, name, appearance, bible, apex, alloc: data.alloc },
          { rng: Math.random, now: Date.now() },
        );
      } catch (err) {
        throw httpError(400, err && err.message ? err.message : '属性点分配非法');
      }
      store.saveWorld(dataDir, state);
      return publicWorld(state);
    });
  }

  // ---- 读 ----
  async function getWorld(worldId) {
    store.assertWorldId(worldId);
    const state = loadState(worldId);
    if (!state) throw httpError(404, '世界不存在或已被移入回收站');
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

  // GET /api/worlds/:id/export：state.json（去掉 apex 等内部字段，用公开状态）
  // + events.jsonl 的公开字段，打包成一个可下载的对象。
  function exportWorld(worldId) {
    store.assertWorldId(worldId);
    const state = loadState(worldId);
    if (!state) throw httpError(404, '世界不存在或已被移入回收站');
    return {
      state: engine.toPublicState(state),
      events: visibleEventRecords(store.readEvents(dataDir, worldId)).map(toPublicLogRecord),
    };
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
  async function takeTurn(worldId, input, onDelta) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = loadState(worldId);
      if (!state) throw httpError(404, '世界不存在或已被移入回收站');
      if (!engine.canTakeTurn(state)) {
        throw httpError(409, '本世已终，请先提交重生（POST /rebirth）');
      }
      const action = typeof (input && input.action) === 'string' ? input.action : '';
      const rng = Math.random;
      const now = Date.now();
      const plan = engine.planTurn(state, { rng });
      const nextTurn = plan.nextTurn;

      const needChapter = plan.needChapter;
      // 与 engine.resolveTurn 的判定保持一致：已达成且高光期结束后换新 apex。
      const needNewApex = !!(
        state.apex && state.apex.achievedAt != null && nextTurn > state.highlightUntilTurn
      );

      const usages = [];

      // 1) 主回合调用：叙事 + 提议 + （开启事件时）event / （结算事件时）event_check。
      const turnCtx = {
        turn: nextTurn,
        action,
        theme: plan.theme,
        needEvent: plan.opening,
        needSettlement: plan.settling,
      };
      const tp = await callTurnParsed(
        'turn', turnModel,
        prompts.buildTurnMessages(state, plan, action),
        turnCtx, usages, onDelta,
      );
      const out = tp.parsed;
      const proposal = {
        narration: out.narration,
        state_diff: out.state_diff,
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
        rejected: resolved.result.rejected,
        narration: resolved.result.narration,
        event: resolved.result.event || null,
        settlement: resolved.result.settlement || null,
        death: resolved.result.death || null,
        apex: resolved.result.apex || null,
        twist: resolved.result.twist || null, // 导演转折只进 events.jsonl，不进公开状态 / 公开 log
        scene: resolved.result.scene || null,
        voice_hints: resolved.result.voice_hints || [],
        usage: usageAgg,
        ts: resolved.result.ts,
      });

      const result = engine.toPublicTurnResult(resolved.result, finalState);
      if (result.state) withUndoFlag(result.state, finalState, worldId);
      return result;
    });
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
    buildWorld, getWorld, ensurePrologue, ensureItemInfo, listWorlds, takeTurn, rebirth, deleteWorld, usage, usageToday, getWorldLog,
    exportWorld, undoTurn, listScenes,
  };
}

module.exports = {
  createGame, HttpError, httpError,
  chapterEventWindow, badgesFromApplied, toPublicLogRecord,
  visibleEventRecords, lastTurnAction,
  templateEpitaph, epitaphFromParsed,
  templateRebirthOpening, openingFromParsed, rebirthInfo,
  REBIRTH_OPENING_MIN, REBIRTH_OPENING_MAX,
};
