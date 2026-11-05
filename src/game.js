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

function newWorldId() {
  return 'w' + crypto.randomBytes(8).toString('hex');
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

  function publicWorld(state) {
    return engine.toPublicState(state);
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
    const state = store.loadWorld(dataDir, worldId);
    if (!state) throw httpError(404, '世界不存在或已被移入回收站');
    return publicWorld(state);
  }

  function listWorlds() {
    return store.listWorlds(dataDir);
  }

  function usage() {
    return client.summarizeUsage(Date.now());
  }

  // ---- 执行一回合 ----
  async function takeTurn(worldId, input) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = store.loadWorld(dataDir, worldId);
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
          const past = store
            .readEvents(dataDir, worldId)
            .filter((e) => e.turn >= fromTurn && e.turn < nextTurn);
          const cp = await callParsed(
            'chapter', worldModel,
            prompts.buildChapterMessages(state, past),
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

      store.saveWorld(dataDir, resolved.state);

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

      return engine.toPublicTurnResult(resolved.result, resolved.state);
    });
  }

  // ---- 重生 ----
  async function rebirth(worldId, input) {
    store.assertWorldId(worldId);
    return store.withWorldLock(worldId, async () => {
      const state = store.loadWorld(dataDir, worldId);
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

  return { buildWorld, getWorld, listWorlds, takeTurn, rebirth, deleteWorld, usage };
}

module.exports = { createGame, HttpError, httpError };
