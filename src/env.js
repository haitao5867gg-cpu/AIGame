'use strict';

// 第 2 节：.env 配置解析，零第三方依赖（不用 dotenv）。
// 只用 node 内置模块；路径一律交给 path，保证 Windows 兼容。

const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  LLM_BASE: '',
  LLM_API_KEY: '',
  LLM_MODEL: 'deepseek-v4.1-flash',
  LLM_MODEL_WORLD: 'deepseek-v4-pro-0813',
  LLM_MOCK: '0',
  LLM_TIMEOUT_MS: '90000',
  LLM_DAILY_TOKEN_LIMIT: '2000000',
  PORT: '8787',
  HOST: '0.0.0.0',
  DATA_DIR: './data',
});

const NUMERIC_KEYS = Object.freeze(['LLM_TIMEOUT_MS', 'LLM_DAILY_TOKEN_LIMIT', 'PORT']);
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 解析 .env 文本为普通对象。纯函数，不读文件、不碰 process.env。
 * 支持：# 注释行、空行、CRLF、KEY=VALUE、export KEY=VALUE、
 * 引号包裹的值（保留内部 #）、行尾「空白 + #」的内联注释。
 */
function parse(text) {
  const out = {};
  const lines = String(text == null ? '' : text).split(/\r?\n/);
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

function normalize(raw) {
  const cfg = Object.assign({}, raw);
  cfg.LLM_MOCK = isMock(cfg.LLM_MOCK);
  for (const key of NUMERIC_KEYS) {
    cfg[key] = toNumber(cfg[key], DEFAULTS[key]);
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
function withoutKey(cfg) {
  const out = Object.assign({}, cfg);
  delete out.LLM_API_KEY;
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
