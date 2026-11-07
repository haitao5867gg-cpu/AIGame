'use strict';

// 朗读「自然度」改造：buildSsml 去停顿 / calm 用 narration-relaxed /
// segments 合并成一个 SSML / 限额 / 额度按总字数 / 缓存命中 / 前端按组请求。
// 全部用注入的假 fetch，绝不真的请求 Azure。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');
const store = require('../src/store.js');
const tts = require('../src/tts.js');
const { withServer, req } = require('./helpers/api-helpers.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-ttsn-'));
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
function cfgServer(o) {
  return Object.assign({
    AZURE_SPEECH_KEY: 'k1', AZURE_SPEECH_REGION: 'eastasia',
    TTS_MONTHLY_CHARS: 500000, TTS_MONTHLY_STOP_AT: 450000,
  }, o || {});
}
function ssmlOf(calls) {
  return calls[0].opts.body;
}

// ---------- buildSsml：去强插停顿 / calm 风格 ----------

test('buildSsml：不再含句末 250ms / 省略号 400ms 强插停顿', () => {
  const s = tts.buildSsml({ text: '他走了。真的？太好了！……嗯。', voice: 'zh-CN-YunxiNeural' });
  assert.ok(!s.includes('250ms'), '不再有 250ms');
  assert.ok(!s.includes('400ms'), '不再有 400ms');
  assert.ok(!s.includes('<break'), '单段 SSML 不含任何人为停顿');
  assert.ok(s.includes('他走了。真的？太好了！……嗯。'), '标点与省略号原样保留、让音色自己断句');
});

test('buildSsml：calm / 缺省 mood 的云希旁白用 narration-relaxed；不支持的音色不加', () => {
  const yunxi = tts.buildSsml({ text: '平静的旁白。', voice: 'zh-CN-YunxiNeural' });
  assert.ok(yunxi.includes('style="narration-relaxed"'), '缺省 mood 用 narration-relaxed');
  const calm = tts.buildSsml({ text: '平静的旁白。', voice: 'zh-CN-YunxiNeural', mood: 'calm' });
  assert.ok(calm.includes('style="narration-relaxed"'), '显式 calm 用 narration-relaxed');
  const yunjian = tts.buildSsml({ text: '平静的旁白。', voice: 'zh-CN-YunjianNeural', mood: 'calm' });
  assert.ok(yunjian.includes('style="narration-relaxed"'), '云健同样支持');
  const other = tts.buildSsml({ text: '平静的旁白。', voice: 'zh-CN-XiaoshuangNeural' });
  assert.ok(!other.includes('express-as'), '不确定支持的音色不加 express-as');
  assert.ok(other.includes('<prosody'), '回退到纯 prosody');
  const sad = tts.buildSsml({ text: '平静的旁白。', voice: 'zh-CN-YunxiNeural', mood: 'sad' });
  assert.ok(sad.includes('style="sad"'), '其他 mood 映射照旧');
  assert.ok(!sad.includes('narration-relaxed'), '其他 mood 不叠加 narration-relaxed');
});

// ---------- segments 合成一个 SSML ----------

test('segments：拼成一个 SSML；连续同 voice 共用一个 <voice>，换说话人另起 <voice>，段间 350ms', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  await t1.synth({ segments: [
    { text: '第一段。', voice: 'zh-CN-YunxiNeural', mood: 'calm' },
    { text: '第二段。', voice: 'zh-CN-YunxiNeural', mood: 'sad' },
    { text: '第三段。', voice: 'zh-CN-XiaoxiaoNeural', mood: 'joyful' },
  ] });
  assert.equal(calls.length, 1, '整组只请求一次 Azure');
  const s = ssmlOf(calls);
  assert.equal((s.match(/<speak/g) || []).length, 1, '只有一个 <speak>');
  assert.equal((s.match(/<voice /g) || []).length, 2, '前两段云希合并、第三段晓晓另起，共 2 个 <voice>');
  assert.ok(s.includes('<voice name="zh-CN-YunxiNeural">'));
  assert.ok(s.includes('<voice name="zh-CN-XiaoxiaoNeural">'));
  assert.equal((s.match(/<break time="350ms"\/>/g) || []).length, 2, '3 段之间有 2 个 350ms 段间停顿');
  assert.ok(!s.includes('250ms') && !s.includes('400ms'), '不含旧强插停顿');
  assert.equal((s.match(/<prosody/g) || []).length, 3, '每段各自 prosody');
  assert.ok(s.includes('style="narration-relaxed"') && s.includes('style="sad"') && s.includes('style="cheerful"'),
    '每段各自的 express-as 风格');
});

test('segments：换说话人换 <voice>（交替音色时每段一个 <voice>）', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  await t1.synth({ segments: [
    { text: '甲。', voice: 'zh-CN-YunxiNeural', mood: 'tense' },
    { text: '乙。', voice: 'zh-CN-XiaoxiaoNeural', mood: 'sad' },
    { text: '丙。', voice: 'zh-CN-YunxiNeural', mood: 'joyful' },
  ] });
  const s = ssmlOf(calls);
  assert.equal((s.match(/<voice /g) || []).length, 3, '三段音色交替 → 3 个 <voice>');
  assert.equal((s.match(/<break time="350ms"\/>/g) || []).length, 2, '段间仍是 2 个 350ms');
});

// ---------- 限额：超 6 段 / 超 600 字 返回 400 ----------

test('segments：超过 6 段或总字数超过 600 返回 400，且不请求 Azure', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  const seven = Array.from({ length: 7 }, (_, i) => ({ text: '段' + i, voice: 'zh-CN-YunxiNeural' }));
  let e1;
  try { await t1.synth({ segments: seven }); } catch (e) { e1 = e; }
  assert.equal(e1 && e1.status, 400, '7 段 → 400');
  const long = [
    { text: '字'.repeat(250), voice: 'zh-CN-YunxiNeural' },
    { text: '字'.repeat(250), voice: 'zh-CN-YunxiNeural' },
    { text: '字'.repeat(250), voice: 'zh-CN-YunxiNeural' },
  ]; // 总字数 750 > 600
  let e2;
  try { await t1.synth({ segments: long }); } catch (e) { e2 = e; }
  assert.equal(e2 && e2.status, 400, '总字数 750 → 400');
  assert.equal(calls.length, 0, '不合规请求不访问 Azure');
});

test('接口：POST /api/tts 的 segments 超 6 段 / 超 600 字返回 400；合规组合成一次 200', async () => {
  const calls = [];
  await withServer(async ({ base }) => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ text: '段' + i, voice: 'zh-CN-YunxiNeural' }));
    let r = await req(base, 'POST', '/api/tts', { segments: seven });
    assert.equal(r.status, 400, '7 段返回 400');
    const long = [
      { text: '字'.repeat(250), voice: 'zh-CN-YunxiNeural' },
      { text: '字'.repeat(250), voice: 'zh-CN-YunxiNeural' },
      { text: '字'.repeat(250), voice: 'zh-CN-YunxiNeural' },
    ];
    r = await req(base, 'POST', '/api/tts', { segments: long });
    assert.equal(r.status, 400, '超 600 字返回 400');
    r = await req(base, 'POST', '/api/tts', { segments: [
      { text: '第一句。', voice: 'zh-CN-YunxiNeural' },
      { text: '第二句。', voice: 'zh-CN-XiaoxiaoNeural' },
    ] });
    assert.equal(r.status, 200, '合规 segments 合成成功');
  }, cfgServer(), { now: () => 1000, ttsFetchImpl: fakeFetch(calls) });
  assert.equal(calls.length, 1, '仅合规请求访问一次 Azure');
  assert.ok(calls[0].opts.body.includes('<speak'), '服务端拼成 SSML 发给 Azure');
  assert.equal((calls[0].opts.body.match(/<voice /g) || []).length, 2, '换说话人换 <voice>');
});

// ---------- 额度按总字数 ----------

test('segments：每日额度按整组总字数计算（而非首段）', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  const calls = [];
  const t1 = mkTts(dir, { TTS_PLAYER_DAILY_CHARS: 25 }, { fetchImpl: fakeFetch(calls), now: () => NOW });
  const segs = [
    { text: '甲'.repeat(10), voice: 'zh-CN-YunxiNeural' },
    { text: '乙'.repeat(10), voice: 'zh-CN-YunxiNeural' },
    { text: '丙'.repeat(10), voice: 'zh-CN-YunxiNeural' },
  ]; // 共 30 字
  let err;
  try { await t1.synth({ segments: segs, playerId: 'g' }); } catch (e) { err = e; }
  assert.equal(err && err.status, 429, '总字数 30 > 每日 25 → 429');
  const single = await t1.synth({ segments: [{ text: '甲'.repeat(10), voice: 'zh-CN-YunxiNeural' }], playerId: 'g' });
  assert.ok(Buffer.isBuffer(single), '单段 10 字不超限');
  assert.equal(calls.length, 1, '只有合规请求访问 Azure');
});

test('segments：字数统计与月度额度按整组总字数记', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const NOW = Date.UTC(2026, 5, 15, 4, 0, 0);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => NOW });
  await t1.synth({ segments: [
    { text: '甲'.repeat(10), voice: 'zh-CN-YunxiNeural' },
    { text: '乙'.repeat(20), voice: 'zh-CN-YunxiNeural' },
  ], playerId: 'g' }); // 共 30 字
  const rows = store.readJsonl(store.usagePath(dir)).filter((r) => r.kind === 'tts');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chars, 30, '用量记录按总字数 30');
  assert.equal(t1.monthUsage().used, 30, '本月已用按总字数累计 30');
});

// ---------- 缓存命中 ----------

test('segments：缓存 key 按整组参数，命中不再请求 Azure', async (t) => {
  const dir = tmpDir(); cleanup(t, dir);
  const calls = [];
  const t1 = mkTts(dir, {}, { fetchImpl: fakeFetch(calls), now: () => 1000 });
  const a = { text: '第一段。', voice: 'zh-CN-YunxiNeural', mood: 'calm' };
  const b = { text: '第二段。', voice: 'zh-CN-XiaoxiaoNeural', mood: 'sad' };
  const b2 = { text: '第二段变了。', voice: 'zh-CN-XiaoxiaoNeural', mood: 'sad' };
  const audio1 = await t1.synth({ segments: [a, b] });
  assert.equal(calls.length, 1);
  const audio2 = await t1.synth({ segments: [a, b] });
  assert.equal(calls.length, 1, '同整组参数命中缓存');
  assert.ok(Buffer.isBuffer(audio2) && audio2.equals(audio1), '返回同一段音频');
  const rows = store.readJsonl(store.usagePath(dir)).filter((r) => r.kind === 'tts');
  assert.ok(rows.some((r) => r.cached === true && r.chars === 0), '记一条 cached 用量');
  await t1.synth({ segments: [a, b2] });
  assert.equal(calls.length, 2, '任一段参数变化即视为不同组，重新请求');
});

// ---------- 前端静态检查 ----------

test('前端静态：整回合按组请求 segments，组 ≤3 段 / ≤300 字，预取下一组', () => {
  const root = path.join(__dirname, '..', 'public');
  const src = fs.readFileSync(path.join(root, 'js', 'tts.js'), 'utf8');
  assert.ok(/GROUP_MAX_SEGS\s*=\s*3/.test(src), '每组最多 3 段');
  assert.ok(/GROUP_MAX_CHARS\s*=\s*300/.test(src), '每组最多 300 字');
  assert.ok(/cur\.segs\.length\s*>=\s*GROUP_MAX_SEGS/.test(src), '按段数切组');
  assert.ok(/cur\.total\s*\+\s*n\s*>\s*GROUP_MAX_CHARS/.test(src), '按字数切组');
  assert.ok(/segments:\s*group\.segs/.test(src), '请求 body 传 segments 组');
  assert.ok(src.includes('function fetchGroupBlob'), '有按组取音频的函数');
  assert.ok(/sess\.groups\[sess\.gi\]/.test(src), 'playCurrent 取当前组');
  assert.ok(/prefetchNext\(sess\)/.test(src) && /sess\.gi\s*\+\s*1/.test(src), '预取下一组');
  assert.ok(/sess\.prefetch\.gi/.test(src), '预取按组索引命中');
  assert.ok(/audio\.ontimeupdate/.test(src) && /group\.chars\[k\]/.test(src), '组内按字数比例估算时间点切换高亮');
  assert.ok(/kind:\s*'browser'/.test(src), '成人段单独走浏览器朗读');
});
