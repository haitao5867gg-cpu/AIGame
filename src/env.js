'use strict';

// 第 2 节：.env 配置解析，零第三方依赖（不用 dotenv）。
// 只用 node 内置模块；路径一律交给 path，保证 Windows 兼容。

const fs = require('node:fs');
const path = require('node:path');

// 建世界 / 编年史默认与回合用同一个（快）模型：pro 模型建世界要 80 秒太慢。
const DEFAULT_LLM_MODEL = 'deepseek-v4.1-flash';

const DEFAULTS = Object.freeze({
  LLM_BASE: '',
  LLM_API_KEY: '',
  LLM_MODEL: DEFAULT_LLM_MODEL,
  LLM_MODEL_WORLD: DEFAULT_LLM_MODEL,
  LLM_MOCK: '0',
  LLM_TIMEOUT_MS: '90000',
  LLM_DAILY_TOKEN_LIMIT: '2000000',
  // 每位玩家（含主人）各自的每日 token 上限；0 表示不限。与全局上限相互独立。
  LLM_PLAYER_DAILY_TOKEN_LIMIT: '1000000',
  LLM_EXTRA_BODY: '', // JSON 字符串，合并进 LLM 请求体；解析失败忽略并告警
  LLM_BASE_URL: '',  // LLM_BASE 的别名；gateway 图片默认复用「LLM base URL」
  PORT: '8787',
  HOST: '0.0.0.0',
  DATA_DIR: './data',
  // 公网来客访问密码；留空则首次启动自动生成 6 位数字，与 HMAC 密钥一起存入 data/access.json。
  ACCESS_PASSWORD: '',
  // ---- 朋友访问：自动启动 Cloudflare 临时隧道（见 src/tunnel.js）----
  // TUNNEL=off 表示不启动；CLOUDFLARED_PATH 留空则自动查找 cloudflared。
  TUNNEL: 'on',
  CLOUDFLARED_PATH: '',
  // ---- 图片生成（第 7 节）----
  // 出图提供方，可写成逗号分隔的回退链，如 siliconflow,zhipu,local（前一家失败就换下一家）。
  // 可选：siliconflow（硅基流动 Kolors，免费）| zhipu（智谱 cogview-3-flash，免费）| gateway（付费）| local | off
  IMAGE_PROVIDER: 'local',
  IMAGE_BASE_URL: '',              // 空则按提供方取默认（见 normalize）
  IMAGE_MODEL: 'Doubao-seedream-4.0', // gateway 用
  IMAGE_SIZE: '768x768',          // 本地服务上限 768（8G 显存）；gateway 时请设 1024x1024
  IMAGE_MAX_PER_WORLD: '40',      // 仅 gateway 生效，防止花钱失控
  IMAGE_CONCURRENCY: '1',
  IMAGE_SCENE_DAILY_PER_PLAYER: '60', // 每位来客每天场景插图（kind=scene）上限；0 表示不限，主人不受限
  SILICONFLOW_API_KEY: '',
  IMAGE_SILICONFLOW_MODEL: 'Kwai-Kolors/Kolors',
  ZHIPU_API_KEY: '',
  IMAGE_ZHIPU_MODEL: 'cogview-3-flash',
  MODELSCOPE_API_KEY: '',
  CLOUDFLARE_ACCOUNT_ID: '',
  CLOUDFLARE_API_TOKEN: '',
  IMAGE_CLOUDFLARE_MODEL: '@cf/black-forest-labs/flux-1-schnell',
  IMAGE_MODELSCOPE_MODEL: 'Tongyi-MAI/Z-Image-Turbo',
  // 本地画图服务由游戏服务看护启动（src/imgsupervisor.js）；不配 IMAGE_LOCAL_PYTHON 则不启动
  IMAGE_LOCAL_PYTHON: '',
  IMAGE_HF_HOME: '',
  IMAGE_LORA: '',
  IMAGE_LOCAL_MIN_FREE_MB: '7000', // 空闲内存低于此值不启动本地画图服务（加载峰值约 5.7G）
});

const NUMERIC_KEYS = Object.freeze([
  'LLM_TIMEOUT_MS', 'LLM_DAILY_TOKEN_LIMIT', 'LLM_PLAYER_DAILY_TOKEN_LIMIT', 'PORT',
  'IMAGE_MAX_PER_WORLD', 'IMAGE_CONCURRENCY', 'IMAGE_SCENE_DAILY_PER_PLAYER', 'IMAGE_LOCAL_MIN_FREE_MB',
]);
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 .env 文本为普通对象。纯函数，不读文件、不碰 process.env。
 * 支持：# 注释行、空行、CRLF、KEY=VALUE、export KEY=VALUE、
 * 引号包裹的值（保留内部 #）、行尾「空白 + #」的内联注释。
 */
function parse(text) {
  const out = {};
  // Windows PowerShell 写出的 .env 常带 UTF-8 BOM（\uFEFF），放在首个键名前会导致
  // 该行键名不合法而被整行忽略；这里在解析前统一去掉开头的 BOM。
  const src = String(text == null ? '' : text).replace(/^\uFEFF+/, '');
  const lines = src.split(/\r?\n/);
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line[0] === '#') continue;
    if (/^export\s+/.test(line)) line = line.replace(/^export\s+/, '');
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_PATTERN.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (value[0] === '"' || value[0] === "'") {
      const quote = value[0];
      const close = value.lastIndexOf(quote);
      value = close > 0 ? value.slice(1, close) : value.slice(1);
    } else {
      const hash = value.search(/\s+#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

function toNumber(value, fallback) {
  const n = Number(String(value == null ? '' : value).trim());
  return Number.isFinite(n) && n >= 0 ? n : Number(fallback);
}

function isMock(value) {
  if (typeof value === 'boolean') return value;
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

const IMAGE_PROVIDERS = Object.freeze(['siliconflow', 'cloudflare', 'modelscope', 'zhipu', 'gateway', 'local']);

function normalizeProviders(value) {
  const parts = String(value == null ? '' : value).toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (parts.length === 1 && parts[0] === 'off') return 'off';
  const chain = [];
  for (const p of parts) if (IMAGE_PROVIDERS.includes(p) && !chain.includes(p)) chain.push(p);
  return chain.length ? chain.join(',') : 'local';
}

function normalize(raw) {
  const cfg = Object.assign({}, raw);
  cfg.LLM_MOCK = isMock(cfg.LLM_MOCK);
  for (const key of NUMERIC_KEYS) {
    cfg[key] = toNumber(cfg[key], DEFAULTS[key]);
  }
  // 归一化图片提供方（可为逗号分隔的回退链）；非法项丢弃，全部非法则回退 local。
  cfg.IMAGE_PROVIDER = normalizeProviders(cfg.IMAGE_PROVIDER);
  // IMAGE_BASE_URL 未显式配置时按链里第一个 HTTP 型提供方（gateway / local）取默认：
  //  - gateway → LLM base URL（cfg.LLM_BASE，别名 LLM_BASE_URL 亦可）
  //  - 其余 → 本地显卡服务地址（siliconflow / zhipu 地址固定，不用它）
  if (!cfg.IMAGE_BASE_URL) {
    const firstHttp = cfg.IMAGE_PROVIDER.split(',').find((p) => p === 'gateway' || p === 'local');
    cfg.IMAGE_BASE_URL = firstHttp === 'gateway'
      ? (cfg.LLM_BASE_URL || cfg.LLM_BASE || '')
      : 'http://127.0.0.1:8790/v1';
  }
  return cfg;
}

/**
 * 读取 .env 并合成配置。
 * 优先级：显式传入的 env（默认 process.env）> .env 文件 > DEFAULTS。
 * .env 不存在时静默使用默认值；其它读取错误照常抛出。
 */
function load(dotenvPath, env) {
  const file = dotenvPath == null ? path.join(process.cwd(), '.env') : dotenvPath;
  const environ = env || process.env;
  let fromFile = {};
  try {
    fromFile = parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const raw = Object.assign({}, DEFAULTS, fromFile);
  for (const key of Object.keys(DEFAULTS)) {
    if (environ[key] !== undefined) raw[key] = environ[key];
  }
  return normalize(raw);
}

// 便捷入口：按 cwd 下的 .env 加载。
function getConfig() {
  return load();
}

// 接口返回前调用：绝不把 Key 带出去。
// 新增的 IMAGE_* 配置里没有密钥；这里把所有名字含 key 的字段一并剔除，
// 防止将来新增配置时把鉴权信息带进脱敏输出（gateway 的 Key 只用于请求头）。
function withoutKey(cfg) {
  const out = Object.assign({}, cfg);
  for (const key of Object.keys(out)) {
    if (/api.?key/i.test(key) || /key$/i.test(key) || /token$/i.test(key) || /password$/i.test(key)) delete out[key];
  }
  return out;
}

// 把可能是相对路径的 DATA_DIR 解析成绝对路径（Windows 兼容）。
function resolveDataDir(cfg, cwd) {
  return path.resolve(cwd || process.cwd(), cfg.DATA_DIR || DEFAULTS.DATA_DIR);
}

module.exports = {
  DEFAULTS,
  parse,
  load,
  getConfig,
  withoutKey,
  resolveDataDir,
};
