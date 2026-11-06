'use strict';

// 朗读（第 2 步后端）：月度额度 / 每日默认 / Azure 429 冷却 / 接口字段 / prefs.tts 校验。
// 全部用注入的假 fetch 与注入的 now，绝不真的请求 Azure。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const tts = require('../src/tts.js');
const prefs = require('../src/prefs.js');
const { withServer, req } = require('./helpers/api-helpers.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-ttsq-'));
}
function cleanup(t, dir) {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}
function cfgWith(o) {
  return Object.assign({}, env.DEFAULTS, o || {});
}
function fakeFetch(calls, body) {
  const data = body || Buffer.from('ID3-fake-mp3');
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, arrayBuffer: async () => data };
  };
}
function mkTts(dir, overrides, opts) {
  const cfg = cfgWith(Object.assign({ AZURE_SPEECH_KEY: 'k1', AZURE_SPEECH_REGION: 'eastasia' }, overrides || {}));
  return tts.createTts(cfg, dir, opts || {});
}
function writeUsage(dir, rows) {
  fs.writeFileSync(store.usagePath(dir), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}
function cfgServer() {
  return {
    AZURE_SPEECH_KEY: 'k1', AZURE_SPEECH_REGION: 'eastasia',
    TTS_MONTHLY_CHARS: 500000, TTS_MONTHLY_STOP_AT: 450000,
  };
}

// ---------- 月度额度 ----------

test('月度额度：本月已用达 stopAt 时 synth 抛 503 fallback，下月自动恢复', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const THIS = Date.UTC(2026, 5, 15, 4, 0, 0);   // 2026-06 UTC
  const NEXT = Date.UTC(2026, 6, 1, 4, 0, 0);    // 2026-07 UTC
  let nowVal = THIS;
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => nowVal });
  writeUsage(dir, [
    { ts: THIS - 1000, kind: 'tts', playerId: 'g', voice: 'zh-CN-YunxiNeural', chars: 450000, cached: false, ms: 1, ok: true },
    { ts: THIS - 2000, kind: 'tts', playerId: 'g', voice: 'zh-CN-YunxiNeural', chars: 88888, cached: true, ms: 0, ok: true },
  ]);
  let err;
  try { await t1.synth({ text: '新的一段。', playerId: 'host' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 503);
  assert.equal(err && err.fallback, true);
  assert.equal(err && err.message, '本月朗读额度已用完，已改用浏览器朗读');
  assert.equal(calls.length, 0, '额度用完不应再请求 Azure');
  assert.equal(t1.monthUsage().exhausted, true);

  // 按月份算、不需存状态：换到下个月自动恢复。
  nowVal = NEXT;
  const audio = await t1.synth({ text: '新的一段。', playerId: 'host' });
  assert.ok(Buffer.isBuffer(audio));
  assert.equal(calls.length, 1);
});

test('月度额度：cached:true 的用量不计入月度总量', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => NOW });
  writeUsage(dir, [
    { ts: NOW - 1000, kind: 'tts', playerId: 'p', voice: 'zh-CN-YunxiNeural', chars: 900000, cached: true, ms: 0, ok: true },
  ]);
  assert.equal(t1.monthUsage().used, 0, '缓存记录不计字数');
  const audio = await t1.synth({ text: '你好', playerId: 'host' });
  assert.ok(Buffer.isBuffer(audio));
  assert.equal(calls.length, 1, '缓存不计入则仍可请求 Azure');
});

// ---------- 每日默认 / 主人 ----------

test('每日上限默认 10000 字', async (t) => {
  assert.equal(Number(env.DEFAULTS.TTS_PLAYER_DAILY_CHARS), 10000);
  const dir = tmpDir(); cleanup(t, dir);
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => NOW });
  writeUsage(dir, [
    { ts: NOW - 1000, kind: 'tts', playerId: 'g', voice: 'zh-CN-YunxiNeural', chars: 10000, cached: false, ms: 1, ok: true },
  ]);
  let err;
  try { await t1.synth({ text: '啊', playerId: 'g' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 429);
  assert.equal(calls.length, 0);
});

test('主人不受每日限制，但用量计入月度总量', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => NOW });
  const text = '主人来读一段较长的话。';
  writeUsage(dir, [
    { ts: NOW - 1000, kind: 'tts', playerId: 'g', voice: 'zh-CN-YunxiNeural', chars: 99999, cached: false, ms: 1, ok: true },
  ]);
  const audio = await t1.synth({ text, playerId: 'host' });
  assert.ok(Buffer.isBuffer(audio), '主人不受每日限制');
  assert.equal(calls.length, 1);
  assert.equal(t1.monthUsage().used, 99999 + text.length, '主人本次字数计入月度');
});

// ---------- Azure 429 冷却 ----------

test('Azure 返回 429 后冷却 20 秒：期间直接 fallback，之后恢复', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  let nowVal = 1000;
  const calls = [];
  let first = true;
  const fetchImpl = async () => {
    calls.push(1);
    if (first) { first = false; return { ok: false, status: 429 }; }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('ID3-ok') };
  };
  const t1 = mkTts(dir, {}, { fetchImpl, now: () => nowVal });
  let err;
  try { await t1.synth({ text: '触发限流。', playerId: 'host' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 503);
  assert.equal(err && err.fallback, true);
  assert.equal(err && err.message, '朗读服务繁忙，已改用浏览器朗读');
  assert.equal(calls.length, 1);

  nowVal = 1000 + 19000; // 冷却期内：直接 fallback，不打 Azure
  let err2;
  try { await t1.synth({ text: '冷却中。', playerId: 'host' }); } catch (e) { err2 = e; }
  assert.equal(err2 && err2.status, 503);
  assert.equal(err2 && err2.message, '朗读服务繁忙，已改用浏览器朗读');
  assert.equal(calls.length, 1, '冷却期间不应再请求 Azure');

  nowVal = 1000 + 21000; // 冷却结束：恢复
  const audio = await t1.synth({ text: '恢复啦。', playerId: 'host' });
  assert.ok(Buffer.isBuffer(audio));
  assert.equal(calls.length, 2);
});

test('其他 Azure 错误（非 ok 响应 / 网络异常）也带 fallback:true', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const t1 = mkTts(dir, {}, {
    fetchImpl: async () => ({ ok: false, status: 500 }), now: () => 1000,
  });
  let err;
  try { await t1.synth({ text: '普通失败。', playerId: 'host' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 502);
  assert.equal(err && err.fallback, true);

  const t2 = mkTts(dir, {}, {
    fetchImpl: async () => { throw new Error('network down'); }, now: () => 1000,
  });
  let err2;
  try { await t2.synth({ text: '网络失败。', playerId: 'host' }); } catch (e) { err2 = e; }
  assert.equal(err2 && err2.status, 502);
  assert.equal(err2 && err2.fallback, true);
});

// ---------- 接口 ----------

test('接口：/api/tts/voices 带 month，月度用完时 configured=false 且 exhausted=true', async () => {
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  await withServer(async ({ base, dataDir }) => {
    let r = await req(base, 'GET', '/api/tts/voices');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.month, { used: 0, limit: 500000, stopAt: 450000 });
    assert.equal(r.json.configured, true);
    assert.equal(r.json.exhausted, false);

    fs.writeFileSync(store.usagePath(dataDir), JSON.stringify({
      ts: NOW - 1000, kind: 'tts', playerId: 'p', voice: 'zh-CN-YunxiNeural',
      chars: 450000, cached: false, ms: 1, ok: true,
    }) + '\n');
    r = await req(base, 'GET', '/api/tts/voices');
    assert.equal(r.json.month.used, 450000);
    assert.equal(r.json.configured, false, '月度用完 configured 为 false');
    assert.equal(r.json.exhausted, true);
  }, cfgServer(), { now: () => NOW, ttsFetchImpl: fakeFetch([]) });
});

test('接口：/api/usage/today 返回 tts:{monthUsed,monthLimit,todayChars}', async () => {
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  await withServer(async ({ base, dataDir }) => {
    fs.writeFileSync(store.usagePath(dataDir), JSON.stringify({
      ts: NOW - 1000, kind: 'tts', playerId: 'host', voice: 'zh-CN-YunxiNeural',
      chars: 1234, cached: false, ms: 1, ok: true,
    }) + '\n');
    const r = await req(base, 'GET', '/api/usage/today');
    assert.equal(r.status, 200);
    assert.ok(r.json.tts);
    assert.equal(r.json.tts.monthUsed, 1234);
    assert.equal(r.json.tts.monthLimit, 500000);
    assert.equal(r.json.tts.todayChars, 1234);
  }, cfgServer(), { now: () => NOW, ttsFetchImpl: fakeFetch([]) });
});

test('接口：POST /api/prefs 接受并校验 tts（voice 在 VOICES 里、speed 夹 0.5~2）', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/prefs', {
      tts: { narrator: 'BOGUS', npcVoices: { '小林': 'zh-CN-XiaoxiaoNeural', '坏人': 'BOGUS' }, speed: 9, auto: true },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.prefs.tts.narrator, 'zh-CN-YunxiNeural', '非法音色回退默认');
    assert.equal(r.json.prefs.tts.npcVoices['小林'], 'zh-CN-XiaoxiaoNeural');
    assert.equal(r.json.prefs.tts.npcVoices['坏人'], undefined, '非法 NPC 音色丢弃');
    assert.equal(r.json.prefs.tts.speed, 2, 'speed 夹到 2');
    assert.equal(r.json.prefs.tts.auto, true);
    const me = await req(base, 'GET', '/api/me');
    assert.equal(me.json.prefs.tts.speed, 2, '保存后 /api/me 也读到');
  });
});

// ---------- prefs.tts 直接校验 ----------

test('prefs.tts：默认值、音色校验、speed 夹取、部分更新互不覆盖', (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const d = prefs.getPrefs(dir, 'p1');
  assert.equal(d.tts.narrator, 'zh-CN-YunxiNeural');
  assert.equal(d.tts.speed, 1);
  assert.equal(d.tts.auto, false);
  assert.deepEqual(Object.keys(d.tts.npcDefault).sort(), ['f', 'm', 'old', 'young']);
  const ids = tts.VOICES.map((v) => v.id);
  assert.ok(ids.includes(d.tts.npcDefault.m) && ids.includes(d.tts.npcDefault.old));

  const saved = prefs.setPrefs(dir, 'p1', {
    tts: {
      narrator: 'BOGUS',
      npcDefault: { m: 'zh-CN-YunyangNeural', f: 'BOGUS' },
      speed: 0.1,
      auto: true,
    },
  });
  assert.equal(saved.tts.narrator, 'zh-CN-YunxiNeural');
  assert.equal(saved.tts.npcDefault.m, 'zh-CN-YunyangNeural', '合法 m 生效');
  assert.equal(saved.tts.npcDefault.f, d.tts.npcDefault.f, '非法 f 保持默认');
  assert.equal(saved.tts.speed, 0.5, 'speed 夹到下限 0.5');
  assert.equal(saved.tts.auto, true);

  const partial = prefs.setPrefs(dir, 'p1', { tts: { speed: 9 } });
  assert.equal(partial.tts.speed, 2, 'speed 夹到上限 2');
  assert.equal(partial.tts.auto, true, 'auto 保留');
  assert.equal(partial.tts.narrator, 'zh-CN-YunxiNeural', '旁白保留');

  // 仅改 scenes 时返回形状保持 { scenes }（不影响既有接口断言）。
  const onlyScenes = prefs.setPrefs(dir, 'p1', { scenes: false });
  assert.deepEqual(onlyScenes, { scenes: false });
});
