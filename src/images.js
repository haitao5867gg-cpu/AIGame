'use strict';

// 第 7 节：随身物品 / 认识的人（NPC）图片生成，零第三方依赖（仅 Node 内置模块）。
//
// 设计要点：
//  - 全局共享缓存 DATA_DIR/images/ + index.json（原子写）。同名同画风的物品跨世界共用；
//    NPC 因常重名但长相不同，key 额外带世界 id。
//  - 进程内全局队列，并发受 IMAGE_CONCURRENCY 控制；ensureImages 完全异步、绝不阻塞回合。
//  - 出图提供方：local（本地显卡服务，只懂英文）/ gateway（付费，中文）/ off（不生成）。
//  - 任何异常只写日志并标 failed，绝不让回合失败。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store.js');
const llm = require('./llm.js');
const env = require('./env.js');

// GET /api/images/<file> 严格校验：只允许 <kind>-<12位16进制>.<jpg|svg>。
// 正则保证文件名里没有斜杠 / 多余的点，天然挡住路径穿越。
const FILE_NAME_RE = /^(item|npc)-[0-9a-f]{12}\.(jpg|svg)$/;
const FAILED_COOLDOWN_MS = 10 * 60 * 1000; // failed 10 分钟后才允许重试
const IMAGE_TIMEOUT_MS = 60000;            // 单次出图 HTTP 超时

// ---- 画风推断：从 bible.title / tone 用简单关键词规则推一个画风（中英各一份）----
// 顺序即优先级：先匹配先生效。
const STYLE_RULES = Object.freeze([
  { re: /修仙|仙侠|武侠|古代|古风|江湖|侠客|朝代|王朝/, zh: '水墨手绘插画', en: 'Chinese ink wash illustration' },
  { re: /蒸汽|机械|朋克|齿轮|机关|锅炉|发条/, zh: '复古蒸汽朋克手绘', en: 'steampunk hand-drawn illustration' },
  { re: /赛博|未来|星际|深海|科幻|太空|宇宙|银河|机甲/, zh: '科幻概念插画', en: 'sci-fi concept art illustration' },
  { re: /民国|上海|近代|旗袍|谍战|百乐门|租界/, zh: '复古民国画报风', en: 'vintage 1930s poster illustration' },
  { re: /末日|丧尸|僵尸|尸潮|废土|灾变|核战/, zh: '末日写实插画', en: 'post-apocalyptic gritty illustration' },
]);
const DEFAULT_STYLE = Object.freeze({ zh: '手绘插画', en: 'hand-drawn game illustration' });

function inferStyle(bible) {
  const b = bible && typeof bible === 'object' ? bible : {};
  const text = `${b.title == null ? '' : b.title} ${b.tone == null ? '' : b.tone}`;
  for (const rule of STYLE_RULES) {
    if (rule.re.test(text)) return { zh: rule.zh, en: rule.en };
  }
  return { zh: DEFAULT_STYLE.zh, en: DEFAULT_STYLE.en };
}

// 缓存 key = sha1(kind|name|style[|worldId]) 前 12 位（十六进制）。
// 物品不带 worldId（跨世界共享）；NPC 带 worldId（重名但长相不同）。
function imageKey(kind, name, style, worldId) {
  let s = `${kind}|${name}|${style}`;
  if (kind === 'npc') s += `|${worldId == null ? '' : worldId}`;
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex').slice(0, 12);
}

function indexKeyOf(kind, key) { return `${kind}-${key}`; }
function jpgName(kind, key) { return `${kind}-${key}.jpg`; }
function svgName(kind, key) { return `${kind}-${key}.svg`; }

function imagesDir(dataDir) { return path.join(dataDir, 'images'); }
function indexPath(dataDir) { return path.join(imagesDir(dataDir), 'index.json'); }

function readIndex(dataDir) {
  const v = store.readJson(indexPath(dataDir), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}
function writeIndex(dataDir, index) {
  store.atomicWriteJson(indexPath(dataDir), index);
}

function contentTypeFor(filename) {
  return /\.svg$/i.test(filename) ? 'image/svg+xml' : 'image/jpeg';
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

// ---- 提示词 ----
// gateway 用中文。
function gatewayPrompt(job) {
  const title = job.bibleTitle || '';
  const style = job.style.zh;
  if (job.kind === 'npc') {
    return `游戏角色半身肖像：${job.name}，${job.role}，${clip(job.desc, 60)}。世界：${title}。${style}，面部清晰，简洁暗色背景，无文字，无水印`;
  }
  return `游戏道具图标：${job.name}。世界：${title}。${style}，单个物体居中，完整可辨认，浅色纯色背景，无文字，无水印`;
}

// local 用英文：翻译出的一句画面描述 + 固定模板。
function localPrompt(enDesc, kind, styleEn) {
  if (kind === 'npc') {
    return `${enDesc}, half-body portrait, clear face, ${styleEn}, simple dark background, no text`;
  }
  return `${enDesc}, single object centered, game item icon, ${styleEn}, plain light background, no text`;
}

// 翻译结果清洗：取首行、去引号、截断到 ≤25 个英文单词。
function cleanEnglish(text) {
  let t = String(text == null ? '' : text).trim();
  t = t.split(/\r?\n/)[0].trim();
  t = t.replace(/["'`«»「」]/g, '').trim();
  t = t.split(/\s+/).filter(Boolean).slice(0, 25).join(' ');
  return t;
}

// ---- 待生成清单：当前物品 + 当前 NPC（role/desc 取自 bible.npcs）----
// 纯函数，单独导出便于测试。列表元素形如 {kind, name, role, desc}。
function listForState(state) {
  const s = state && typeof state === 'object' ? state : {};
  const bible = s.bible && typeof s.bible === 'object' ? s.bible : {};
  const npcMeta = {};
  for (const n of (Array.isArray(bible.npcs) ? bible.npcs : [])) {
    if (n && typeof n.name === 'string') {
      npcMeta[n.name.trim()] = {
        role: typeof n.role === 'string' ? n.role : '',
        desc: typeof n.desc === 'string' ? n.desc : '',
      };
    }
  }
  const out = [];
  const items = (s.character && Array.isArray(s.character.items)) ? s.character.items : [];
  for (const it of items) {
    if (typeof it === 'string' && it.trim()) {
      out.push({ kind: 'item', name: it.trim(), role: '', desc: '' });
    }
  }
  const npc = s.npcAttitude && typeof s.npcAttitude === 'object' ? s.npcAttitude : {};
  for (const name of Object.keys(npc)) {
    const key = name.trim();
    if (!key) continue;
    const meta = npcMeta[key] || { role: '', desc: '' };
    out.push({ kind: 'npc', name: key, role: meta.role, desc: meta.desc });
  }
  return out;
}

// 图片文件原子写（临时文件 + rename），避免 GET 时读到半张图。
function writeBinaryAtomic(filePath, buf) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* 不盖掉原始错误 */ }
    throw err;
  }
}

function mockSvg(name) {
  const label = clip(name, 4)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">'
    + '<rect width="128" height="128" fill="#2a2820"/>'
    + `<text x="64" y="72" font-size="22" fill="#c0392b" text-anchor="middle" font-family="serif">${label}</text>`
    + '</svg>';
}

// GET /api/images/<file>：返回 {status, filePath?, contentType?}。
// 文件名非法 → 400；合法但不存在 → 404；否则 200 + 路径 / 类型。
function serveImage(dataDir, filename) {
  if (typeof filename !== 'string' || !FILE_NAME_RE.test(filename)) {
    return { status: 400 };
  }
  const filePath = path.join(imagesDir(dataDir), filename);
  let st;
  try { st = fs.statSync(filePath); } catch (_) { return { status: 404 }; }
  if (!st.isFile()) return { status: 404 };
  return { status: 200, filePath, contentType: contentTypeFor(filename) };
}

// 根据索引项拼出接口返回用的 {status, url}。
function statusOf(idx, kind, name, style, worldId) {
  const ik = indexKeyOf(kind, imageKey(kind, name, style, worldId));
  const e = idx[ik];
  if (!e) return { status: 'none', url: null };
  if (e.status === 'ready' && e.file) return { status: 'ready', url: '/api/images/' + e.file };
  if (e.status === 'pending') return { status: 'pending', url: null };
  if (e.status === 'failed') return { status: 'failed', url: null };
  return { status: 'none', url: null };
}

// GET /api/worlds/:id/images 的响应。顺手对没有索引项的补排队（老存档补图）。
function buildImageList(dataDir, state, ensureFn) {
  const s = state && typeof state === 'object' ? state : {};
  ensureFn(dataDir, s, listForState(s));
  const idx = readIndex(dataDir);
  const style = inferStyle(s.bible);
  const worldId = String(s.id == null ? '' : s.id);
  const items = {};
  const npcs = {};
  const curItems = (s.character && Array.isArray(s.character.items)) ? s.character.items : [];
  for (const it of curItems) {
    if (typeof it !== 'string' || !it.trim()) continue;
    items[it.trim()] = statusOf(idx, 'item', it.trim(), style.zh, worldId);
  }
  const npc = s.npcAttitude && typeof s.npcAttitude === 'object' ? s.npcAttitude : {};
  for (const name of Object.keys(npc)) {
    const k = name.trim();
    if (!k) continue;
    npcs[k] = statusOf(idx, 'npc', k, style.zh, worldId);
  }
  return { items, npcs };
}

// ---- 核心：可实例化的图片管理器（进程内全局队列）----
function createImages(cfg, opts) {
  const c = cfg || {};
  const o = opts || {};
  const provider = String(c.IMAGE_PROVIDER || 'local').toLowerCase();
  let base = String(c.IMAGE_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    base = provider === 'gateway'
      ? String(c.LLM_BASE_URL || c.LLM_BASE || '').replace(/\/+$/, '')
      : 'http://127.0.0.1:8790/v1';
  }
  const model = String(c.IMAGE_MODEL || 'Doubao-seedream-4.0');
  const size = String(c.IMAGE_SIZE || '1024x1024');
  const rawMax = Number(c.IMAGE_MAX_PER_WORLD);
  const maxPerWorld = Number.isFinite(rawMax) && rawMax >= 0 ? rawMax : 40;
  const concurrency = Math.max(1, Number(c.IMAGE_CONCURRENCY) || 1);
  const mock = !!c.LLM_MOCK;
  const off = provider === 'off';
  const apiKey = String(c.LLM_API_KEY || '');
  const llmModel = String(c.LLM_MODEL || '');
  const doFetch = o.fetchImpl || ((...args) => globalThis.fetch(...args));
  const nowFn = o.now || (() => Date.now());

  const queue = [];
  const inFlight = new Set();       // 已排队 / 处理中，避免同一 key 重复排队
  const worldCount = new Map();     // gateway：按世界估算已排队数量
  const idleWaiters = [];
  let active = 0;

  function updateEntry(dataDir, indexKey, patch) {
    const idx = readIndex(dataDir);
    const cur = idx[indexKey] && typeof idx[indexKey] === 'object' ? idx[indexKey] : {};
    idx[indexKey] = Object.assign({}, cur, patch);
    writeIndex(dataDir, idx);
  }

  // 非流式翻译（local 用）：让回合模型把中文信息翻成一句 ≤25 词的英文画面描述。
  // 失败一律返回空串（由上层用兜底短语），绝不抛错。
  async function translate(job) {
    try {
      const subject = job.kind === 'npc'
        ? `人物：${job.name}；身份：${job.role}；描述：${clip(job.desc, 60)}；世界：${job.bibleTitle}`
        : `物品：${job.name}；世界：${job.bibleTitle}`;
      const messages = [
        {
          role: 'system',
          content: 'Output ONLY one English visual description (at most 25 words) of the subject '
            + 'for an image generator. Do NOT include any person name or quotation marks. No explanation.',
        },
        { role: 'user', content: subject },
      ];
      if (typeof o.translate === 'function') {
        const r = await o.translate(job, messages);
        return cleanEnglish(typeof r === 'string' ? r : (r && r.content));
      }
      const client = llm.createClient(c, job.dataDir);
      const out = await client.complete({
        purpose: 'turn', model: llmModel, messages, responseFormat: false,
      });
      return cleanEnglish(out && out.content);
    } catch (err) {
      console.warn('[images] 翻译失败，使用英文兜底：' + (err && err.message ? err.message : err));
      return '';
    }
  }

  // 调用 /images/generations，返回图片二进制 Buffer。
  async function callImageApi(prompt, isGateway) {
    const url = base + '/images/generations';
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (isGateway) {
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      body = { model, prompt, size, n: 1, response_format: 'b64_json', watermark: false };
    } else {
      body = { prompt, size, response_format: 'b64_json' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    let resp;
    try {
      resp = await doFetch(url, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') throw new Error(`图片接口超时（${IMAGE_TIMEOUT_MS}ms）`);
      throw new Error('图片接口网络失败：' + (err && err.message ? err.message : err));
    }
    clearTimeout(timer);
    let data;
    try {
      data = typeof (resp && resp.json) === 'function' ? await resp.json() : resp;
    } catch (_) {
      throw new Error('图片接口返回不是合法 JSON');
    }
    if (data && data.error) {
      throw new Error('图片接口错误：' + ((data.error && data.error.message) || JSON.stringify(data.error)));
    }
    if (resp && (resp.ok === false || (typeof resp.status === 'number' && resp.status >= 400))) {
      throw new Error('图片接口 HTTP ' + resp.status);
    }
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (typeof b64 !== 'string' || !b64) throw new Error('图片接口缺少 data[0].b64_json');
    return Buffer.from(b64, 'base64');
  }

  async function processJob(job) {
    const t0 = nowFn();
    let ok = false;
    try {
      let filename;
      let bytes;
      let enPrompt = '';
      let prompt = '';
      if (mock) {
        // LLM_MOCK=1：不访问网络，写一张小的占位 SVG。
        filename = svgName(job.kind, job.key);
        bytes = Buffer.from(mockSvg(job.name), 'utf8');
      } else if (provider === 'gateway') {
        prompt = gatewayPrompt(job);
        bytes = await callImageApi(prompt, true);
        filename = jpgName(job.kind, job.key);
      } else {
        // local：先翻译，再拼英文提示词。
        enPrompt = await translate(job);
        if (!enPrompt) enPrompt = job.kind === 'npc' ? 'a mysterious person' : 'a mysterious item';
        prompt = localPrompt(enPrompt, job.kind, job.style.en);
        bytes = await callImageApi(prompt, false);
        filename = jpgName(job.kind, job.key);
      }
      writeBinaryAtomic(path.join(imagesDir(job.dataDir), filename), bytes);
      updateEntry(job.dataDir, job.indexKey, {
        kind: job.kind, name: job.name, style: job.style.zh, worldId: job.worldId,
        file: filename, status: 'ready', ts: nowFn(),
        enPrompt, prompt,
      });
      ok = true;
    } catch (err) {
      console.warn('[images] 生成失败 ' + job.indexKey + '：' + (err && err.message ? err.message : err));
      try {
        updateEntry(job.dataDir, job.indexKey, { status: 'failed', ts: nowFn() });
      } catch (e) {
        console.warn('[images] 标记 failed 失败：' + (e && e.message ? e.message : e));
      }
    } finally {
      try {
        store.appendUsage(job.dataDir, {
          ts: nowFn(), kind: 'image', provider,
          model: provider === 'gateway' ? model : 'local',
          ok, ms: nowFn() - t0, worldId: job.worldId,
        });
      } catch (e) {
        console.warn('[images] 记录用量失败：' + (e && e.message ? e.message : e));
      }
    }
  }

  function notifyIdle() {
    if (active !== 0 || queue.length !== 0 || idleWaiters.length === 0) return;
    const ws = idleWaiters.splice(0);
    for (const r of ws) r();
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      processJob(job)
        .catch((err) => console.warn('[images] worker 异常（已忽略）：'
          + (err && err.message ? err.message : err)))
        .finally(() => {
          active -= 1;
          inFlight.delete(job.indexKey);
          notifyIdle();
          drain();
        });
    }
    notifyIdle();
  }

  // 完全异步、不阻塞：仅同步地把待生成项登记为 pending 并入队，随后 kick off 队列。
  function ensureImages(dataDir, state, list) {
    try {
      if (off) return; // 什么都不生成
      const s = state && typeof state === 'object' ? state : {};
      const worldId = String(s.id == null ? '' : s.id);
      const style = inferStyle(s.bible);
      const idx = readIndex(dataDir);
      let changed = false;
      let wcount = null;
      if (provider === 'gateway') {
        wcount = worldCount.get(worldId);
        if (wcount == null) {
          // 估算基线：索引里该世界已有的 npc 数（本次进程排队过的数量累加在 wcount 上）。
          wcount = 0;
          for (const k of Object.keys(idx)) {
            const e = idx[k];
            if (e && e.kind === 'npc' && String(e.worldId) === worldId) wcount += 1;
          }
          worldCount.set(worldId, wcount);
        }
      }
      for (const item of (Array.isArray(list) ? list : [])) {
        const kind = item && item.kind === 'npc' ? 'npc' : 'item';
        const name = item && typeof item.name === 'string' ? item.name.trim() : '';
        if (!name) continue;
        const key = imageKey(kind, name, style.zh, worldId);
        const ik = indexKeyOf(kind, key);
        const cur = idx[ik];
        if (cur) {
          if (cur.status === 'ready') {
            if (cur.file && fs.existsSync(path.join(imagesDir(dataDir), cur.file))) continue;
            // ready 但文件丢失 → 允许重新排队
          } else if (cur.status === 'pending') {
            continue;
          } else if (cur.status === 'failed') {
            if (nowFn() - (Number(cur.ts) || 0) < FAILED_COOLDOWN_MS) continue; // 冷却
          }
        }
        if (provider === 'gateway' && wcount >= maxPerWorld) continue; // 花钱上限
        if (inFlight.has(ik)) continue;                                  // 同一 key 不重复排队
        idx[ik] = Object.assign({}, cur || {}, {
          kind, name, style: style.zh, worldId,
          file: null, status: 'pending', ts: nowFn(),
        });
        changed = true;
        inFlight.add(ik);
        if (provider === 'gateway') { wcount += 1; worldCount.set(worldId, wcount); }
        queue.push({
          dataDir, indexKey: ik, kind, key, name, style, worldId,
          role: item && typeof item.role === 'string' ? item.role : '',
          desc: item && typeof item.desc === 'string' ? item.desc : '',
          bibleTitle: (s.bible && s.bible.title) || '',
          bibleTone: (s.bible && s.bible.tone) || '',
        });
      }
      if (changed) writeIndex(dataDir, idx);
      drain();
    } catch (err) {
      console.warn('[images] ensureImages 异常（已忽略，绝不影响回合）：'
        + (err && err.message ? err.message : err));
    }
  }

  function imageList(dataDir, state) {
    return buildImageList(dataDir, state, ensureImages);
  }

  function waitIdle() {
    if (active === 0 && queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    ensureImages, imageList, waitIdle, serveImage, readIndex, listForState,
    config: { provider, base, model, size, maxPerWorld, concurrency, mock, off },
  };
}

// ---- 模块级默认实例：提供规格里的 ensureImages(dataDir, state, list) 顶层函数 ----
// server.js 实际用 createImages(cfg) 自建实例（隔离），这里方便单测 / 复用。
let _default = null;
function defaultInstance() {
  if (!_default) _default = createImages(env.getConfig());
  return _default;
}
function configure(cfg, opts) {
  _default = createImages(cfg || env.getConfig(), opts);
  return _default;
}
function reset() { _default = null; }

function ensureImages(dataDir, state, list) { return defaultInstance().ensureImages(dataDir, state, list); }
function imageList(dataDir, state) { return defaultInstance().imageList(dataDir, state); }
function waitIdle() { return defaultInstance().waitIdle(); }

module.exports = {
  createImages, configure, reset,
  // 纯函数
  inferStyle, imageKey, listForState, readIndex, serveImage,
  FILE_NAME_RE, FAILED_COOLDOWN_MS, IMAGE_TIMEOUT_MS,
  // 默认实例委托
  ensureImages, imageList, waitIdle,
};
