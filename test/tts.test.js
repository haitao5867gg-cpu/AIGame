'use strict';

// 朗读（第 1 步后端）单测：全部用注入的假 fetch，绝不真的请求 Azure。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const context = require('../src/context.js');
const engine = require('../src/engine.js');
const tts = require('../src/tts.js');
const { withServer, req, asGuest } = require('./helpers/api-helpers.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-tts-'));
}

function cleanup(t, dir) {
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function cfgWith(overrides) {
  return Object.assign({}, env.DEFAULTS, overrides);
}

// 假 fetch：记录 (url, opts)，返回带 arrayBuffer() 的伪 Response，音频内容为固定字节。
function fakeFetch(calls, body) {
  const data = body || Buffer.from('ID3-fake-mp3');
  return async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200, arrayBuffer: async () => data };
  };
}

function noFetch() {
  return async () => { throw new Error('不应请求 Azure'); };
}

function mkTts(dir, overrides, opts) {
  const cfg = cfgWith(Object.assign({ AZURE_SPEECH_KEY: 'k1', AZURE_SPEECH_REGION: 'eastasia' }, overrides || {}));
  return tts.createTts(cfg, dir, opts || {});
}

// ---------- buildSsml ----------

test('buildSsml：XML 转义 <>&；不再强插句末 / 省略号停顿', () => {
  const s = tts.buildSsml({ text: 'A<B&C>"D"。……真的？', voice: 'zh-CN-YunxiNeural' });
  assert.ok(s.includes('A&lt;B&amp;C&gt;&quot;D&quot;。'), '文本需 XML 转义');
  assert.ok(!s.includes('<B'), '原始 < 不能残留');
  assert.ok(!s.includes('<break time="250ms"/>'), '不再在句末强插 250ms');
  assert.ok(!s.includes('<break time="400ms"/>'), '不再在省略号处插 400ms');
  assert.ok(s.includes('<voice name="zh-CN-YunxiNeural">'));
});

test('buildSsml：非法音色回退默认，mood=sad 用 sad 风格且 rate 为负', () => {
  const bad = tts.buildSsml({ text: '他走了。', voice: 'bogus' });
  assert.ok(bad.includes('name="zh-CN-YunxiNeural"'));
  const s = tts.buildSsml({ text: '他走了。', voice: 'zh-CN-YunxiNeural', mood: 'sad' });
  assert.ok(s.includes('mstts:express-as'), 'Yunxi 支持 sad');
  assert.ok(s.includes('style="sad"'));
  assert.match(s, /rate="-\d+%"/, 'sad 的 rate 为负');
});

test('buildSsml：音色不支持该风格时只用 prosody', () => {
  const s = tts.buildSsml({ text: '他走了。', voice: 'zh-CN-XiaoshuangNeural', mood: 'sad' });
  assert.ok(!s.includes('express-as'), '不支持则不加 express-as');
  assert.ok(s.includes('<prosody'));
  assert.match(s, /rate="-\d+%"/, '风格回退但仍带 rate');
});

test('buildSsml：speed 2.0 时 rate 夹到 +100% 上限', () => {
  const s = tts.buildSsml({ text: '走。', voice: 'zh-CN-YunxiNeural', mood: 'joyful', pace: 'fast', speed: 2.0 });
  assert.ok(s.includes('rate="+100%"'));
});

test('buildSsml：pace 叠加到 rate；mysterious 带 pitch -3%', () => {
  const slow = tts.buildSsml({ text: '走。', voice: 'zh-CN-YunxiNeural', mood: 'sad', pace: 'slow' });
  const normal = tts.buildSsml({ text: '走。', voice: 'zh-CN-YunxiNeural', mood: 'sad', pace: 'normal' });
  const fast = tts.buildSsml({ text: '走。', voice: 'zh-CN-YunxiNeural', mood: 'sad', pace: 'fast' });
  assert.ok(slow.includes('rate="-20%"'), 'slow 额外 -10%');
  assert.ok(normal.includes('rate="-10%"'));
  assert.ok(fast.includes('rate="0%"'), 'fast 额外 +10%');
  const my = tts.buildSsml({ text: '……', voice: 'zh-CN-YunxiNeural', mood: 'mysterious' });
  assert.ok(my.includes('pitch="-3%"'));
  assert.ok(my.includes('style="whispering"'));
});

test('VOICES / MOODS 导出结构正确', () => {
  assert.ok(tts.VOICES.length >= 9);
  for (const v of tts.VOICES) {
    assert.equal(typeof v.id, 'string');
    assert.equal(typeof v.name, 'string');
    assert.ok(['m', 'f'].includes(v.gender));
    assert.ok(['child', 'young', 'adult', 'old'].includes(v.age));
    assert.ok(Array.isArray(v.styles));
  }
  assert.deepEqual(Object.keys(tts.MOODS), ['calm', 'tense', 'sad', 'joyful', 'angry', 'mysterious']);
});

// ---------- synth ----------

test('synth：请求头含 Key / 输出格式 / UA，URL 正确，返回 Buffer', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  const audio = await t1.synth({ text: '你好。', voice: 'zh-CN-YunxiNeural' });
  assert.equal(calls.length, 1);
  const h = calls[0].opts.headers;
  assert.equal(h['Ocp-Apim-Subscription-Key'], 'k1');
  assert.equal(h['X-Microsoft-OutputFormat'], 'audio-24khz-48kbitrate-mono-mp3');
  assert.equal(h['Content-Type'], 'application/ssml+xml');
  assert.equal(h['User-Agent'], 'aigame');
  assert.ok(calls[0].url.includes('eastasia.tts.speech.microsoft.com/cognitiveservices/v1'));
  assert.equal(calls[0].opts.method, 'POST');
  assert.ok(calls[0].opts.body.includes('<speak'));
  assert.ok(Buffer.isBuffer(audio));
  assert.equal(audio.toString(), 'ID3-fake-mp3');
});

test('synth：第二次同参数命中缓存不再请求，并记 cached 用量', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  await t1.synth({ text: '同一段叙事。', voice: 'zh-CN-YunxiNeural', mood: 'sad' });
  assert.equal(calls.length, 1);
  await t1.synth({ text: '同一段叙事。', voice: 'zh-CN-YunxiNeural', mood: 'sad' });
  assert.equal(calls.length, 1, '命中缓存不应再请求');
  const rows = store.readJsonl(store.usagePath(dir));
  assert.ok(rows.some((r) => r.kind === 'tts' && r.cached === true && r.chars === 0));
});

test('synth：未配置 Key/Region 抛 503，且不访问网络', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const t1 = mkTts(dir, { AZURE_SPEECH_KEY: '', AZURE_SPEECH_REGION: '' }, { fetchImpl: noFetch(), now: () => 1000 });
  let err;
  try { await t1.synth({ text: '你好。' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 503);
  assert.equal(err && err.message, '朗读服务未配置');
});

test('synth：来客超出每日字符上限 429，主人 host 不限', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const FIXED = Date.UTC(2026, 5, 15, 4, 0, 0);
  const calls = [];
  const t1 = mkTts(dir, { TTS_PLAYER_DAILY_CHARS: '5' }, { fetchImpl: fakeFetch(calls), now: () => FIXED });
  fs.writeFileSync(store.usagePath(dir), JSON.stringify({
    ts: FIXED - 1000, kind: 'tts', playerId: 'guest1', voice: 'zh-CN-YunxiNeural',
    chars: 10, cached: false, ms: 1, ok: true,
  }) + '\n');
  let err;
  try { await t1.synth({ text: '你好世界', playerId: 'guest1' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 429);
  assert.equal(calls.length, 0, '超限不应请求 Azure');
  const audio = await t1.synth({ text: '你好世界', playerId: 'host' });
  assert.ok(Buffer.isBuffer(audio), '主人不受限');
  assert.equal(calls.length, 1);
});

test('synth：缓存超上限删最旧文件，保留本轮新缓存', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const ttsDir = path.join(dir, 'tts');
  fs.mkdirSync(ttsDir, { recursive: true });
  const MB = 1024 * 1024;
  const calls = [];
  const t1 = mkTts(dir, { TTS_CACHE_MAX_MB: 250 / MB },
    { fetchImpl: fakeFetch(calls, Buffer.alloc(20, 1)), now: () => 5000 });
  const old = path.join(ttsDir, 'old.mp3');
  const mid = path.join(ttsDir, 'mid.mp3');
  fs.writeFileSync(old, Buffer.alloc(200, 2));
  fs.writeFileSync(mid, Buffer.alloc(200, 3));
  fs.utimesSync(old, 1000, 1000);
  fs.utimesSync(mid, 2000, 2000);
  await t1.synth({ text: '触发清理。' });
  assert.equal(fs.existsSync(old), false, '最旧文件应被删');
  const mp3s = fs.readdirSync(ttsDir).filter((n) => n.endsWith('.mp3'));
  assert.ok(mp3s.length >= 1, '本轮新缓存应保留');
});

test('synth：成功后记 kind=tts 用量，playerId 由 context 自动补', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  await context.run({ playerId: 'guestX' }, () =>
    t1.synth({ text: '记一笔。', voice: 'zh-CN-XiaoxiaoNeural', mood: 'joyful' }));
  const rows = store.readJsonl(store.usagePath(dir)).filter((r) => r.kind === 'tts');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cached, false);
  assert.equal(rows[0].ok, true);
  assert.equal(rows[0].voice, 'zh-CN-XiaoxiaoNeural');
  assert.ok(rows[0].chars > 0);
  assert.equal(rows[0].playerId, 'guestX', 'playerId 由 context 补上');
});

// ---------- 接口 ----------

test('接口：POST /api/tts 返回 audio/mpeg；未登录来客 401', async () => {
  const calls = [];
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/tts', { text: '你好，世界。' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.headers.get('content-type'), /audio\/mpeg/);
    assert.match(r.headers.get('cache-control') || '', /max-age=86400/);
    assert.equal(calls.length, 1);
    const g = await req(base, 'POST', '/api/tts', { text: '你好。' }, asGuest());
    assert.equal(g.status, 401);
  }, { AZURE_SPEECH_KEY: 'k1', AZURE_SPEECH_REGION: 'eastasia' }, { ttsFetchImpl: fakeFetch(calls) });
});

test('接口：未配置时 POST /api/tts 按 status 返回 JSON 503', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'POST', '/api/tts', { text: '你好。' });
    assert.equal(r.status, 503);
    assert.equal(r.json.error, '朗读服务未配置');
  }, { AZURE_SPEECH_KEY: '', AZURE_SPEECH_REGION: '' }, { ttsFetchImpl: noFetch() });
});

test('接口：GET /api/tts/voices configured 正确且不含任何 Key', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'GET', '/api/tts/voices');
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, true);
    assert.ok(Array.isArray(r.json.voices));
    assert.ok(r.json.voices.some((v) => v.id === 'zh-CN-YunxiNeural'));
    assert.ok(r.json.moods.includes('calm'));
    assert.ok(r.json.moods.includes('mysterious'));
    assert.equal(r.text.includes('TTS_FAKE_SECRET_12345'), false, '响应绝不泄露 Key');
  }, { AZURE_SPEECH_KEY: 'TTS_FAKE_SECRET_12345', AZURE_SPEECH_REGION: 'eastasia' },
  { ttsFetchImpl: noFetch() });
});

test('接口：GET /api/tts/voices 未配置时 configured=false', async () => {
  await withServer(async ({ base }) => {
    const r = await req(base, 'GET', '/api/tts/voices');
    assert.equal(r.status, 200);
    assert.equal(r.json.configured, false);
  }, { AZURE_SPEECH_KEY: '', AZURE_SPEECH_REGION: '' }, { ttsFetchImpl: noFetch() });
});

// ---------- 回合模型 voice_hints ----------

function makeState() {
  return engine.createWorld(
    {
      id: 'w1', seed: '一句世界观', name: '旅人', appearance: '青衣',
      bible: {
        title: '测试世界', tone: '苍凉', rules: [], places: [], factions: [],
        npcs: [{ name: '长老', role: '导师', desc: '' }],
        start: { place: '村口', situation: '' },
        eventThemes: ['魔族入侵', '宫廷政变', '天灾', '秘境开启', '商路断绝', '古神低语'],
      },
      apex: { title: '隐秘王冠', hint: '北方的钟声', condition: { attrs: { 声望: 30 } } },
    },
    { rng: () => 0.5, now: 1000 },
  );
}

function proposal(overrides) {
  return Object.assign({
    narration: '你在晨雾中醒来，远处传来钟声，于是决定沿着古道继续前行。',
    state_diff: {}, items_add: [], items_remove: [], npc_attitude: {},
    persona_tags: [], suggestions: ['继续前行', '询问长老', '查看行囊'],
  }, overrides || {});
}

test('normalizeVoiceHints：坏数据处理，缺省 calm/normal，最多 8 条', () => {
  const f = engine.normalizeVoiceHints;
  assert.deepEqual(f(null), []);
  assert.deepEqual(f('x'), []);
  assert.deepEqual(f([null, 1, 'a', [], {}]), []);
  assert.deepEqual(f([
    { para: 0, mood: 'tense', pace: 'fast', speaker: '  小林  ' },
    { para: 1, mood: 'BOGUS', pace: 'BOGUS', speaker: 123 },
    { para: -1, mood: 'sad' },
    { para: 2.5, mood: 'sad' },
  ]), [
    { para: 0, mood: 'tense', pace: 'fast', speaker: '小林' },
    { para: 1, mood: 'calm', pace: 'normal' },
  ]);
  assert.deepEqual(f([{ para: 3 }]), [{ para: 3, mood: 'calm', pace: 'normal' }]);
  const many = Array.from({ length: 12 }, (_, i) => ({ para: i, mood: 'calm' }));
  assert.equal(f(many).length, 8);
});

test('resolveTurn：voice_hints 进公开回合结果；坏数据/缺失不影响回合', () => {
  const good = engine.resolveTurn(makeState(), {
    action: '前行',
    proposal: proposal({ voice_hints: [
      { para: 0, mood: 'tense', pace: 'fast', speaker: '长老' },
      { para: 1, mood: 'BOGUS' },
    ] }),
  }, { rng: () => 0.5, now: 1 });
  assert.equal(good.invalid, false);
  assert.deepEqual(good.result.voice_hints, [
    { para: 0, mood: 'tense', pace: 'fast', speaker: '长老' },
    { para: 1, mood: 'calm', pace: 'normal' },
  ]);
  const pub = engine.toPublicTurnResult(good.result, good.state);
  assert.deepEqual(pub.voice_hints, good.result.voice_hints);

  const bad = engine.resolveTurn(makeState(), {
    action: '前行', proposal: proposal({ voice_hints: 'not-an-array' }),
  }, { rng: () => 0.5, now: 1 });
  assert.equal(bad.invalid, false, '坏数据不能让回合失效');
  assert.deepEqual(bad.result.voice_hints, []);

  const missing = engine.resolveTurn(makeState(), { action: '前行', proposal: proposal() },
    { rng: () => 0.5, now: 1 });
  assert.equal(missing.invalid, false);
  assert.deepEqual(missing.result.voice_hints, []);
});

test('接口：mock 回合结果与 log 记录都带 voice_hints', async () => {
  await withServer(async ({ base }) => {
    const w = await req(base, 'POST', '/api/worlds', { seed: '雾中钟楼', name: '旅人', appearance: '灰袍' });
    assert.equal(w.status, 201, w.text);
    const id = w.json.id;
    const turn = await req(base, 'POST', `/api/worlds/${id}/turn`, { action: '前行' });
    assert.equal(turn.status, 200, turn.text);
    assert.ok(Array.isArray(turn.json.voice_hints));
    assert.ok(turn.json.voice_hints.length >= 1);
    const moods = ['calm', 'tense', 'sad', 'joyful', 'angry', 'mysterious'];
    const paces = ['slow', 'normal', 'fast'];
    assert.ok(turn.json.voice_hints.every((h) => moods.includes(h.mood)));
    assert.ok(turn.json.voice_hints.every((h) => paces.includes(h.pace)));
    assert.ok(turn.json.voice_hints.some((h) => typeof h.speaker === 'string'), '台词段带 speaker');
    const log = await req(base, 'GET', `/api/worlds/${id}/log?limit=50`);
    assert.equal(log.status, 200);
    assert.ok(Array.isArray(log.json));
    assert.ok(log.json.some((rec) => Array.isArray(rec.voice_hints) && rec.voice_hints.length >= 1),
      'toPublicLogRecord 也带 voice_hints');
  });
});
