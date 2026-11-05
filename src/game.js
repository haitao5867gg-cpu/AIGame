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

// events.jsonl 的单条记录 → 只保留公开字段，绝不把 apex / raw / proposal / rejected / usage 带出去。
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
    ts: e.ts,
  };
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

  function publicWorld(state) {
    return engine.toPublicState(state);
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
    return publicWorld(state);
  }

  function listWorlds() {
    return store.listWorlds(dataDir);
  }

  function usage() {
    return client.summarizeUsage(Date.now());
  }

  // GET /api/worlds/:id/log?limit=50：从 events.jsonl 读最近 N 条，只返回公开字段。
  function getWorldLog(worldId, rawLimit) {
    store.assertWorldId(worldId);
    if (!loadState(worldId)) {
      throw httpError(404, '世界不存在或已被移入回收站');
    }
    let limit = Number(rawLimit);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    limit = Math.min(Math.floor(limit), 200);
    const all = store.readEvents(dataDir, worldId);
    return all.slice(Math.max(0, all.length - limit)).map(toPublicLogRecord);
  }

  // ---- 执行一回合 ----
  async function takeTurn(worldId, input) {
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
      const tp = await callParsed(
        'turn', turnModel,
        prompts.buildTurnMessages(state, plan, action),
        turnCtx, usages,
      );
      const out = tp.parsed;
      const proposal = {
        narration: out.narration,
        state_diff: out.state_diff,
        items_add: out.items_add,
        items_remove: out.items_remove,
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
            store.readEvents(dataDir, worldId), nextTurn, current,
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
        usage: usageAgg,
        ts: resolved.result.ts,
      });

      return engine.toPublicTurnResult(resolved.result, finalState);
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
      store.saveWorld(dataDir, r.state);
      return publicWorld(r.state);
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

  return {
    buildWorld, getWorld, listWorlds, takeTurn, rebirth, deleteWorld, usage, getWorldLog,
  };
}

module.exports = {
  createGame, HttpError, httpError,
  chapterEventWindow, badgesFromApplied, toPublicLogRecord,
  templateEpitaph, epitaphFromParsed,
};
