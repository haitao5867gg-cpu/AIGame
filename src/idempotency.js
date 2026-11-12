'use strict';

// 回合防重：同一个客户端请求 ID 只真正执行一次。
//
// 手机上常见的情况：玩家发出行动后切去别的 App、锁屏或网络切换，浏览器把流式连接掐断，
// 但服务器上这一回合照样写完、落库。以前前端断流后会立刻用同一句行动再 POST 一次 /turn，
// 世界锁把第二次排在第一次之后，于是同一句话被执行两遍、写出两回合。
//
// 现在前端每次行动带一个 clientTurnId，断流重试 / 刷新页面后取回都用同一个 ID：
//   - 第一次执行还没结束：后来的请求直接等同一个 Promise，拿同一份结果；
//   - 已经执行完：在保留期内直接返回缓存的结果；
//   - 执行失败：不缓存，下次带同一个 ID 会重新执行（等于重试）。
// 只放内存：服务重启后缓存清空，前端会按「上一回合没写完」处理（把行动放回输入框，不自动重发）。

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_MAX = 500;
const ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function validId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id);
}

function createIdempotency(opts) {
  const o = opts || {};
  const ttl = Number.isFinite(o.ttlMs) && o.ttlMs > 0 ? o.ttlMs : DEFAULT_TTL_MS;
  const max = Number.isInteger(o.max) && o.max > 0 ? o.max : DEFAULT_MAX;
  const now = typeof o.now === 'function' ? o.now : Date.now;
  // key -> { promise, done, value, at }
  const entries = new Map();

  function prune() {
    const t = now();
    for (const [k, e] of entries) {
      if (e.done && t - e.at > ttl) entries.delete(k);
    }
    // 超出上限：按插入顺序先丢最老的已完成项（进行中的不丢）。
    if (entries.size > max) {
      for (const [k, e] of entries) {
        if (entries.size <= max) break;
        if (e.done) entries.delete(k);
      }
    }
  }

  // 查状态：'running' | 'done' | null（不认识）。
  function status(key) {
    prune();
    const e = entries.get(key);
    if (!e) return null;
    return e.done ? 'done' : 'running';
  }

  // 同一个 key 只执行一次 fn；返回 { value, replay }，replay=true 表示这次没有真正执行。
  async function run(key, fn) {
    prune();
    const hit = entries.get(key);
    if (hit) {
      const value = hit.done ? hit.value : await hit.promise;
      return { value, replay: true };
    }
    const entry = { promise: null, done: false, value: undefined, at: now() };
    entry.promise = (async () => fn())();
    entries.set(key, entry);
    try {
      const value = await entry.promise;
      entry.done = true;
      entry.value = value;
      entry.at = now();
      prune();
      return { value, replay: false };
    } catch (err) {
      // 失败不缓存：同一个 ID 下次再来会重新执行。
      if (entries.get(key) === entry) entries.delete(key);
      throw err;
    }
  }

  // 只取回：已知的 key 返回结果（进行中就等），不认识返回 undefined，绝不执行任何东西。
  async function attach(key) {
    prune();
    const e = entries.get(key);
    if (!e) return undefined;
    return e.done ? e.value : e.promise;
  }

  return { run, attach, status, size: () => entries.size };
}

module.exports = { createIdempotency, validId };
