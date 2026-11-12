'use strict';

// 任务A：每玩家氛围偏好（src/prefs.js）。
// 固定形状、非法校验、音量边界、部分 merge 不擦原字段、玩家隔离、GET/POST 响应形状。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const prefs = require('../src/prefs.js');
const { withServer, req } = require('./helpers/api-helpers.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-atm-'));
}
function cleanup(t, dir) {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('GET prefs：atmosphere 始终附完整归一化默认对象（含旧存档 / 脏数据）', (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const d = prefs.getPrefs(dir, 'host');
  assert.deepEqual(d.atmosphere, prefs.DEFAULT_ATMOSPHERE);
  assert.equal(d.atmosphere.enabled, false, '首次安静');
  assert.equal(d.atmosphere.mode, 'auto');
  assert.equal(d.scenes, true, '原 scenes 语义保留');
  assert.equal(typeof d.tts, 'object', '原 tts 语义保留');
  assert.equal(d.adult, false, '原 adult 语义保留');

  // 直接写脏存档：读取时仍归一化为完整合法对象，缺省取默认
  fs.writeFileSync(prefs.prefsPath(dir), JSON.stringify({
    host: { atmosphere: { background: 'yes', enabled: 1, musicVolume: 'loud', mode: 'BOGUS' } },
  }));
  assert.deepEqual(prefs.getPrefs(dir, 'host').atmosphere, prefs.DEFAULT_ATMOSPHERE);
});

test('normalizeAtmosphere / mergeAtmosphere：非法类型、音量边界、mode、原型键', () => {
  assert.deepEqual(prefs.normalizeAtmosphere(null), prefs.DEFAULT_ATMOSPHERE);
  assert.deepEqual(prefs.normalizeAtmosphere([]), prefs.DEFAULT_ATMOSPHERE);
  assert.deepEqual(prefs.normalizeAtmosphere({
    background: 'true', enabled: 1, musicVolume: NaN, ambienceVolume: Infinity, mode: 'constructor',
  }), prefs.DEFAULT_ATMOSPHERE, '非法全部回默认，constructor 不当合法 mode');
  assert.equal(prefs.normalizeAtmosphere({ mode: '__proto__' }).mode, 'auto');
  assert.equal(prefs.normalizeAtmosphere({ musicVolume: 0 }).musicVolume, 0, '0 合法');
  assert.equal(prefs.normalizeAtmosphere({ ambienceVolume: 0 }).ambienceVolume, 0);
  assert.equal(prefs.normalizeAtmosphere({ musicVolume: -1 }).musicVolume, 0);
  assert.equal(prefs.normalizeAtmosphere({ musicVolume: 2 }).musicVolume, 1);
  assert.equal(prefs.normalizeAtmosphere({ musicVolume: '0.5' }).musicVolume,
    prefs.DEFAULT_ATMOSPHERE.musicVolume, '字符串不合法');

  const cur = prefs.normalizeAtmosphere({ enabled: true, mode: 'tense', musicVolume: 0.4 });
  // 非法部分保留当前值，缺省取当前值
  assert.deepEqual(prefs.mergeAtmosphere(cur, { ambienceVolume: 0.2 }), {
    background: true, enabled: true, musicVolume: 0.4, ambienceVolume: 0.2, mode: 'tense', reading: 'auto',
  });
  assert.equal(prefs.mergeAtmosphere(cur, { musicVolume: 'loud' }).musicVolume, 0.4, '非法保留当前');
  assert.equal(prefs.mergeAtmosphere(cur, { mode: 'BOGUS' }).mode, 'tense', '非法保留当前');
  assert.equal(prefs.mergeAtmosphere(cur, NaN).musicVolume, 0.4);
});

test('setPrefs：部分 merge、非法保留当前、音量 0/NaN、不擦 tts/scenes/adult', (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  // 先存好原偏好
  prefs.setPrefs(dir, 'pA', {
    scenes: false,
    tts: { speed: 1.7 },
    adult: true, confirm18: true,
  });

  const out = prefs.setPrefs(dir, 'pA', { atmosphere: { enabled: true, musicVolume: 0.4, mode: 'tense' } });
  assert.deepEqual(out.atmosphere, {
    background: true, enabled: true, musicVolume: 0.4, ambienceVolume: 0.10, mode: 'tense', reading: 'auto',
  });
  const got = prefs.getPrefs(dir, 'pA');
  assert.deepEqual(got.atmosphere, out.atmosphere, 'GET 读到同一归一化对象');
  assert.equal(got.scenes, false, '不擦 scenes');
  assert.equal(got.tts.speed, 1.7, '不擦 tts');
  assert.equal(got.adult, true, '不擦 adult');

  // 部分 merge：只改一个字段，其它 atmosphere 字段保留
  const p2 = prefs.setPrefs(dir, 'pA', { atmosphere: { mode: 'calm' } });
  assert.equal(p2.atmosphere.mode, 'calm');
  assert.equal(p2.atmosphere.enabled, true);
  assert.equal(p2.atmosphere.musicVolume, 0.4);
  // 非法部分保留当前值
  const p3 = prefs.setPrefs(dir, 'pA', { atmosphere: { musicVolume: 'loud', mode: 'BOGUS', enabled: 1 } });
  assert.equal(p3.atmosphere.musicVolume, 0.4);
  assert.equal(p3.atmosphere.mode, 'calm');
  assert.equal(p3.atmosphere.enabled, true);
  // 音量 0 合法、NaN 保留当前
  assert.equal(prefs.setPrefs(dir, 'pA', { atmosphere: { musicVolume: 0 } }).atmosphere.musicVolume, 0);
  assert.equal(prefs.setPrefs(dir, 'pA', { atmosphere: { musicVolume: NaN } }).atmosphere.musicVolume, 0);
});

test('setPrefs：玩家隔离——改 A 的 atmosphere 不影响 B / 其它字段', (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  prefs.setPrefs(dir, 'pA', { atmosphere: { enabled: true, mode: 'explore', musicVolume: 0.9 } });
  assert.equal(prefs.getPrefs(dir, 'pB').atmosphere.enabled, false, 'B 不受影响');
  assert.deepEqual(prefs.getPrefs(dir, 'pB').atmosphere, prefs.DEFAULT_ATMOSPHERE);
  assert.equal(prefs.getPrefs(dir, 'pA').atmosphere.mode, 'explore');
  // B 独立改
  prefs.setPrefs(dir, 'pB', { atmosphere: { mode: 'tense' } });
  assert.equal(prefs.getPrefs(dir, 'pB').atmosphere.mode, 'tense');
  assert.equal(prefs.getPrefs(dir, 'pA').atmosphere.mode, 'explore', 'A 不被 B 覆盖');
  assert.equal(prefs.getPrefs(dir, 'pA').atmosphere.musicVolume, 0.9);
});

test('setPrefs：legacy 响应形状不变——未提交 atmosphere 时不附新字段', (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  assert.deepEqual(prefs.setPrefs(dir, 'pX', { scenes: false }), { scenes: false });
  const ttsOut = prefs.setPrefs(dir, 'pX', { tts: { speed: 1.5 } });
  assert.equal(ttsOut.tts.speed, 1.5);
  assert.equal(Object.prototype.hasOwnProperty.call(ttsOut, 'atmosphere'), false);
  const adultOut = prefs.setPrefs(dir, 'pX', { adult: true, confirm18: true });
  assert.equal(adultOut.adult, true);
  assert.equal(Object.prototype.hasOwnProperty.call(adultOut, 'atmosphere'), false);
  // 只有提交 atmosphere 才在原有响应附它
  const aOut = prefs.setPrefs(dir, 'pX', { atmosphere: { enabled: true } });
  assert.equal(aOut.scenes, false);
  assert.deepEqual(aOut.atmosphere, prefs.getPrefs(dir, 'pX').atmosphere);
});

test('接口：GET /api/me 附完整默认；POST /api/prefs 仅提交 atmosphere 才附新字段', async () => {
  await withServer(async ({ base }) => {
    let me = await req(base, 'GET', '/api/me');
    assert.equal(me.status, 200);
    assert.deepEqual(me.json.prefs.atmosphere, prefs.DEFAULT_ATMOSPHERE);

    // 旧 POST：只提交 scenes → 响应形状不变（不附 atmosphere）
    let r = await req(base, 'POST', '/api/prefs', { scenes: false });
    assert.deepEqual(r.json, { prefs: { scenes: false } });
    // 旧 POST：只提交 tts → 不附 atmosphere
    r = await req(base, 'POST', '/api/prefs', { tts: { speed: 1.5 } });
    assert.equal(r.json.prefs.tts.speed, 1.5);
    assert.equal(Object.prototype.hasOwnProperty.call(r.json.prefs, 'atmosphere'), false);
    // 提交 atmosphere → 在原有响应附它
    r = await req(base, 'POST', '/api/prefs', { atmosphere: { mode: 'calm', musicVolume: 0.3 } });
    assert.deepEqual(r.json.prefs.atmosphere, {
      background: true, enabled: false, musicVolume: 0.3, ambienceVolume: 0.10, mode: 'calm', reading: 'auto',
    });
    me = await req(base, 'GET', '/api/me');
    assert.equal(me.json.prefs.atmosphere.mode, 'calm', 'GET 读到已保存值');
  });
});

test('setPrefs / normalizeAtmosphere：reading 合法值保存、非法保留、部分更新隔离、旧存档回 auto', (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  assert.equal(prefs.DEFAULT_ATMOSPHERE.reading, 'auto');
  assert.equal(prefs.getPrefs(dir, 'host').atmosphere.reading, 'auto', '缺省 auto');
  // 合法值逐个生效并持久化
  for (const r of ['auto', 'paper', 'night']) {
    assert.equal(prefs.normalizeAtmosphere({ reading: r }).reading, r);
    assert.equal(prefs.setPrefs(dir, 'host', { atmosphere: { reading: r } }).atmosphere.reading, r);
    assert.equal(prefs.getPrefs(dir, 'host').atmosphere.reading, r, 'GET 读到 ' + r);
  }
  // 非法值（含字符串 / 数字 / null）保留原值
  prefs.setPrefs(dir, 'host', { atmosphere: { reading: 'paper' } });
  for (const bad of ['bright', 1, null]) {
    assert.equal(prefs.normalizeAtmosphere({ reading: bad }, { reading: 'night' }).reading, 'night');
    assert.equal(prefs.setPrefs(dir, 'host', { atmosphere: { reading: bad } }).atmosphere.reading, 'paper',
      '非法 ' + String(bad) + ' 保留当前 paper');
  }
  // 部分更新只改 reading，不动其它字段
  prefs.setPrefs(dir, 'host', { atmosphere: { enabled: true, musicVolume: 0.42, mode: 'tense', background: false } });
  const out = prefs.setPrefs(dir, 'host', { atmosphere: { reading: 'night' } }).atmosphere;
  assert.equal(out.reading, 'night');
  assert.equal(out.enabled, true);
  assert.equal(out.musicVolume, 0.42);
  assert.equal(out.mode, 'tense');
  assert.equal(out.background, false);
  // 旧存档缺 reading → 读出 auto，且不影响其它玩家
  const all = JSON.parse(fs.readFileSync(prefs.prefsPath(dir), 'utf8'));
  all.legacy = { atmosphere: { mode: 'calm', musicVolume: 0.3 } };
  fs.writeFileSync(prefs.prefsPath(dir), JSON.stringify(all));
  assert.equal(prefs.getPrefs(dir, 'legacy').atmosphere.reading, 'auto', '旧存档缺 reading 回 auto');
  assert.equal(prefs.getPrefs(dir, 'legacy').atmosphere.mode, 'calm');
  assert.equal(prefs.getPrefs(dir, 'host').atmosphere.reading, 'night', '其它玩家不受影响');
});
