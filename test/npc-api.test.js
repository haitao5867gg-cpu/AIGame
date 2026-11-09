'use strict';

// 任务3 接口测试：GET /api/worlds/:id/npcs/:npcId 的认证 / 归属 / 参数校验 /
// 公开去私密 / 分页 / 只读。只读人物卡绝不调用模型 / 出图 / TTS，也不写档。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { req, asGuest, loginGuest, guestMe, withServer } = require('./helpers/api-helpers.js');
const store = require('../src/store.js');

function assertNoPrivate(text, label) {
  for (const key of ['npc_memory', 'npc_updates', 'original', 'want', 'internal', 'apex', 'twist', 'LLM_API_KEY']) {
    assert.equal(new RegExp(`"${key}"\\s*:`).test(text), false, `${label} 不应含私有键 ${key}`);
  }
}

// 建一个已发生 1 回合（守夜人已建立公开档案）的世界，返回 { id, npcId }。
async function worldWithNpc(base) {
  const created = await req(base, 'POST', '/api/worlds', { seed: '雾港', name: '旅人', appearance: '青衣' });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  const turn = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '向守夜人打听钟声' });
  assert.equal(turn.status, 200, turn.text);
  const world = await req(base, 'GET', `/api/worlds/${id}`);
  assert.equal(world.status, 200, world.text);
  const ids = Object.keys(world.json.npcProfiles || {});
  assert.ok(ids.length >= 1, '首回合应建立至少一个已知人物');
  return { id, npcId: ids[0] };
}

test('GET 人物详情：200 + {profile, history}，只含公开投影', async () => {
  await withServer(async ({ base }) => {
    const { id, npcId } = await worldWithNpc(base);
    const r = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.profile, '带 profile');
    assert.ok(r.json.history, '带 history');
    assert.ok(Array.isArray(r.json.history.entries));
    assert.ok(Number.isInteger(r.json.history.total));
    assert.equal(typeof r.json.history.hasMore, 'boolean');
    assert.ok(r.json.profile.name);
    assertNoPrivate(r.text, '人物详情');
    assert.ok(r.text.includes('守夜人'), '含已知人物线索');
  });
});

test('人物详情：includePrivate 查询无效，不泄露任何私密 sentinel', async () => {
  await withServer(async ({ base }) => {
    const { id, npcId } = await worldWithNpc(base);
    const plain = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}`);
    const withFlag = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}?includePrivate=1&limit=100`);
    assert.equal(withFlag.status, 200, withFlag.text);
    assertNoPrivate(withFlag.text, 'includePrivate=1 响应');
    assert.deepEqual(withFlag.json.profile, plain.json.profile, '开关不改变公开投影');
    assert.equal(withFlag.json.history.total, plain.json.history.total);
  });
});

test('人物详情：异常参数 400；limit 上限由引擎夹到 50', async () => {
  await withServer(async ({ base }) => {
    const { id, npcId } = await worldWithNpc(base);
    const url = `/api/worlds/${id}/npcs/${npcId}`;
    for (const q of ['?before=abc', '?before=-1', '?before=1.5', '?before=99999999999999999999',
      '?limit=abc', '?limit=0', '?limit=-3', '?limit=2.5']) {
      const r = await req(base, 'GET', url + q);
      assert.equal(r.status, 400, `${q} 应 400：${r.text}`);
    }
    const ok = await req(base, 'GET', url + '?limit=9999');
    assert.equal(ok.status, 200, ok.text);
    assert.ok(ok.json.history.entries.length <= 50, '最多 50 一页');
    const zero = await req(base, 'GET', url + '?before=0&limit=5');
    assert.equal(zero.status, 200, zero.text);
    assert.ok(zero.json.history.entries.every((e) => e.eventIndex < 0), 'before=0 只翻到最旧开场');
  });
});

test('人物详情：只 GET；不存在 / 未公开 / 跨世界人物 404', async () => {
  await withServer(async ({ base }) => {
    const { id, npcId } = await worldWithNpc(base);
    const post = await req(base, 'POST', `/api/worlds/${id}/npcs/${npcId}`, {});
    assert.equal(post.status, 405, '只支持 GET');

    const missing = await req(base, 'GET', `/api/worlds/${id}/npcs/npc_missing`);
    assert.equal(missing.status, 404);
    const proto = await req(base, 'GET', `/api/worlds/${id}/npcs/__proto__`);
    assert.equal(proto.status, 404, '危险 id 不串档');

    // 另一个世界：不同 world id + 未推进回合 => 稳定 id 不匹配、人物未公开
    const b = await req(base, 'POST', '/api/worlds', { seed: '另一世界', name: '乙', appearance: '布衣' });
    assert.equal(b.status, 201, b.text);
    const cross = await req(base, 'GET', `/api/worlds/${b.json.id}/npcs/${npcId}`);
    assert.equal(cross.status, 404, '跨世界人物不可读');
    const noWorld = await req(base, 'GET', `/api/worlds/nonexistent/npcs/${npcId}`);
    assert.equal(noWorld.status, 404, '不存在的世界不可读');
  });
});

test('人物详情：分页用排他 eventIndex 游标翻完全部原文，且响应去私密', async () => {
  await withServer(async ({ base }) => {
    const { id, npcId } = await worldWithNpc(base);
    // 多跑几回合，让同一人物有多条共同经历
    for (let i = 0; i < 8; i += 1) {
      const t = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '继续查钟声' });
      assert.equal(t.status, 200, t.text);
    }
    const first = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}?limit=3`);
    assert.equal(first.status, 200, first.text);
    assert.ok(first.json.history.hasMore, '3 条一页应有下一页');
    assert.ok(first.json.history.nextCursor === null || first.json.history.nextCursor >= 0, 'cursor 非负');

    const seen = [];
    let before;
    for (let guard = 0; guard < 1000; guard += 1) {
      const q = before === undefined ? '?limit=3' : `?limit=3&before=${before}`;
      const p = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}${q}`);
      assert.equal(p.status, 200, p.text);
      assertNoPrivate(p.text, '分页响应');
      seen.push(...p.json.history.entries);
      if (p.json.history.nextCursor === null || p.json.history.nextCursor === undefined) break;
      before = p.json.history.nextCursor;
    }
    assert.equal(seen.length, first.json.history.total, '翻页收集全部记录');
    assert.equal(new Set(seen.map((e) => e.eventIndex)).size, seen.length, '无重复');
    assert.ok(seen.some((e) => typeof e.narration === 'string' && e.narration.includes('守夜人')), '完整原文');
  });
});

test('人物详情：复用登录 / requireOwner，未登录 401、来客越权 404', async () => {
  await withServer(async ({ base, dataDir }) => {
    const { id, npcId } = await worldWithNpc(base);
    // 未登录来客先被全局访问控制拦在路由之外（/api/* 一律 401 login）。
    const unauth = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}`, undefined, asGuest());
    assert.equal(unauth.status, 401, '未登录来客先被拦为 401');
    assert.equal(/"npc_memory"\s*:/.test(unauth.text), false, '401 也不泄露');

    // 已登录来客能进路由，但世界归 host，requireOwner 判定越权 => 404，且不泄露世界是否存在。
    const cookie = await loginGuest(base, dataDir, '来客甲');
    const me = await guestMe(base, cookie);
    assert.ok(me.id && me.id !== 'host');
    const guest = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}`, undefined, asGuest(cookie));
    assert.equal(guest.status, 404, '来客不能读主人世界的人物档案');
    assert.equal(/"npc_memory"\s*:/.test(guest.text), false, '404 也不泄露');
  });
});

test('打开人物卡是只读：state / events 磁盘字节不变，不含私密', async () => {
  await withServer(async ({ base, dataDir }) => {
    const { id, npcId } = await worldWithNpc(base);
    const files = [store.statePath(dataDir, id), store.eventsPath(dataDir, id)];
    const snap = () => files.map((p) => {
      try { return fs.readFileSync(p).toString('base64'); } catch (_) { return null; }
    });
    const before = snap();
    const a = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}`);
    const b = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}?before=0&limit=5`);
    const c = await req(base, 'GET', `/api/worlds/${id}/npcs/${npcId}?includePrivate=true`);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(c.status, 200);
    assert.deepEqual(snap(), before, '读人物卡前后 world 存档字节不变');
    for (const t of [a.text, b.text, c.text]) assertNoPrivate(t, '人物卡响应');
  });
});
