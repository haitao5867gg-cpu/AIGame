'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const llm = require('../src/llm.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-llm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function baseCfg(overrides) {
  return Object.assign({
    LLM_MOCK: false,
    LLM_BASE: 'https://example.test/v1',
    LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'test-model',
    LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0,
    LLM_EXTRA_BODY: '',
  }, overrides || {});
}

// 拦截全局 fetch：记录请求体，返回合法的 chat/completions 响应，执行 fn 后返回记录。
async function captureFetch(t, fn) {
  const original = global.fetch;
  let captured = null;
  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":1}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      }),
    };
  };
  t.after(() => { global.fetch = original; });
  await fn();
  return captured;
}

function stubWarn(t) {
  const original = console.warn;
  const warns = [];
  console.warn = (msg) => warns.push(String(msg));
  t.after(() => { console.warn = original; });
  return warns;
}

test('parseExtraBody: 合法 JSON 对象、空值、解析失败 / 非对象时忽略并告警', (t) => {
  assert.deepEqual(llm.parseExtraBody(''), {});
  assert.deepEqual(llm.parseExtraBody(null), {});
  assert.deepEqual(llm.parseExtraBody('   '), {});
  assert.deepEqual(llm.parseExtraBody('{"thinking":{"type":"disabled"}}'), { thinking: { type: 'disabled' } });

  const warns = stubWarn(t);
  for (const bad of ['{bad json', '[1,2]', '42', '"str"', 'null', 'true']) {
    assert.deepEqual(llm.parseExtraBody(bad), {}, `应忽略：${bad}`);
  }
  assert.ok(warns.length >= 6, '非法值应逐条告警');
  assert.ok(warns.every((w) => w.includes('LLM_EXTRA_BODY')));
});

test('LLM_EXTRA_BODY: 合并进请求体，但 model/messages/response_format 不被覆盖', async (t) => {
  const cfg = baseCfg({
    LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"},"temperature":0.5,"model":"hacked"}',
  });
  const client = llm.createClient(cfg, tmpDir(t));
  const captured = await captureFetch(t, async () => {
    await client.complete({
      purpose: 'turn',
      model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
      responseFormat: 'json_object',
    });
  });
  const body = captured.body;
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0.5);
  assert.equal(body.model, 'test-model', '外部不能覆盖 model');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.ok(captured.url.endsWith('/chat/completions'));
});

test('LLM_EXTRA_BODY: 解析失败时请求体不带多余键，仍能正常完成调用', async (t) => {
  const warns = stubWarn(t);
  const cfg = baseCfg({ LLM_EXTRA_BODY: '{非法 json' });
  const client = llm.createClient(cfg, tmpDir(t));
  let res;
  const captured = await captureFetch(t, async () => {
    res = await client.complete({
      purpose: 'turn', model: 'test-model',
      messages: [{ role: 'user', content: 'hi' }],
    });
  });
  assert.equal(res.ok, true);
  assert.equal(res.content, '{"ok":1}');
  assert.equal('thinking' in captured.body, false);
  assert.equal(Object.keys(captured.body).sort().join(','), 'messages,model,response_format');
  assert.ok(warns.some((w) => w.includes('解析失败')));
});

test('LLM_EXTRA_BODY: 未设置时请求体只有标准字段，不产生告警', async (t) => {
  const warns = stubWarn(t);
  const cfg = baseCfg();
  delete cfg.LLM_EXTRA_BODY;
  const client = llm.createClient(cfg, tmpDir(t));
  const captured = await captureFetch(t, async () => {
    await client.complete({ purpose: 'turn', model: 'test-model', messages: [] });
  });
  assert.equal(Object.keys(captured.body).sort().join(','), 'messages,model,response_format');
  assert.equal(warns.length, 0);
});

test('mock 模式不发起网络请求，parseExtraBody 仍可用', async (t) => {
  const cfg = baseCfg({ LLM_MOCK: true, LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}' });
  const client = llm.createClient(cfg, tmpDir(t));
  const res = await client.complete({ purpose: 'turn', model: 'm', messages: [], mock: { turn: 1 } });
  assert.equal(res.ok, true);
  assert.equal(typeof res.content, 'string');
  assert.deepEqual(llm.parseExtraBody('{"a":1}'), { a: 1 });
});
