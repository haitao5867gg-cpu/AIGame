'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const images = require('../../src/images.js');
const store = require('../../src/store.js');

const JPEG = Buffer.from('FAKE-JPEG-BYTES');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-images-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 默认不让画风设定走真实对话模型：artDirector 返回 null → 关键词规则兜底。
function withArt(opts) { return Object.assign({ artDirector: async () => null }, opts || {}); }
function configureT(cfg, opts) { return images.configure(cfg, withArt(opts)); }
function createT(cfg, opts) { return images.createImages(cfg, withArt(opts)); }

function baseCfg(overrides) {
  return Object.assign({
    IMAGE_PROVIDER: 'gateway',
    IMAGE_BASE_URL: 'https://img.test/v1',
    IMAGE_MODEL: 'Doubao-seedream-4.0',
    IMAGE_SIZE: '1024x1024',
    IMAGE_MAX_PER_WORLD: 40,
    IMAGE_CONCURRENCY: 1,
    LLM_MOCK: false,
    LLM_API_KEY: 'sk-test',
    LLM_BASE: 'https://chat.test/v1',
    LLM_MODEL: 'test-model',
    LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0,
    LLM_EXTRA_BODY: '',
  }, overrides || {});
}

function makeState(overrides) {
  return Object.assign({
    id: 'w1',
    bible: {
      title: '蒸汽朋克长安', tone: '齿轮与迷雾',
      npcs: [{ name: '守夜人', role: '引路者', desc: '总在雾里提一盏不灭的灯' }],
    },
    character: { items: ['无字信', '旧铜灯'] },
    npcAttitude: { '守夜人': 0 },
  }, overrides || {});
}

// 记录请求，返回成功的 b64_json 响应。
function okFetch(calls) {
  return async (url, opts) => {
    if (calls) {
      calls.push({
        url,
        headers: opts && opts.headers,
        body: typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body,
      });
    }
    return { ok: true, json: async () => ({ data: [{ b64_json: JPEG.toString('base64') }] }) };
  };
}

function stubWarn(t) {
  const original = console.warn;
  const warns = [];
  console.warn = (m) => warns.push(String(m));
  t.after(() => { console.warn = original; });
  return warns;
}

function freeFetch(calls, behavior) {
  const b = behavior || {};
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    if (url === images.SILICONFLOW_URL) {
      if (b.sf === 'fail') return { ok: false, status: 429, json: async () => ({ code: 50603, message: 'rate limited' }) };
      return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://dl.test/sf.png' }] }) };
    }
    if (url === images.ZHIPU_URL) {
      if (b.zp === 'fail') return { ok: false, status: 500, json: async () => ({ error: { message: 'zp down' } }) };
      return { ok: true, status: 200, json: async () => ({ data: [{ url: 'https://dl.test/zp.png' }] }) };
    }
    if (url.startsWith('https://dl.test/')) {
      return { ok: true, status: 200, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
    }
    throw new Error('意外的 URL ' + url);
  };
}
function oneItemState(id) {
  return makeState({
    id, character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '蒸汽朋克长安', tone: '', npcs: [] },
  });
}
function msFetch(calls, statuses) {
  const seq = (statuses || ['RUNNING', 'SUCCEED']).slice();
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, method: (opts && opts.method) || 'GET', headers: opts && opts.headers, body });
    if (url === images.MODELSCOPE_URL) {
      return { ok: true, status: 200, json: async () => ({ task_status: 'SUCCEED', task_id: 't-1', request_id: 'r' }) };
    }
    if (url === images.MODELSCOPE_TASK_URL + 't-1') {
      const st = seq.length > 1 ? seq.shift() : seq[0];
      if (st === 'SUCCEED') return { ok: true, status: 200, json: async () => ({ task_status: 'SUCCEED', output_images: ['https://dl.test/ms.png'] }) };
      if (st === 'FAILED') return { ok: true, status: 200, json: async () => ({ task_status: 'FAILED', errors: { message: 'nsfw' } }) };
      return { ok: true, status: 200, json: async () => ({ task_status: st }) };
    }
    if (url.startsWith('https://dl.test/')) {
      return { ok: true, status: 200, arrayBuffer: async () => JPEG.buffer.slice(JPEG.byteOffset, JPEG.byteOffset + JPEG.length) };
    }
    return freeFetch(null)(url, opts);
  };
}
function cfFetch(calls, behavior) {
  const b = behavior || {};
  return async (url, opts) => {
    const body = opts && typeof opts.body === 'string' ? JSON.parse(opts.body) : undefined;
    if (calls) calls.push({ url, headers: opts && opts.headers, body });
    if (url.startsWith(images.CLOUDFLARE_API_BASE)) {
      if (b.fail) return { ok: false, status: 429, json: async () => ({ success: false, errors: [{ code: 4006, message: 'daily free allocation used' }] }) };
      return { ok: true, status: 200, json: async () => ({ success: true, errors: [], result: { image: JPEG.toString('base64') } }) };
    }
    return freeFetch(null)(url, opts);
  };
}
const XIANXIA_ART = {
  zh: '中国古风水墨仙侠插画', en: 'ancient Chinese xianxia ink-wash illustration',
  eraZh: '中国古代修仙宗门', eraEn: 'ancient China, cultivation sect', avoidZh: '现代物品，霓虹，赛博朋克',
  bgZh: '米白宣纸色背景', bgEn: 'plain off-white rice paper background',
};
function xianxiaState(id) {
  return makeState({
    id, character: { items: ['旧铜灯'] }, npcAttitude: {},
    bible: { title: '杂役百年', tone: '低阶修仙的土腥气', rules: ['灵根决定上限'], places: [{ name: '外门' }], npcs: [] },
  });
}

module.exports = { JPEG, tmpDir, withArt, configureT, createT, baseCfg, makeState, okFetch, stubWarn, freeFetch, oneItemState, msFetch, cfFetch, XIANXIA_ART, xianxiaState };
