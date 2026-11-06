'use strict';

// 朗读（Azure 语音服务）：把叙事合成语音。只用 node 内置模块；
// 网络请求可经 opts.fetchImpl 注入，测试用假 fetch，绝不真的连 Azure。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store.js');

const DEFAULT_VOICE = 'zh-CN-YunxiNeural';
const CACHE_DIR_NAME = 'tts';
const MB = 1024 * 1024;
const TEXT_MAX_CHARS = 600; // 合成文本去空白后最多 600 字

// 音色表：旁白与 NPC 都从这里选。styles 只列确定 Azure 支持的情感风格；
// 拿不准的少填，合成时若所选风格不在列表里会自动回退到纯 prosody。
const VOICES = Object.freeze([
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'm', age: 'young', styles: ['cheerful', 'sad', 'angry', 'fearful', 'serious', 'whispering'] },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'f', age: 'young', styles: ['cheerful', 'sad', 'angry', 'fearful', 'gentle', 'affectionate'] },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'm', age: 'adult', styles: ['cheerful', 'sad', 'angry', 'serious'] },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'f', age: 'young', styles: ['cheerful', 'sad', 'angry', 'fearful'] },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'm', age: 'adult', styles: ['serious'] },
  { id: 'zh-CN-XiaochenNeural', name: '晓辰', gender: 'f', age: 'young', styles: ['cheerful', 'sad'] },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'm', age: 'child', styles: ['cheerful', 'sad', 'angry'] },
  { id: 'zh-CN-XiaoshuangNeural', name: '晓双', gender: 'f', age: 'child', styles: ['cheerful'] },
  { id: 'zh-CN-YunyeNeural', name: '云野', gender: 'm', age: 'adult', styles: ['cheerful', 'sad', 'angry'] },
]);
const VOICE_MAP = Object.freeze(Object.fromEntries(VOICES.map((v) => [v.id, v])));

// mood → 情感风格 + 语速增量（rate%，百分比）+ 音高增量（pitch%）。
// calm 不用风格；mysterious 的 whispering 不支持时回退 prosody（rate -8% / pitch -3%）。
const MOODS = Object.freeze({
  calm: { style: null, rate: 0, pitch: 0 },
  tense: { style: 'fearful', rate: 5, pitch: 0 },
  sad: { style: 'sad', rate: -10, pitch: 0 },
  joyful: { style: 'cheerful', rate: 5, pitch: 0 },
  angry: { style: 'angry', rate: 5, pitch: 0 },
  mysterious: { style: 'whispering', rate: -8, pitch: -3 },
});
const MOOD_KEYS = Object.freeze(Object.keys(MOODS));

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function cleanText(text) {
  return String(text == null ? '' : text).trim().slice(0, TEXT_MAX_CHARS);
}

function normalizeParams(p) {
  const src = p || {};
  const voice = VOICE_MAP[src.voice] ? src.voice : DEFAULT_VOICE;
  const mood = MOOD_KEYS.includes(src.mood) ? src.mood : 'calm';
  const pace = (src.pace === 'slow' || src.pace === 'fast') ? src.pace : 'normal';
  let speed = Number(src.speed);
  if (!Number.isFinite(speed)) speed = 1;
  speed = clamp(speed, 0.5, 2.0);
  return { voice, mood, pace, speed };
}

// 计算最终 prosody：mood 的 rate + pace 增减，再乘上玩家语速 speed；
// 结果换算成百分比并夹在 -50%~+100%。风格音色不支持时置 null（只用 prosody）。
function prosodyFor(np) {
  const m = MOODS[np.mood];
  const paceExtra = np.pace === 'slow' ? -10 : np.pace === 'fast' ? 10 : 0;
  const basePct = m.rate + paceExtra;
  const factor = (1 + basePct / 100) * np.speed;
  const ratePct = Math.round(clamp((factor - 1) * 100, -50, 100));
  const style = (m.style && VOICE_MAP[np.voice].styles.includes(m.style)) ? m.style : null;
  return { ratePct, pitchPct: m.pitch, style };
}

function fmtPct(n) {
  return `${n > 0 ? '+' : ''}${n}%`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// 句末（。？！ / ? !）插 250ms；省略号「……」处插 400ms。
function insertBreaks(escaped) {
  let out = escaped.replace(/…+/g, '<break time="400ms"/>');
  out = out.replace(/([。？！?!])/g, '$1<break time="250ms"/>');
  return out;
}

function ssmlFromNormalized(np, text) {
  const { ratePct, pitchPct, style } = prosodyFor(np);
  const body = insertBreaks(escapeXml(text));
  let attrs = ` rate="${fmtPct(ratePct)}"`;
  if (pitchPct) attrs += ` pitch="${fmtPct(pitchPct)}"`;
  let inner = `<prosody${attrs}>${body}</prosody>`;
  if (style) inner = `<mstts:express-as style="${style}" styledegree="1.5">${inner}</mstts:express-as>`;
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="zh-CN"><voice name="${np.voice}">${inner}</voice></speak>`;
}

// 纯函数：把参数 + 文本拼成 Azure 可接受的 SSML。
function buildSsml(params) {
  const p = params || {};
  const np = normalizeParams(p);
  return ssmlFromNormalized(np, cleanText(p.text));
}

// UTC+8 自然日键：把时间平移 +8h 后取 UTC 日期。
function utc8DayKey(ts) {
  const d = new Date(Number(ts) + 8 * 3600 * 1000);
  if (Number.isNaN(d.getTime())) return 'invalid';
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function createTts(cfg, dataDir, opts) {
  const c = cfg || {};
  const o = opts || {};
  const key = String(c.AZURE_SPEECH_KEY || '');
  const region = String(c.AZURE_SPEECH_REGION || '');
  const dailyLimit = Number(c.TTS_PLAYER_DAILY_CHARS);
  const rawMax = Number(c.TTS_CACHE_MAX_MB);
  const maxBytes = Number.isFinite(rawMax) && rawMax > 0 ? rawMax * MB : 0;
  const ttsDir = path.join(dataDir, CACHE_DIR_NAME);
  const doFetch = o.fetchImpl || ((...args) => globalThis.fetch(...args));
  const now = o.now || (() => Date.now());

  function isConfigured() {
    return Boolean(key && region);
  }

  function cachePath(hash) {
    return path.join(ttsDir, `${hash}.mp3`);
  }

  function hashFor(np, text) {
    const raw = `${np.voice}|${np.mood}|${np.pace}|${np.speed}|${text}`;
    return crypto.createHash('sha1').update(raw, 'utf8').digest('hex');
  }

  // playerId 由 store.appendUsage 从请求级 context 自动补；这里绝不写进 rec。
  function recordUsage(rec) {
    try { store.appendUsage(dataDir, rec); } catch (_) { /* 记用量失败不影响朗读 */ }
  }

  function usedCharsToday(playerId, at) {
    let rows = [];
    try { rows = store.readJsonl(store.usagePath(dataDir)); } catch (_) { return 0; }
    const day = utc8DayKey(at);
    let total = 0;
    for (const r of rows) {
      if (!r || r.kind !== 'tts' || r.playerId !== playerId) continue;
      if (utc8DayKey(r.ts) !== day) continue;
      const n = Number(r.chars);
      if (Number.isFinite(n)) total += n;
    }
    return total;
  }

  // 缓存总大小超过上限时，按修改时间删最旧的 mp3，直到降到 80%；
  // keepName 是本轮刚写的文件，不删。只删 DATA_DIR/tts/ 下我们自己生成的 .mp3。
  function pruneCache(keepName) {
    if (!maxBytes) return;
    let names;
    try { names = fs.readdirSync(ttsDir).filter((n) => n.endsWith('.mp3')); } catch (_) { return; }
    const entries = [];
    for (const name of names) {
      try {
        const st = fs.statSync(path.join(ttsDir, name));
        entries.push({ name, size: st.size, mtimeMs: st.mtimeMs });
      } catch (_) { /* 忽略已消失的文件 */ }
    }
    let total = entries.reduce((s, e) => s + e.size, 0);
    if (total <= maxBytes) return;
    const target = maxBytes * 0.8;
    const deletable = entries.filter((e) => e.name !== keepName).sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const e of deletable) {
      if (total <= target) break;
      try { fs.unlinkSync(path.join(ttsDir, e.name)); total -= e.size; } catch (_) { /* 忽略 */ }
    }
  }

  async function synth(params) {
    const p = params || {};
    const np = normalizeParams(p);
    const text = cleanText(p.text);
    if (!text) throw { status: 400, expose: true, message: '文本为空' };
    const playerId = p.playerId == null ? '' : String(p.playerId);
    const hash = hashFor(np, text);
    const file = cachePath(hash);

    // 命中缓存：直接返回音频，记一条 cached 用量，不再请求 Azure、也不计字数。
    if (fs.existsSync(file)) {
      const audio = fs.readFileSync(file);
      recordUsage({ ts: now(), kind: 'tts', voice: np.voice, chars: 0, cached: true, ms: 0, ok: true });
      return audio;
    }

    if (!isConfigured()) throw { status: 503, expose: true, message: '朗读服务未配置' };

    const chars = text.length;
    if (playerId !== 'host' && Number.isFinite(dailyLimit) && dailyLimit > 0 &&
        usedCharsToday(playerId, now()) + chars > dailyLimit) {
      throw { status: 429, expose: true, message: '今日朗读字数已达上限' };
    }

    const ssml = ssmlFromNormalized(np, text);
    const url = `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const t0 = now();
    const resp = await doFetch(url, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'aigame',
      },
      body: ssml,
    });
    if (!resp || !resp.ok) throw { status: 502, expose: true, message: '朗读合成失败' };
    const ab = await resp.arrayBuffer();
    const audio = Buffer.from(ab);
    try {
      fs.mkdirSync(ttsDir, { recursive: true });
      fs.writeFileSync(file, audio);
    } catch (_) { /* 写缓存失败仍返回本次音频 */ }
    pruneCache(`${hash}.mp3`);
    recordUsage({ ts: now(), kind: 'tts', voice: np.voice, chars, cached: false, ms: now() - t0, ok: true });
    return audio;
  }

  return { synth, buildSsml, isConfigured, pruneCache, VOICES, MOODS, DEFAULT_VOICE };
}

module.exports = {
  createTts,
  buildSsml,
  VOICES,
  MOODS,
  DEFAULT_VOICE,
};
