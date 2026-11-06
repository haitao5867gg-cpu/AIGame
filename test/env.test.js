'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const env = require('../src/env.js');

function tmpFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, text, 'utf8');
  return { dir, file };
}

function missingFile() {
  return path.join(os.tmpdir(), `aigame-no-such-env-${process.pid}-${Date.now()}`);
}

test('parse: KEY=VALUE、# 注释、空行、CRLF、无 = 的行', () => {
  const out = env.parse(
    '# 这是注释\r\n\r\n' +
      'LLM_BASE=https://example.com/v1\r\n' +
      'LLM_MODEL = deepseek-x\r\n' +
      'BROKEN_LINE\r\n' +
      '=novalue\r\n' +
      '  # 缩进注释\n',
  );
  assert.equal(out.LLM_BASE, 'https://example.com/v1');
  assert.equal(out.LLM_MODEL, 'deepseek-x');
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'BROKEN_LINE'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, ''), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, '# 这是注释'), false);
});

test('parse: 引号值、内联注释、export、空值、非法键名', () => {
  const out = env.parse(
    [
      'A="hello # world"   # 行尾注释',
      "B='single quoted'",
      'C=plain # comment',
      'D=hash#nospace',
      'export E=1',
      'EMPTY=',
      '1BAD=x',
      'BAD-KEY=y',
    ].join('\n'),
  );
  assert.equal(out.A, 'hello # world');
  assert.equal(out.B, 'single quoted');
  assert.equal(out.C, 'plain');
  assert.equal(out.D, 'hash#nospace');
  assert.equal(out.E, '1');
  assert.equal(out.EMPTY, '');
  assert.equal(Object.prototype.hasOwnProperty.call(out, '1BAD'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(out, 'BAD-KEY'), false);
});

test('parse: 去掉开头的 UTF-8 BOM（Windows PowerShell 写的文件）', () => {
  const bom = '\uFEFF';
  const out = env.parse(bom + 'PORT=9999\nLLM_MOCK=1\nLLM_API_KEY=abc\n');
  assert.equal(out.PORT, '9999');
  assert.equal(out.LLM_MOCK, '1');
  assert.equal(out.LLM_API_KEY, 'abc');
  // 不带 BOM 时行为不变
  assert.equal(env.parse('PORT=9999\n').PORT, '9999');
  // BOM 单独出现 / 只有 BOM 不抛错
  assert.deepEqual(env.parse(bom), {});
  assert.deepEqual(env.parse(bom + bom + 'A=1'), { A: '1' });
});

test('load: 带 BOM 的 .env 首行仍能被解析（优先级与默认值正确）', () => {
  const { dir, file } = tmpFile('\uFEFFPORT=4321\nLLM_MOCK=1\n');
  try {
    const cfg = env.load(file, {});
    assert.equal(cfg.PORT, 4321);
    assert.equal(cfg.LLM_MOCK, true);
    assert.equal(cfg.LLM_MODEL_WORLD, cfg.LLM_MODEL);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parse: 非字符串输入不抛错', () => {
  assert.deepEqual(env.parse(null), {});
  assert.deepEqual(env.parse(undefined), {});
  assert.deepEqual(env.parse(''), {});
});

test('load: .env 不存在时全部使用规格默认值', () => {
  const cfg = env.load(missingFile(), {});
  assert.equal(cfg.LLM_BASE, '');
  assert.equal(cfg.LLM_API_KEY, '');
  assert.equal(cfg.LLM_MODEL, 'deepseek-v4.1-flash');
  // 默认与 LLM_MODEL 相同（pro 模型建世界太慢）。
  assert.equal(cfg.LLM_MODEL_WORLD, cfg.LLM_MODEL);
  assert.equal(cfg.LLM_MOCK, false);
  assert.equal(cfg.LLM_TIMEOUT_MS, 90000);
  assert.equal(cfg.LLM_DAILY_TOKEN_LIMIT, 2000000);
  assert.equal(cfg.PORT, 8787);
  assert.equal(cfg.HOST, '0.0.0.0');
  assert.equal(cfg.DATA_DIR, './data');
});

test('load: 文件值、数值转换、mock 布尔、PORT=0', () => {
  const { dir, file } = tmpFile(
    'LLM_MOCK=1\nPORT=0\nLLM_TIMEOUT_MS=1200\nLLM_API_KEY=secret-xyz\nDATA_DIR=./mydata\n',
  );
  try {
    const cfg = env.load(file, {});
    assert.equal(cfg.LLM_MOCK, true);
    assert.equal(cfg.PORT, 0);
    assert.equal(cfg.LLM_TIMEOUT_MS, 1200);
    assert.equal(cfg.LLM_API_KEY, 'secret-xyz');
    assert.equal(cfg.DATA_DIR, './mydata');
    assert.equal(typeof cfg.LLM_TIMEOUT_MS, 'number');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load: 显式环境变量优先级高于 .env 文件', () => {
  const { dir, file } = tmpFile('PORT=1111\nLLM_MOCK=1\nLLM_MODEL=from-file\n');
  try {
    const cfg = env.load(file, { PORT: '9999', LLM_MOCK: '0' });
    assert.equal(cfg.PORT, 9999);
    assert.equal(cfg.LLM_MOCK, false);
    assert.equal(cfg.LLM_MODEL, 'from-file');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load: LLM_MOCK 的各种真值 / 非法数值回退默认值', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
    assert.equal(env.load(missingFile(), { LLM_MOCK: v }).LLM_MOCK, true, `mock=${v}`);
  }
  for (const v of ['0', 'false', '', 'no']) {
    assert.equal(env.load(missingFile(), { LLM_MOCK: v }).LLM_MOCK, false, `mock=${v}`);
  }
  assert.equal(env.load(missingFile(), { LLM_TIMEOUT_MS: 'not-a-number' }).LLM_TIMEOUT_MS, 90000);
  assert.equal(env.load(missingFile(), { PORT: '-3' }).PORT, 8787);
});

test('load: .env 里的额外键原样保留', () => {
  const { dir, file } = tmpFile('CUSTOM_FLAG=hello\n');
  try {
    assert.equal(env.load(file, {}).CUSTOM_FLAG, 'hello');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('load: LLM_EXTRA_BODY 默认空串，可由 .env / 环境变量读取', () => {
  assert.equal(env.load(missingFile(), {}).LLM_EXTRA_BODY, '');
  const { dir, file } = tmpFile('LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}\n');
  try {
    assert.equal(env.load(file, {}).LLM_EXTRA_BODY, '{"thinking":{"type":"disabled"}}');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const fromEnv = env.load(missingFile(), { LLM_EXTRA_BODY: '{"temperature":0.5}' });
  assert.equal(fromEnv.LLM_EXTRA_BODY, '{"temperature":0.5}');
});

test('withoutKey: 接口返回里绝不带 Key', () => {
  const cfg = env.load(missingFile(), {});
  cfg.LLM_API_KEY = 'sk-super-secret';
  const pub = env.withoutKey(cfg);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'LLM_API_KEY'), false);
  assert.equal(JSON.stringify(pub).includes('sk-super-secret'), false);
  assert.equal(cfg.LLM_API_KEY, 'sk-super-secret'); // 原对象不被修改
});

test('resolveDataDir: 用 path.resolve，Windows 兼容', () => {
  const cwd = path.join(os.tmpdir(), 'aigame-cwd');
  assert.equal(env.resolveDataDir({ DATA_DIR: './data' }, cwd), path.resolve(cwd, './data'));
  assert.equal(env.resolveDataDir({ DATA_DIR: 'custom' }, cwd), path.resolve(cwd, 'custom'));
  assert.equal(env.resolveDataDir({}, cwd), path.resolve(cwd, './data'));
});

test('getConfig 是可用函数', () => {
  assert.equal(typeof env.getConfig, 'function');
  assert.equal(typeof env.getConfig().LLM_MODEL, 'string');
});

// ---- 图片配置（第 7 节）----
test('load: IMAGE_* 规格默认值（local / 768x768 / 40 / 1 / model）', () => {
  const cfg = env.load(missingFile(), {});
  assert.equal(cfg.IMAGE_PROVIDER, 'local');
  assert.equal(cfg.IMAGE_BASE_URL, 'http://127.0.0.1:8790/v1');
  assert.equal(cfg.IMAGE_MODEL, 'Doubao-seedream-4.0');
  assert.equal(cfg.IMAGE_SIZE, '768x768');
  assert.equal(cfg.IMAGE_MAX_PER_WORLD, 40);
  assert.equal(cfg.IMAGE_CONCURRENCY, 1);
  assert.equal(typeof cfg.IMAGE_MAX_PER_WORLD, 'number');
  assert.equal(typeof cfg.IMAGE_CONCURRENCY, 'number');
});

test('load: IMAGE_PROVIDER 归一化（非法值回退 local、大小写不敏感）', () => {
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'GATEWAY' }).IMAGE_PROVIDER, 'gateway');
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'off' }).IMAGE_PROVIDER, 'off');
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'weird' }).IMAGE_PROVIDER, 'local');
  assert.equal(env.load(missingFile(), {}).IMAGE_PROVIDER, 'local');
});

test('load: gateway 的默认 base = LLM base URL，可显式覆盖', () => {
  // gateway 默认复用 LLM_BASE（即描述里的「LLM_BASE_URL」）。
  const a = env.load(missingFile(), { IMAGE_PROVIDER: 'gateway', LLM_BASE: 'https://gw.example/v1' });
  assert.equal(a.IMAGE_BASE_URL, 'https://gw.example/v1');
  // 别名 LLM_BASE_URL 亦支持（可作为环境变量/文件项传入）。
  const b = env.load(missingFile(), { IMAGE_PROVIDER: 'gateway', LLM_BASE_URL: 'https://alias.example/v1' });
  assert.equal(b.IMAGE_BASE_URL, 'https://alias.example/v1');
  // 显式 IMAGE_BASE_URL 优先级最高。
  const c = env.load(missingFile(), {
    IMAGE_PROVIDER: 'gateway', LLM_BASE: 'https://gw.example/v1', IMAGE_BASE_URL: 'https://img.example/v1',
  });
  assert.equal(c.IMAGE_BASE_URL, 'https://img.example/v1');
  // local 不受 LLM_BASE 影响。
  const d = env.load(missingFile(), { LLM_BASE: 'https://gw.example/v1' });
  assert.equal(d.IMAGE_BASE_URL, 'http://127.0.0.1:8790/v1');
});

test('load: IMAGE_MAX_PER_WORLD / IMAGE_CONCURRENCY 数值转换与非法回退', () => {
  assert.equal(env.load(missingFile(), { IMAGE_MAX_PER_WORLD: '3', IMAGE_CONCURRENCY: '4' }).IMAGE_MAX_PER_WORLD, 3);
  assert.equal(env.load(missingFile(), { IMAGE_MAX_PER_WORLD: '3', IMAGE_CONCURRENCY: '4' }).IMAGE_CONCURRENCY, 4);
  assert.equal(env.load(missingFile(), { IMAGE_CONCURRENCY: 'bad' }).IMAGE_CONCURRENCY, 1);
  assert.equal(env.load(missingFile(), { IMAGE_MAX_PER_WORLD: '-1' }).IMAGE_MAX_PER_WORLD, 40);
});

test('withoutKey: 新增 IMAGE_* 后脱敏输出仍不含任何 Key', () => {
  const cfg = env.load(missingFile(), {
    IMAGE_PROVIDER: 'gateway', LLM_API_KEY: 'sk-super-secret',
  });
  const pub = env.withoutKey(cfg);
  assert.equal(Object.prototype.hasOwnProperty.call(pub, 'LLM_API_KEY'), false);
  assert.equal(JSON.stringify(pub).includes('sk-super-secret'), false, '脱敏输出不得含 Key 值');
  assert.equal(/key/i.test(JSON.stringify(pub)), false, '脱敏输出不得残留 key 字段');
  assert.equal(pub.IMAGE_PROVIDER, 'gateway'); // 其余配置保留
  assert.equal(cfg.LLM_API_KEY, 'sk-super-secret'); // 原对象不被修改
});

test('load: IMAGE_PROVIDER 回退链（逗号分隔、去重、丢弃非法项；off 只能单独用）', () => {
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'SiliconFlow, zhipu,local' }).IMAGE_PROVIDER, 'siliconflow,zhipu,local');
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'zhipu,weird,zhipu' }).IMAGE_PROVIDER, 'zhipu');
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'weird,off' }).IMAGE_PROVIDER, 'local');
  // 链里第一个 HTTP 型是 local → IMAGE_BASE_URL 默认本地服务
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'siliconflow,local' }).IMAGE_BASE_URL, 'http://127.0.0.1:8790/v1');
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'zhipu,gateway', LLM_BASE: 'https://gw.example/v1' }).IMAGE_BASE_URL, 'https://gw.example/v1');
  assert.equal(env.load(missingFile(), { IMAGE_PROVIDER: 'siliconflow, ModelScope,zhipu,local' }).IMAGE_PROVIDER, 'siliconflow,modelscope,zhipu,local');
  const pub = env.withoutKey(env.load(missingFile(), { SILICONFLOW_API_KEY: 'sf-secret', ZHIPU_API_KEY: 'zp-secret', MODELSCOPE_API_KEY: 'ms-secret' }));
  assert.ok(!JSON.stringify(pub).includes('secret'));
});
