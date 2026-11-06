'use strict';

// 请求级上下文：在 server.js 里用 run({ playerId }) 包住每个请求，
// 之后同一请求触发的 LLM / 出图调用（含其异步后续）记用量时都能拿到当前玩家。

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function run(ctx, fn) {
  return als.run(Object.assign({}, ctx), fn);
}

function currentPlayerId() {
  const s = als.getStore();
  return s && typeof s.playerId === 'string' ? s.playerId : null;
}

module.exports = { run, currentPlayerId };
