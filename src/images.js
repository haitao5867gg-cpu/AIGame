'use strict';

// 第 7 节：随身物品 / 认识的人（NPC）图片生成，零第三方依赖（仅 Node 内置模块）。
//
// 设计要点：
//  - 全局共享缓存 DATA_DIR/images/ + index.json（原子写）。同名同画风的物品跨世界共用；
//    NPC 因常重名但长相不同，key 额外带世界 id。
//  - 进程内全局队列，并发受 IMAGE_CONCURRENCY 控制；ensureImages 完全异步、绝不阻塞回合。
//  - 出图提供方：siliconflow / zhipu（免费，中文）/ local（本地显卡服务，只懂英文）/ gateway（付费，中文）/ off。
//    IMAGE_PROVIDER 可写成回退链 siliconflow,zhipu,local：前一家失败就换下一家。
//  - 任何异常只写日志并标 failed，绝不让回合失败。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store.js');
const llm = require('./llm.js');
const env = require('./env.js');

// GET /api/images/<file> 严格校验：只允许 <kind>-<12位16进制>.<jpg|svg>。
// 正则保证文件名里没有斜杠 / 多余的点，天然挡住路径穿越。
const FILE_NAME_RE = /^(item|npc)-[0-9a-f]{12}\.(jpg|png|svg)$/;
const FAILED_COOLDOWN_MS = 10 * 60 * 1000; // failed 10 分钟后才允许重试
const IMAGE_TIMEOUT_MS = 60000;            // 单次出图 HTTP 超时
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000; // 回退链里某家失败后 5 分钟内排到最后
const SILICONFLOW_URL = 'https://api.siliconflow.cn/v1/images/generations';
const ZHIPU_URL = 'https://open.bigmodel.cn/api/paas/v4/images/generations';
// 魔搭 ModelScope：异步任务。提交返回 task_id，轮询 /v1/tasks/<id> 直到 SUCCEED / FAILED。
const MODELSCOPE_URL = 'https://api-inference.modelscope.cn/v1/images/generations';
const MODELSCOPE_TASK_URL = 'https://api-inference.modelscope.cn/v1/tasks/';
const MODELSCOPE_POLL_MS = 2000;
// Cloudflare Workers AI：同步返回 {result:{image:<base64 JPEG>}}；flux 对中文提示词基本无效，走英文提示词。
const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4/accounts/';
// 实测 Z-Image-Turbo 排队 + 出图 80~100 秒，留余量取 180 秒。
const MODELSCOPE_TIMEOUT_MS = 180000;
const FREE_SIZE = '1024x1024';             // 硅基流动 / 智谱都支持
const LOCAL_DEFAULT_BASE = 'http://127.0.0.1:8790/v1';

// ---- 画风推断：从 bible.title / tone 用简单关键词规则推一个画风（中英各一份）----
// 顺序即优先级：先匹配先生效。
const STYLE_RULES = Object.freeze([
// 每条只给一种媒介 + 一种笔触（不混用「写实」与「水墨」），并给固定背景色调。
  { re: /修仙|仙侠|武侠|古代|古风|江湖|侠客|朝代|王朝/, legacyZh: '水墨手绘插画', zh: '水墨淡彩插画', en: 'ink and watercolor illustration, fine ink linework with light color washes',
    eraZh: '中国古代仙侠', eraEn: 'ancient China, xianxia', avoidZh: '现代物品，科技，霓虹，赛博朋克，西装，枪械，塑料',
    bgZh: '米白宣纸色背景', bgEn: 'plain light beige background' },
  { re: /蒸汽|机械|朋克|齿轮|机关|锅炉|发条/, legacyZh: '复古蒸汽朋克手绘', zh: '复古铜版线描淡彩', en: 'vintage engraving line art with sepia washes',
    eraZh: '蒸汽机械时代', eraEn: 'steam-powered clockwork era', avoidZh: '现代电子产品，霓虹，塑料',
    bgZh: '旧羊皮纸色背景', bgEn: 'plain light tan background' },
  { re: /赛博|未来|星际|深海|科幻|太空|宇宙|银河|机甲/, legacyZh: '科幻概念插画', zh: '数字厚涂概念插画', en: 'digital painterly concept art',
    eraZh: '未来科幻', eraEn: 'futuristic sci-fi', avoidZh: '古装，魔法',
    bgZh: '深灰蓝纯色背景', bgEn: 'plain dark slate blue background' },
  { re: /民国|上海|近代|旗袍|谍战|百乐门|租界/, legacyZh: '复古民国画报风', zh: '民国月份牌画风', en: '1930s Chinese calendar poster painting',
    eraZh: '1930 年代民国', eraEn: '1930s Republican China', avoidZh: '现代电子产品，未来科技',
    bgZh: '暖米黄纯色背景', bgEn: 'plain warm cream background' },
  { re: /末日|丧尸|僵尸|尸潮|废土|灾变|核战/, legacyZh: '末日写实插画', zh: '粗粝炭笔素描淡彩', en: 'gritty charcoal sketch with muted color washes',
    eraZh: '末日废土', eraEn: 'post-apocalyptic wasteland', avoidZh: '整洁现代都市，魔法',
    bgZh: '灰褐纯色背景', bgEn: 'plain dusty grey-brown background' },
]);
const DEFAULT_STYLE = Object.freeze({ legacyZh: '手绘插画', zh: '手绘水彩插画', en: 'hand-drawn watercolor illustration',
  bgZh: '浅米色纯色背景', bgEn: 'plain light beige background' });
const ART_FIELDS = ['zh', 'en', 'eraZh', 'eraEn', 'avoidZh', 'bgZh', 'bgEn'];
// 画风设定版本：新生成的条目带 v=2。为了不让老世界整体重画，旧条目（无 v）照用、缓存 key 保持旧格式。
const ART_VERSION = 2;
const NO_TEXT_ZH = '无文字，无印章，无书法字，无水印';
// flux 会把提示词里提到的东西画出来：写「no calligraphy / no seal stamps」反而招来题字和印章，
// 「rice paper」也会带出国画题款。所以英文只用正面描述：干净空白背景、无落款。
const NO_TEXT_EN = 'clean empty background, unsigned';
const ART_RETRY_MS = 30 * 60 * 1000; // 画风 LLM 生成失败后，30 分钟内先用关键词规则兜底、不再重试

function inferStyle(bible) {
  const b = bible && typeof bible === 'object' ? bible : {};
  const text = `${b.title == null ? '' : b.title} ${b.tone == null ? '' : b.tone}`;
  for (const rule of STYLE_RULES) {
    if (rule.re.test(text)) return { zh: rule.zh, en: rule.en };
  }
  return { zh: DEFAULT_STYLE.zh, en: DEFAULT_STYLE.en };
}

// 规范化画风设定：所有字段都是非空短字符串才算有效。
function normalizeArt(a) {
  if (!a || typeof a !== 'object') return null;
  const out = {};
  for (const f of ART_FIELDS) {
    const v = typeof a[f] === 'string' ? a[f].replace(/\s+/g, ' ').trim() : '';
    if (!v) return null;
    out[f] = clip(v, /En$|^en$/.test(f) ? 120 : 60);
  }
  // 国画暗示词会让 flux 自动加题字和印章：从英文画风里去掉（时代由 eraEn 负责锁定）。
  out.en = out.en.replace(/\b(traditional\s+)?chinese\b\s*/gi, '')
    .replace(/\bink[- ]?wash(\s+painting)?\b/gi, 'ink and watercolor')
    .replace(/\b(guohua|sumi-?e|hanging\s+scroll|scroll\s+painting)\b/gi, 'illustration')
    .replace(/\s+/g, ' ').trim();
  out.bgEn = out.bgEn.replace(/\b(rice|xuan|mulberry)\s+paper\b/gi, 'light beige')
    .replace(/\b(scroll|parchment|paper)\b/gi, 'plain').replace(/\s+/g, ' ').trim();
  return out;
}

// 关键词规则兜底的画风设定（LLM 不可用 / 失败时）。
function ruleArt(bible) {
  const b = bible && typeof bible === 'object' ? bible : {};
  const text = `${b.title == null ? '' : b.title} ${b.tone == null ? '' : b.tone}`;
  for (const r of STYLE_RULES) {
    if (r.re.test(text)) {
      return { zh: r.zh, en: r.en, eraZh: r.eraZh, eraEn: r.eraEn, avoidZh: r.avoidZh, bgZh: r.bgZh, bgEn: r.bgEn,
        legacyZh: r.legacyZh };
    }
  }
  return { zh: DEFAULT_STYLE.zh, en: DEFAULT_STYLE.en, eraZh: '', eraEn: '', avoidZh: '',
    bgZh: DEFAULT_STYLE.bgZh, bgEn: DEFAULT_STYLE.bgEn, legacyZh: DEFAULT_STYLE.legacyZh };
}

function stylesPath(dataDir) { return path.join(imagesDir(dataDir), 'styles.json'); }
function readStyles(dataDir) {
  const v = store.readJson(stylesPath(dataDir), {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

// 世界的画风设定：bible.art → data/images/styles.json 缓存 → null（尚未生成）。
function cachedArt(dataDir, state) {
  const s = state && typeof state === 'object' ? state : {};
  const fromBible = normalizeArt(s.bible && s.bible.art);
  if (fromBible) return fromBible;
  const worldId = String(s.id == null ? '' : s.id);
  const e = readStyles(dataDir)[worldId];
  if (!e || typeof e !== 'object') return null;
  if (Number(e.v) === ART_VERSION) return normalizeArt(e);
  // 旧条目（4f1e02a 生成，无背景字段）：照用，缓存 key 保持「画风｜时代」，老图不重画；背景按规则补。
  const rb = ruleArt(s.bible);
  const legacy = normalizeArt(Object.assign({ bgZh: rb.bgZh, bgEn: rb.bgEn }, e));
  if (!legacy) return null;
  legacy.legacyKey = `${legacy.zh}｜${legacy.eraZh}`;
  return legacy;
}

// 4f1e02a 之前就有图、但还没有画风设定的老世界：沿用最早的缓存 key（只有画风词），不触发整体重画。
function hasLegacyImages(dataDir, worldId) {
  const idx = readIndex(dataDir);
  return Object.keys(idx).some((k) => {
    const e = idx[k];
    return e && String(e.worldId) === worldId && e.status === 'ready' && !String(e.style || '').includes('｜');
  });
}

// 世界当前用的画风：{ style, needsArt }。needsArt=true 表示该生成画风设定（新世界）。
function styleForWorld(dataDir, state) {
  const s = state && typeof state === 'object' ? state : {};
  const cached = cachedArt(dataDir, s);
  if (cached) return { style: styleFromArt(cached), needsArt: false };
  const rule = ruleArt(s.bible);
  if (hasLegacyImages(dataDir, String(s.id == null ? '' : s.id))) {
    return { style: styleFromArt(Object.assign({}, rule, { legacyKey: rule.legacyZh })), needsArt: false };
  }
  return { style: styleFromArt(rule), needsArt: true };
}

// job.style：zh 进缓存 key（画风 / 时代 / 背景变了 → 旧图自动重画），其余字段给提示词用。
function styleFromArt(art) {
  const a = art || ruleArt(null);
  return {
    zh: a.legacyKey || [a.zh, a.eraZh, a.bgZh].filter(Boolean).join('｜'),
    en: a.en, artZh: a.zh, eraZh: a.eraZh || '', eraEn: a.eraEn || '', avoidZh: a.avoidZh || '',
    bgZh: a.bgZh || DEFAULT_STYLE.bgZh, bgEn: a.bgEn || DEFAULT_STYLE.bgEn,
  };
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
function pngName(kind, key) { return `${kind}-${key}.png`; }
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
  if (/\.svg$/i.test(filename)) return 'image/svg+xml';
  if (/\.png$/i.test(filename)) return 'image/png';
  return 'image/jpeg';
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

// ---- 提示词 ----
// gateway 用中文。
// 画风放最前（权重高），再写世界背景 + 时代，锁定器物 / 服饰，最后写主体。
function gatewayPrompt(job) {
  const st = job.style;
  const title = job.bibleTitle || '';
  const art = st.artZh || st.zh;
  const world = `世界背景：${title}${st.eraZh ? '，' + st.eraZh : ''}`;
  const avoid = st.avoidZh ? `，不要出现${st.avoidZh}` : '';
  const bg = st.bgZh || DEFAULT_STYLE.bgZh;
  if (job.kind === 'npc') {
    return `${art}。${world}。游戏角色半身肖像：${job.name}，${job.role}，${clip(job.desc, 60)}，`
      + `穿着符合该时代的服饰，面部清晰，${bg}，${NO_TEXT_ZH}${avoid}`;
  }
  return `${art}。${world}。游戏道具图标：${job.name}，该时代的器物，单个物体居中，完整可辨认，`
    + `${bg}，${NO_TEXT_ZH}${avoid}`;
}

// local 用英文：翻译出的一句画面描述 + 固定模板。
// flux 不支持负面提示词：画风和时代放最前，用正面描述锁时代。
// 物品与人物用同一背景色调；flux 爱加书法和印章，明确写 no calligraphy / no seal stamps。
function localPrompt(enDesc, kind, styleEn, eraEn, bgEn) {
  const era = eraEn ? `, ${eraEn} style` : '';
  enDesc = String(enDesc).replace(/[.。\s]+$/, '');
  const bg = bgEn || DEFAULT_STYLE.bgEn;
  if (kind === 'npc') {
    return `${styleEn}. ${enDesc}${era}, period-accurate clothing, half-body portrait, clear face, ${bg}, ${NO_TEXT_EN}`;
  }
  return `${styleEn}. ${enDesc}${era}, period-accurate object, single object centered, game item icon, ${bg}, ${NO_TEXT_EN}`;
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
function statusOfEntry(idx, kind, name, style, worldId) {
  const ik = indexKeyOf(kind, imageKey(kind, name, style, worldId));
  const e = idx[ik];
  if (!e) return { status: 'none', url: null };
  if (e.status === 'ready' && e.file) return { status: 'ready', url: '/api/images/' + e.file };
  if (e.status === 'pending') return { status: 'pending', url: null };
  if (e.status === 'failed') return { status: 'failed', url: null };
  return { status: 'none', url: null };
}

// GET /api/worlds/:id/images 的响应。顺手对没有索引项的补排队（老存档补图）。
// isGenerating(worldId)=true 表示该世界画风设定还在生成：没图的项先报 pending，前端会继续轮询。
function buildImageList(dataDir, state, ensureFn, isGenerating) {
  const s = state && typeof state === 'object' ? state : {};
  ensureFn(dataDir, s, listForState(s));
  const idx = readIndex(dataDir);
  const style = styleForWorld(dataDir, s).style;
  const worldId = String(s.id == null ? '' : s.id);
  const gen = typeof isGenerating === 'function' && isGenerating(worldId);
  const statusOf = (i, kind, name, st, wid) => {
    const r = statusOfEntry(i, kind, name, st, wid);
    return gen && r.status !== 'ready' ? { status: 'pending', url: null } : r;
  };
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
  const chain = String(c.IMAGE_PROVIDER || 'local').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!chain.length) chain.push('local');
  const provider = chain.join(',');
  const paid = chain.includes('gateway');
  // IMAGE_BASE_URL 归链里第一个 HTTP 型提供方（gateway / local）用；另一个走自己的默认地址。
  const firstHttp = chain.find((p) => p === 'gateway' || p === 'local');
  const llmBase = String(c.LLM_BASE_URL || c.LLM_BASE || '').replace(/\/+$/, '');
  const cfgBase = String(c.IMAGE_BASE_URL || '').replace(/\/+$/, '');
  const gatewayBase = firstHttp === 'gateway' && cfgBase ? cfgBase : llmBase;
  const localBase = firstHttp === 'local' && cfgBase ? cfgBase : LOCAL_DEFAULT_BASE;
  const base = firstHttp === 'gateway' ? gatewayBase : localBase;
  const sfKey = String(c.SILICONFLOW_API_KEY || '');
  const sfModel = String(c.IMAGE_SILICONFLOW_MODEL || 'Kwai-Kolors/Kolors');
  const zpKey = String(c.ZHIPU_API_KEY || '');
  const zpModel = String(c.IMAGE_ZHIPU_MODEL || 'cogview-3-flash');
  const cfAccount = String(c.CLOUDFLARE_ACCOUNT_ID || '');
  const cfToken = String(c.CLOUDFLARE_API_TOKEN || '');
  const cfModel = String(c.IMAGE_CLOUDFLARE_MODEL || '@cf/black-forest-labs/flux-1-schnell');
  const msKey = String(c.MODELSCOPE_API_KEY || '');
  const msModel = String(c.IMAGE_MODELSCOPE_MODEL || 'Tongyi-MAI/Z-Image-Turbo');
  const providerCooldown = new Map(); // provider → 冷却截止时间
  const model = String(c.IMAGE_MODEL || 'Doubao-seedream-4.0');
  const size = String(c.IMAGE_SIZE || '768x768');
  // Seedream 要求至少 960x960 像素；配置偏小时 gateway 自动用 1024x1024。
  const gatewaySize = (() => {
    const m = /^(\d+)x(\d+)$/i.exec(size);
    return m && Number(m[1]) * Number(m[2]) >= 921600 ? size : '1024x1024';
  })();
  const rawMax = Number(c.IMAGE_MAX_PER_WORLD);
  const maxPerWorld = Number.isFinite(rawMax) && rawMax >= 0 ? rawMax : 40;
  const concurrency = Math.max(1, Number(c.IMAGE_CONCURRENCY) || 1);
  const mock = !!c.LLM_MOCK;
  const off = chain[0] === 'off';
  const apiKey = String(c.LLM_API_KEY || '');
  const llmModel = String(c.LLM_MODEL || '');
  const doFetch = o.fetchImpl || ((...args) => globalThis.fetch(...args));
  const nowFn = o.now || (() => Date.now());
  const sleepFn = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  // ---- 每个世界的画风设定：缺失时用对话模型按 bible 生成一次，缓存到 data/images/styles.json ----
  const artJobs = new Map();   // worldId → Promise（本进程正在生成）
  const artFailedAt = new Map(); // worldId → 上次失败时间

  async function directArt(dataDir, state) {
    const b = state.bible && typeof state.bible === 'object' ? state.bible : {};
    const brief = [
      `标题：${clip(b.title, 40)}`,
      `基调：${clip(b.tone, 120)}`,
      Array.isArray(b.rules) ? `规则：${clip(b.rules.join('；'), 200)}` : '',
      Array.isArray(b.places) ? `地点：${clip(b.places.map((p) => (p && p.name) || p).join('、'), 120)}` : '',
    ].filter(Boolean).join('\n');
    const messages = [
      {
        role: 'system',
        content: '你是游戏美术指导。根据世界设定，给这个世界的所有道具图标和人物肖像定一个统一画风，只输出 JSON：'
          + '{"zh":"中文画风，≤12字","en":"English art style, ≤10 words",'
          + '"eraZh":"时代与地域，≤16字","eraEn":"era and region in English, ≤10 words",'
          + '"avoidZh":"不该出现在画面里、与时代冲突的元素，中文逗号分隔，≤30字",'
          + '"bgZh":"所有图共用的纯色背景，≤10字","bgEn":"shared plain background in English, ≤8 words"}。'
          + '画风只能是一种媒介加一种笔触（如「水墨淡彩插画」「铜版线描淡彩」「厚涂油画」），'
          + '不要把互相冲突的词并列（如「写实」和「水墨」、「照片」和「插画」），也不要写「写实」「照片」。'
          + '背景是一种与画风相配的纯色或纸张色，物品和人物共用。'
          + 'en 画风里不要出现 Chinese painting、Chinese ink-wash、guohua、sumi-e、scroll 这类国画暗示词'
          + '（图像模型看到会自动加题字和印章），时代只写在 eraEn 里；bgEn 只写纯色（如 plain light beige background），'
          + '不要写 rice paper、parchment、scroll 等纸张词。'
          + '例：修仙世界 → {"zh":"水墨淡彩插画","en":"ink and watercolor illustration, fine ink linework with light color washes",'
          + '"eraZh":"中国古代修仙宗门","eraEn":"ancient China, cultivation sect",'
          + '"avoidZh":"现代物品，科技，霓虹，赛博朋克，西装，枪械","bgZh":"米白宣纸色背景","bgEn":"plain light beige background"}',
      },
      { role: 'user', content: brief },
    ];
    if (typeof o.artDirector === 'function') return normalizeArt(await o.artDirector(state, messages));
    if (mock) return null;
    const client = llm.createClient(c, dataDir);
    const out = await client.complete({ purpose: 'turn', model: llmModel, messages, responseFormat: 'json_object' });
    let parsed = null;
    try { parsed = JSON.parse(String(out && out.content).replace(/^```(?:json)?|```$/g, '').trim()); } catch (_) { /* 落到兜底 */ }
    return normalizeArt(parsed);
  }

  // 返回 {style, ready}。ready=false 表示正在生成画风设定，本次先不排队（生成后会自动重新 ensure）。
  function resolveStyle(dataDir, state, list) {
    const worldId = String(state.id == null ? '' : state.id);
    const sw = styleForWorld(dataDir, state);
    if (!sw.needsArt) return { style: sw.style, ready: true };
    const failedAt = artFailedAt.get(worldId);
    if (mock || (failedAt != null && nowFn() - failedAt < ART_RETRY_MS)) {
      return { style: styleFromArt(ruleArt(state.bible)), ready: true };
    }
    if (!artJobs.has(worldId)) {
      const job = (async () => {
        let art = null;
        try { art = await directArt(dataDir, state); } catch (err) {
          console.warn('[images] 生成画风设定失败，用关键词规则兜底：' + (err && err.message ? err.message : err));
        }
        if (art) {
          const all = readStyles(dataDir);
          all[worldId] = Object.assign({}, art, { v: ART_VERSION, ts: nowFn() });
          fs.mkdirSync(imagesDir(dataDir), { recursive: true });
          store.atomicWriteJson(stylesPath(dataDir), all);
          console.log(`[images] 世界 ${worldId} 画风：${art.zh}｜${art.eraZh}`);
        } else {
          artFailedAt.set(worldId, nowFn());
        }
      })().finally(() => {
        artJobs.delete(worldId);
        ensureImages(dataDir, state, list);
        notifyIdle();
      });
      artJobs.set(worldId, job);
    }
    return { style: null, ready: false };
  }

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
      const era = job.style && job.style.eraZh ? `；时代背景：${job.style.eraZh}` : '';
      const subject = job.kind === 'npc'
        ? `人物：${job.name}；身份：${job.role}；描述：${clip(job.desc, 60)}；世界：${job.bibleTitle}${era}`
        : `物品：${job.name}；世界：${job.bibleTitle}${era}`;
      const messages = [
        {
          role: 'system',
          content: 'Output ONLY one English visual description (at most 25 words) of the subject '
            + 'for an image generator. The subject MUST fit the world\'s era and setting: objects are made '
            + 'of that era\'s materials and craft, people wear that era\'s clothing; never modern or futuristic '
            + 'unless the world itself is. Do NOT include any person name or quotation marks. No explanation.',
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

  // 带超时的 fetch；超时 / 网络错误统一翻成中文错误。
  async function fetchWithTimeout(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMAGE_TIMEOUT_MS);
    try {
      return await doFetch(url, Object.assign({}, init, { signal: controller.signal }));
    } catch (err) {
      if (err && err.name === 'AbortError') throw new Error(`图片接口超时（${IMAGE_TIMEOUT_MS}ms）`);
      throw new Error('图片接口网络失败：' + (err && err.message ? err.message : err));
    } finally {
      clearTimeout(timer);
    }
  }

  // POST JSON，返回解析后的响应体；业务错误 / HTTP 错误都抛出。
  async function postJson(url, headers, body) {
    const resp = await fetchWithTimeout(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: JSON.stringify(body),
    });
    let data;
    try {
      data = typeof (resp && resp.json) === 'function' ? await resp.json() : resp;
    } catch (_) {
      throw new Error('图片接口返回不是合法 JSON' + (resp && resp.status ? `（HTTP ${resp.status}）` : ''));
    }
    if (data && data.error) {
      throw new Error('图片接口错误：' + ((data.error && data.error.message) || JSON.stringify(data.error)));
    }
    if (resp && (resp.ok === false || (typeof resp.status === 'number' && resp.status >= 400))) {
      const msg = data && typeof data.message === 'string' ? '：' + clip(data.message, 200) : '';
      throw new Error('图片接口 HTTP ' + resp.status + msg);
    }
    return data;
  }

  // 下载接口返回的临时图片 URL。
  async function downloadUrl(url) {
    const resp = await fetchWithTimeout(url, { method: 'GET' });
    if (!resp || resp.ok === false || (typeof resp.status === 'number' && resp.status >= 400)) {
      throw new Error('下载图片失败 HTTP ' + (resp && resp.status));
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('下载图片为空');
    return buf;
  }

  // gateway / local：OpenAI 格式 /images/generations，取 b64_json。
  async function callImageApi(prompt, isGateway) {
    const headers = {};
    let body;
    if (isGateway) {
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      body = { model, prompt, size: gatewaySize, n: 1, response_format: 'b64_json', watermark: false };
    } else {
      body = { prompt, size, response_format: 'b64_json' };
    }
    const data = await postJson((isGateway ? gatewayBase : localBase) + '/images/generations', headers, body);
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (typeof b64 !== 'string' || !b64) throw new Error('图片接口缺少 data[0].b64_json');
    return Buffer.from(b64, 'base64');
  }

  // 硅基流动（Kolors，免费）：返回 images[0].url，需再下载。
  async function callSiliconflow(prompt, style) {
    if (!sfKey) throw new Error('未配置 SILICONFLOW_API_KEY');
    const data = await postJson(SILICONFLOW_URL, { Authorization: `Bearer ${sfKey}` }, {
      model: sfModel, prompt,
      negative_prompt: '文字，印章，书法，落款，水印，签名，边框，模糊，畸形' + (style && style.avoidZh ? '，' + style.avoidZh : ''),
      image_size: FREE_SIZE, batch_size: 1, num_inference_steps: 20, guidance_scale: 7.5,
    });
    const u = data && Array.isArray(data.images) && data.images[0] && data.images[0].url;
    if (typeof u !== 'string' || !u) throw new Error('硅基流动返回缺少 images[0].url');
    return downloadUrl(u);
  }

  // 智谱（cogview-3-flash，免费）：返回 data[0].url，需再下载。
  async function callZhipu(prompt) {
    if (!zpKey) throw new Error('未配置 ZHIPU_API_KEY');
    const data = await postJson(ZHIPU_URL, { Authorization: `Bearer ${zpKey}` }, {
      model: zpModel, prompt, size: FREE_SIZE, watermark_enabled: false,
    });
    const u = data && Array.isArray(data.data) && data.data[0] && data.data[0].url;
    if (typeof u !== 'string' || !u) throw new Error('智谱返回缺少 data[0].url');
    return downloadUrl(u);
  }

  // 魔搭（Z-Image-Turbo 等，免费额度）：异步提交任务 → 每 2 秒轮询 → 下载 output_images[0]。
  async function callModelscope(prompt) {
    if (!msKey) throw new Error('未配置 MODELSCOPE_API_KEY');
    const auth = { Authorization: `Bearer ${msKey}` };
    const sub = await postJson(MODELSCOPE_URL, Object.assign({ 'X-ModelScope-Async-Mode': 'true' }, auth), {
      model: msModel, prompt, size: FREE_SIZE,
    });
    const taskId = sub && sub.task_id;
    if (typeof taskId !== 'string' || !taskId) throw new Error('魔搭返回缺少 task_id');
    const maxPolls = Math.ceil(MODELSCOPE_TIMEOUT_MS / MODELSCOPE_POLL_MS);
    for (let i = 0; i < maxPolls; i++) {
      await sleepFn(MODELSCOPE_POLL_MS);
      const resp = await fetchWithTimeout(MODELSCOPE_TASK_URL + encodeURIComponent(taskId), {
        method: 'GET', headers: Object.assign({ 'X-ModelScope-Task-Type': 'image_generation' }, auth),
      });
      if (!resp || resp.ok === false || (typeof resp.status === 'number' && resp.status >= 400)) {
        throw new Error('魔搭任务查询 HTTP ' + (resp && resp.status));
      }
      const t = await resp.json();
      const st = t && t.task_status;
      if (st === 'SUCCEED') {
        const u = Array.isArray(t.output_images) && t.output_images[0];
        if (typeof u !== 'string' || !u) throw new Error('魔搭返回缺少 output_images[0]');
        return downloadUrl(u);
      }
      if (st === 'FAILED') {
        const why = (t.errors && (t.errors.message || JSON.stringify(t.errors))) || t.message || '';
        throw new Error('魔搭任务失败' + (why ? '：' + clip(String(why), 200) : ''));
      }
    }
    throw new Error(`魔搭任务超时（${MODELSCOPE_TIMEOUT_MS}ms）`);
  }

  // Cloudflare Workers AI（flux-1-schnell，每日免费 Neurons 额度）：同步返回 base64 图片。
  async function callCloudflare(prompt) {
    if (!cfAccount || !cfToken) throw new Error('未配置 CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN');
    const url = CLOUDFLARE_API_BASE + encodeURIComponent(cfAccount) + '/ai/run/' + cfModel;
    const data = await postJson(url, { Authorization: `Bearer ${cfToken}` }, { prompt, steps: 4 });
    if (data && data.success === false) {
      const e = Array.isArray(data.errors) && data.errors[0];
      throw new Error('Cloudflare 错误：' + clip((e && e.message) || JSON.stringify(data.errors), 200));
    }
    const b64 = data && data.result && data.result.image;
    if (typeof b64 !== 'string' || !b64) throw new Error('Cloudflare 返回缺少 result.image');
    return Buffer.from(b64, 'base64');
  }

  // 用单个提供方出一张图：返回 {bytes, prompt, enPrompt, model}。
  async function runProvider(p, job) {
    if (p === 'siliconflow') {
      const prompt = gatewayPrompt(job);
      return { bytes: await callSiliconflow(prompt, job.style), prompt, enPrompt: '', model: sfModel };
    }
    if (p === 'cloudflare') {
      // flux 看不懂中文（会画成书法字），复用 local 的翻译 + 英文提示词。
      let enPrompt = await translate(job);
      if (!enPrompt) enPrompt = job.kind === 'npc' ? 'a mysterious person' : 'a mysterious item';
      const prompt = localPrompt(enPrompt, job.kind, job.style.en, job.style.eraEn, job.style.bgEn);
      return { bytes: await callCloudflare(prompt), prompt, enPrompt, model: cfModel };
    }
    if (p === 'modelscope') {
      const prompt = gatewayPrompt(job);
      return { bytes: await callModelscope(prompt), prompt, enPrompt: '', model: msModel };
    }
    if (p === 'zhipu') {
      const prompt = gatewayPrompt(job);
      return { bytes: await callZhipu(prompt), prompt, enPrompt: '', model: zpModel };
    }
    if (p === 'gateway') {
      const prompt = gatewayPrompt(job);
      return { bytes: await callImageApi(prompt, true), prompt, enPrompt: '', model };
    }
    // local：先翻译，再拼英文提示词。
    let enPrompt = await translate(job);
    if (!enPrompt) enPrompt = job.kind === 'npc' ? 'a mysterious person' : 'a mysterious item';
    const prompt = localPrompt(enPrompt, job.kind, job.style.en, job.style.eraEn, job.style.bgEn);
    return { bytes: await callImageApi(prompt, false), prompt, enPrompt, model: 'local' };
  }

  // 按回退链依次尝试；最近失败过的提供方排到最后。全部失败才抛错。
  async function generate(job) {
    const now = nowFn();
    const fresh = chain.filter((p) => !(providerCooldown.get(p) > now));
    const order = fresh.concat(chain.filter((p) => !fresh.includes(p)));
    const errors = [];
    for (const p of order) {
      try {
        const r = await runProvider(p, job);
        providerCooldown.delete(p);
        return Object.assign({ provider: p }, r);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        errors.push(`${p}：${msg}`);
        if (chain.length > 1) {
          providerCooldown.set(p, nowFn() + PROVIDER_COOLDOWN_MS);
          console.warn(`[images] ${p} 出图失败，换下一家：${msg}`);
        }
      }
    }
    throw new Error(errors.join('；'));
  }

  async function processJob(job) {
    const t0 = nowFn();
    let ok = false;
    let usedProvider = provider;
    let usedModel = chain[0] === 'gateway' ? model : 'local';
    try {
      let filename;
      let bytes;
      let enPrompt = '';
      let prompt = '';
      if (mock) {
        // LLM_MOCK=1：不访问网络，写一张小的占位 SVG。
        filename = svgName(job.kind, job.key);
        bytes = Buffer.from(mockSvg(job.name), 'utf8');
      } else {
        const r = await generate(job);
        bytes = r.bytes;
        prompt = r.prompt;
        enPrompt = r.enPrompt;
        usedProvider = r.provider;
        usedModel = r.model;
        const isPng = bytes && bytes.length >= 4
          && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
        filename = isPng ? pngName(job.kind, job.key) : jpgName(job.kind, job.key);
      }
      writeBinaryAtomic(path.join(imagesDir(job.dataDir), filename), bytes);
      updateEntry(job.dataDir, job.indexKey, {
        kind: job.kind, name: job.name, style: job.style.zh, worldId: job.worldId,
        file: filename, status: 'ready', ts: nowFn(),
        enPrompt, prompt, provider: usedProvider,
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
          ts: nowFn(), kind: 'image', provider: usedProvider,
          model: usedModel,
          ok, ms: nowFn() - t0, worldId: job.worldId,
        });
      } catch (e) {
        console.warn('[images] 记录用量失败：' + (e && e.message ? e.message : e));
      }
    }
  }

  function notifyIdle() {
    if (active !== 0 || queue.length !== 0 || artJobs.size !== 0 || idleWaiters.length === 0) return;
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
      const resolved = resolveStyle(dataDir, s, list);
      if (!resolved.ready) return; // 画风设定生成中，完成后会自动重新 ensure
      const style = resolved.style;
      const idx = readIndex(dataDir);
      let changed = false;
      let wcount = null;
      if (paid) {
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
            // 本进程正在生成才跳过；不在 inFlight 里的 pending 是上个进程（重启前）留下的，照常重新排队。
            if (inFlight.has(ik)) continue;
          } else if (cur.status === 'failed') {
            if (nowFn() - (Number(cur.ts) || 0) < FAILED_COOLDOWN_MS) continue; // 冷却
          }
        }
        if (paid && wcount >= maxPerWorld) continue; // 花钱上限（链里有付费 gateway 时生效）
        if (inFlight.has(ik)) continue;                                  // 同一 key 不重复排队
        idx[ik] = Object.assign({}, cur || {}, {
          kind, name, style: style.zh, worldId,
          file: null, status: 'pending', ts: nowFn(),
        });
        changed = true;
        inFlight.add(ik);
        if (paid) { wcount += 1; worldCount.set(worldId, wcount); }
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
    return buildImageList(dataDir, state, ensureImages, (wid) => artJobs.has(wid));
  }

  function waitIdle() {
    if (active === 0 && queue.length === 0 && artJobs.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  // 用量面板用：出图链 + 仍在冷却的提供方剩余毫秒（只列还在冷却的）。
  function providerStatus() {
    const now = nowFn();
    const cooling = {};
    for (const [p, until] of providerCooldown) {
      if (until > now) cooling[p] = until - now;
    }
    return { chain: chain.slice(), cooling };
  }

  return {
    ensureImages, imageList, waitIdle, serveImage, readIndex, listForState, providerStatus,
    config: { provider, providers: chain.slice(), base, model, size, maxPerWorld, concurrency, mock, off },
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
  FILE_NAME_RE, FAILED_COOLDOWN_MS, IMAGE_TIMEOUT_MS, PROVIDER_COOLDOWN_MS,
  SILICONFLOW_URL, ZHIPU_URL, MODELSCOPE_URL, MODELSCOPE_TASK_URL, CLOUDFLARE_API_BASE,
  // 默认实例委托
  ensureImages, imageList, waitIdle,
};
