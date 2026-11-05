'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const llm = require('../src/llm.js');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aigame-stream-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 按固定长度把字符串切成若干 chunk，模拟 SSE / 网络把内容任意切开。
function splitBy(raw, size) {
  const out = [];
  for (let i = 0; i < raw.length; i += size) out.push(raw.slice(i, i + size));
  return out;
}

// 用一组 chunk 跑解码器，返回累积回调文本、每次回调、最终 value。
function decodeWithChunks(raw, chunks) {
  const deltas = [];
  const d = llm.createNarrationDecoder((text) => deltas.push(text));
  for (const c of chunks) d.push(c);
  return { text: deltas.join(''), deltas, value: d.value };
}

test('流式解码器：转义 / unicode 转义 / 多字节中文 / narration 非首字段，多种 chunk 切分结果一致', () => {
  // 手工构造原始 JSON 文本（即 LLM 流式吐出的「未完成 JSON」片段拼接后的样子）。
  // narration 不是第一个字段；值里含 \" \\ \/ \n \t \r \b \f \uXXXX 等转义与直接中文。
  const valueEscaped =
    '他说\\"你好\\"\\n第二行\\\\反斜杠\\t制表\\u4E2D\\u6587中文字\\/斜杠\\r回车\\b退格\\f换页';
  const raw = '{"seed":"前缀值", "narration":"' + valueEscaped + '", "tail":[1,2,3]}';
  // 期望值直接由标准 JSON 解析得出，避免手写转义出错。
  const expected = JSON.parse('{"v":"' + valueEscaped + '"}').v;

  // 一次性给全、按 3 字符、按 1 字符（把键名 / 每个转义 / \uXXXX 都从中间切开）都要一致。
  for (const size of [raw.length, 7, 3, 1]) {
    const r = decodeWithChunks(raw, splitBy(raw, size));
    assert.equal(r.text, expected, `chunk 大小 ${size} 时解码结果应一致`);
    assert.equal(r.value, expected, `chunk 大小 ${size} 时 value 应一致`);
    // 逐字符喂入时必须增量回调多次，且没有重复字符。
    if (size === 1) {
      assert.ok(r.deltas.length >= expected.length - 2, '逐字符喂入应产生多次 delta 回调');
    }
  }
});

test('流式解码器：字段 / 键名 / 转义序列跨 chunk 切开仍增量、不丢不重', () => {
  // 故意把 "narration" 键名、开头引号、\uXXXX、\" 转义序列切在不同 chunk。
  const chunks = [
    '{"a":1,"narr',
    'ation":',
    '"甲\\u4E2D',
    '乙\\\\path',
    '\\" quoted\\"',
    ' 中文"}',
  ];
  const raw = chunks.join('');
  const expected = '甲中乙\\path" quoted" 中文';
  const r = decodeWithChunks(raw, chunks);
  assert.equal(r.text, expected);
  assert.equal(r.value, expected);
  assert.ok(r.deltas.length >= 3, '应分多次增量回调');
  // 每个 chunk 之后都不应重复已发出的字符（拼接后恰为最终文本）。
  assert.equal(r.deltas.join('').length, expected.length);
});

test('流式解码器：narration 值为空 / 字符串值里含 "narration" 字样不误判', () => {
  const empty = decodeWithChunks('{"narration":"","x":1}', splitBy('{"narration":"","x":1}', 1));
  assert.equal(empty.text, '', '空叙事不应产生 delta');

  // 前面的字符串值里出现了 narration 字样，但那是「值」不是「键」，不应被当成叙事字段。
  const raw = '{"hint":"别把 \\"narration\\" 当真", "narration":"真正的叙事"}';
  const r = decodeWithChunks(raw, splitBy(raw, 1));
  assert.equal(r.text, '真正的叙事');
});

test('completeStream（真实流路径）：解析 SSE data 行 + 多字节 UTF-8 跨 chunk + 增量回调', async (t) => {
  const dir = tmpDir(t);
  const original = global.fetch;
  let captured = null;
  const full = '{"narration":"雾里传来钟声，中文字\\u4E2D测试。","state_diff":{}}';
  const expected = '雾里传来钟声，中文字中测试。';

  // 把完整 JSON 切成若干 content 片段，每个片段做成一条 SSE data 行。
  const fragments = splitBy(full, 6);
  let sse = '';
  for (const f of fragments) {
    sse += 'data: ' + JSON.stringify({ choices: [{ delta: { content: f } }] }) + '\n\n';
  }
  sse += 'data: [DONE]\n\n';

  // 把整段 SSE 文本按 5 字节切成 Uint8Array —— 必然把中文的 3 字节 UTF-8 序列切到两个 chunk。
  const bytes = Buffer.from(sse, 'utf8');
  const byteChunks = [];
  for (let i = 0; i < bytes.length; i += 5) {
    byteChunks.push(new Uint8Array(bytes.subarray(i, i + 5)));
  }

  global.fetch = async (url, opts) => {
    captured = { url, body: JSON.parse(opts.body) };
    return {
      ok: true,
      body: (async function* () {
        for (const c of byteChunks) yield c;
      })(),
    };
  };
  t.after(() => { global.fetch = original; });

  const client = llm.createClient({
    LLM_MOCK: false, LLM_BASE: 'https://example.test/v1', LLM_API_KEY: 'sk-test',
    LLM_MODEL: 'm', LLM_TIMEOUT_MS: 5000, LLM_DAILY_TOKEN_LIMIT: 0, LLM_EXTRA_BODY: '',
  }, dir);

  const deltas = [];
  const res = await client.completeStream({
    purpose: 'turn', model: 'm', messages: [{ role: 'user', content: 'hi' }],
    responseFormat: 'json_object',
  }, (text) => deltas.push(text));

  assert.equal(captured.body.stream, true, '流式请求体应带 stream:true');
  assert.equal(res.ok, true);
  assert.equal(res.content, full, '流结束后应返回拼接后的完整文本');
  assert.equal(deltas.join(''), expected, '增量回调拼接应为解码后的叙事');
  assert.ok(deltas.length >= 3, '应多次触发 onDelta');
  assert.equal(JSON.parse(res.content).narration, expected,
    '完整文本仍是合法 JSON，后续可照常解析');
});

test('completeStream（mock）：把假叙事切成小块回调、间隔模拟流式，且返回完整 content', async (t) => {
  const client = llm.createClient({
    LLM_MOCK: true, LLM_MODEL: 'm', LLM_TIMEOUT_MS: 5000,
    LLM_DAILY_TOKEN_LIMIT: 0, LLM_EXTRA_BODY: '',
  }, tmpDir(t));
  const deltas = [];
  const res = await client.completeStream({
    purpose: 'turn', model: 'm', messages: [], mock: { turn: 3 },
  }, (text) => deltas.push(text));

  const parsed = JSON.parse(res.content);
  assert.equal(typeof parsed.narration, 'string');
  assert.ok(deltas.length >= 2, 'mock 应把叙事切成多块，多次回调');
  assert.ok(deltas.every((d) => d.length > 0 && d.length <= 6), '每块是较小的片段');
  assert.equal(deltas.join(''), parsed.narration, '回调拼接应等于完整叙事');
  assert.equal(res.ok, true);
});
