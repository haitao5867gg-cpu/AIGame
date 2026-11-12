'use strict';

// 请求级上下文：在 server.js 里用 run({ playerId }) 包住每个请求，
// 之后同一请求触发的 LLM / 出图调用（含其异步后续）记用量时都能拿到当前玩家。
// llmRoute：成人模式世界的请求带 'adult'，同一请求里的全部 LLM 调用改走成人模式网关（见 src/adult-mode.js）。

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function run(ctx, fn) {
  return als.run(Object.assign({}, ctx), fn);
}

function currentPlayerId() {
  const s = als.getStore();
  return s && typeof s.playerId === 'string' ? s.playerId : null;
}

function currentLlmRoute() {
  const s = als.getStore();
  return s && typeof s.llmRoute === 'string' && s.llmRoute ? s.llmRoute : null;
}

module.exports = { run, currentPlayerId, currentLlmRoute };
