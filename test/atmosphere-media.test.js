'use strict';

// 氛围素材 HTTP 音频真实验证（只跑本文件）。
// 复用 public/assets/atmosphere 下真实 MP3，仅做静态 GET/HEAD，不调用任何 AI / TTS / 图片接口。

const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { withServer } = require('./helpers/api-helpers.js');
const { PUBLIC_DIR } = require('../server.js');

const AUDIO_NAME = 'calm-v1.mp3';
const AUDIO_URL = '/assets/atmosphere/' + AUDIO_NAME;
const AUDIO_PATH = path.join(PUBLIC_DIR, 'assets', 'atmosphere', AUDIO_NAME);
const IMAGE_URL = '/assets/atmosphere/lingtian-field-v1.jpg';
const OLD_STATIC_URL = '/app.css';

// 原始字节请求：拿到精确状态码、响应头与二进制 body，且不会自动跟随 302。
function rawRequest(base, method, pathname, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(base);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: pathname,
      method,
      headers: Object.assign({}, headers || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// 临时拦截 fs.createReadStream（server.js 与本文件共用同一 node:fs 实例），
// 记录每次创建的读流及其 close 状态，便于观察客户端 abort 后源流是否被销毁。
function interceptReadStreams() {
  const original = fs.createReadStream;
  const calls = [];
  fs.createReadStream = function (p) {
    const s = original.apply(this, arguments);
    const rec = { path: String(p), stream: s, closed: false };
    s.once('close', () => { rec.closed = true; });
    calls.push(rec);
    return s;
  };
  return {
    calls,
    restore() { fs.createReadStream = original; },
  };
}

// 给可能迟迟不 settle 的 Promise 加超时兜底（reject 也按 fallback 处理）。
function withDeadline(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      () => { clearTimeout(timer); resolve(fallback); }
    );
  });
}

// 轮询等待条件成立，超时返回 null。
async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  let v = predicate();
  while (!v && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    v = predicate();
  }
  return v || null;
}

// 带 cf-ray 模拟经隧道进来的「公网来客」；不带则为 127.0.0.1 主人（无需登录）。
const GUEST = { 'cf-ray': 'test-ray' };

async function main() {
  const expected = fs.readFileSync(AUDIO_PATH); // 真实文件，只读，用于字节比对
  const size = expected.length;
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (err) {
      results.push({ name, ok: false, err });
    }
  };

  await withServer(async ({ base }) => {
    // 1. 全读：200 + 类型/长度/缓存/Accept-Ranges + 字节一致
    await check('全读 200 / audio-mpeg / private 缓存 / 字节一致', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL);
      assert.equal(r.status, 200, '全读应为 200');
      assert.equal(r.headers['content-type'], 'audio/mpeg', 'Content-Type');
      assert.equal(Number(r.headers['content-length']), size, 'Content-Length 应等于真实大小');
      assert.equal(r.headers['cache-control'], 'private, max-age=86400', '氛围目录缓存');
      assert.equal(r.headers['accept-ranges'], 'bytes', '音频应声明 Accept-Ranges');
      assert.ok(r.body.equals(expected), '返回字节应与真实 MP3 一致');
    });

    // 2. 前 10 字节：bytes=start-end
    await check('前 10 字节 bytes=0-9 -> 206', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL, { Range: 'bytes=0-9' });
      assert.equal(r.status, 206, 'Range 应为 206');
      assert.equal(r.headers['content-range'], 'bytes 0-9/' + size, 'Content-Range');
      assert.equal(r.headers['accept-ranges'], 'bytes', 'Accept-Ranges');
      assert.equal(Number(r.headers['content-length']), 10, 'Content-Length 应为 10');
      assert.equal(r.headers['cache-control'], 'private, max-age=86400', '缓存');
      assert.ok(r.body.equals(expected.subarray(0, 10)), '应等于文件前 10 字节');
    });

    // 3. 尾 10 字节：bytes=-suffix
    await check('尾 10 字节 bytes=-10 -> 206', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL, { Range: 'bytes=-10' });
      assert.equal(r.status, 206, '后缀范围应为 206');
      assert.equal(r.headers['content-range'], 'bytes ' + (size - 10) + '-' + (size - 1) + '/' + size, 'Content-Range');
      assert.equal(Number(r.headers['content-length']), 10, 'Content-Length 应为 10');
      assert.ok(r.body.equals(expected.subarray(size - 10)), '应等于文件末 10 字节');
    });

    // 3b. bytes=start- 开放尾段
    await check('开放尾段 bytes=<size-10>- -> 206', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL, { Range: 'bytes=' + (size - 10) + '-' });
      assert.equal(r.status, 206, 'start- 形式应为 206');
      assert.equal(r.headers['content-range'], 'bytes ' + (size - 10) + '-' + (size - 1) + '/' + size, 'Content-Range');
      assert.ok(r.body.equals(expected.subarray(size - 10)), '应等于文件末 10 字节');
    });

    // 4. HEAD：不发送 body，头仍正确
    await check('HEAD 无 body + 正确头', async () => {
      const full = await rawRequest(base, 'HEAD', AUDIO_URL);
      assert.equal(full.status, 200, 'HEAD 全读应为 200');
      assert.equal(Number(full.headers['content-length']), size, 'HEAD Content-Length');
      assert.equal(full.body.length, 0, 'HEAD 不应有 body');
      const partial = await rawRequest(base, 'HEAD', AUDIO_URL, { Range: 'bytes=0-9' });
      assert.equal(partial.status, 206, 'HEAD Range 应为 206');
      assert.equal(partial.headers['content-range'], 'bytes 0-9/' + size, 'HEAD Content-Range');
      assert.equal(partial.body.length, 0, 'HEAD Range 也不应有 body');
    });

    // 5. 416：越界 / 格式错误
    await check('范围越界 -> 416', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL, { Range: 'bytes=' + size + '-' + (size + 10) });
      assert.equal(r.status, 416, '越界应为 416');
      assert.equal(r.headers['content-range'], 'bytes */' + size, '416 Content-Range');
      assert.equal(r.body.length, 0, '416 不应有 body');
    });
    await check('格式错误 -> 416', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL, { Range: 'bytes=abc' });
      assert.equal(r.status, 416, '格式错误应为 416');
      assert.equal(r.headers['content-range'], 'bytes */' + size, '416 Content-Range');
    });

    // 6. 旧静态：no-cache 照旧，Range 被忽略
    await check('旧静态 no-cache 且忽略 Range', async () => {
      const r = await rawRequest(base, 'GET', OLD_STATIC_URL, { Range: 'bytes=0-9' });
      assert.equal(r.status, 200, '旧静态仍应 200（忽略 Range）');
      assert.equal(r.headers['cache-control'], 'no-cache', '旧静态仍 no-cache');
      assert.equal(r.headers['accept-ranges'], undefined, '旧静态不应声明 Accept-Ranges');
      assert.equal(r.headers['content-range'], undefined, '旧静态不应有 Content-Range');
    });

    // 6b. 氛围目录内非音频：仅享受 private 缓存，不启用 Range
    await check('氛围目录非音频：private 缓存但不支持 Range', async () => {
      const r = await rawRequest(base, 'GET', IMAGE_URL, { Range: 'bytes=0-9' });
      assert.equal(r.status, 200, '非音频忽略 Range 返回 200');
      assert.equal(r.headers['cache-control'], 'private, max-age=86400', '目录级缓存仍生效');
      assert.equal(r.headers['accept-ranges'], undefined, '非音频不应声明 Accept-Ranges');
    });

    // 7. 登录门禁：未登录公网来客仍被挡
    await check('登录门禁：guest 访问音频 -> 302', async () => {
      const r = await rawRequest(base, 'GET', AUDIO_URL, GUEST);
      assert.equal(r.status, 302, '未登录来客应被重定向');
      assert.equal(r.headers['location'], '/login.html', '应重定向到登录页');
    });
    await check('登录门禁：guest 访问 /api/me -> 401', async () => {
      const r = await rawRequest(base, 'GET', '/api/me', GUEST);
      assert.equal(r.status, 401, '未登录来客访问接口应 401');
    });

    // 8. 路径穿越防护仍在
    await check('路径穿越被拦截', async () => {
      const r = await rawRequest(base, 'GET', '/assets/atmosphere/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd');
      assert.ok(r.status >= 400, '穿越路径不应返回 200，实际 ' + r.status);
    });

    // 9. 客户端首块后 abort：源 fs 读流应被销毁（切歌/静音中断请求不悬挂占 FD）。
    //    用 6MB 真实 tense 音轨，临时拦截 fs.createReadStream 观察关闭。
    await check('abort 后源 fs 读流关闭/销毁', async () => {
      const TENSE_NAME = 'tense-v1.mp3';
      const TENSE_URL = '/assets/atmosphere/' + TENSE_NAME;
      const spy = interceptReadStreams();
      try {
        const firstChunk = new Promise((resolve) => {
          const u = new URL(base);
          const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: TENSE_URL,
            method: 'GET',
          }, (res) => {
            res.once('data', () => resolve(req));
            res.on('error', () => {});
          });
          req.on('error', () => {});
          req.end();
        });
        const req = await withDeadline(firstChunk, 3000, null);
        assert.ok(req, '应在超时前收到首个数据块');
        req.destroy(); // 模拟浏览器切歌/静音中断请求
        const rec = await waitFor(
          () => spy.calls.find((c) => c.path.endsWith(TENSE_NAME)), 2000);
        assert.ok(rec, '应为 tense 音轨创建过 fs 读流');
        const closed = await waitFor(() => rec.closed || rec.stream.destroyed, 2000);
        assert.ok(closed, 'abort 后源 fs 读流应被关闭/销毁');
        assert.equal(rec.stream.destroyed, true, '源 fs 读流 destroyed 应为 true');
      } finally {
        spy.restore();
      }
    });

    // 10. 零长音频：GET/HEAD 200 + Content-Length 0 且不打开流；带 Range 仍 416。
    //     仅创建/清理本测试自己的唯一临时文件，绝不改动现有素材。
    await check('零长音频 200 空 + Range 416 + 不打开流', async () => {
      const zeroName = '__zero_' + process.pid + '_' + Date.now() + '_' +
        Math.random().toString(36).slice(2) + '.mp3';
      const zeroPath = path.join(PUBLIC_DIR, 'assets', 'atmosphere', zeroName);
      const zeroUrl = '/assets/atmosphere/' + zeroName;
      const spy = interceptReadStreams();
      let created = false;
      try {
        fs.writeFileSync(zeroPath, Buffer.alloc(0), { flag: 'wx' });
        created = true;

        const get = await rawRequest(base, 'GET', zeroUrl);
        assert.equal(get.status, 200, '零长 GET 应为 200');
        assert.equal(Number(get.headers['content-length']), 0, 'GET Content-Length 应为 0');
        assert.equal(get.body.length, 0, 'GET 不应有 body');
        assert.equal(get.headers['accept-ranges'], 'bytes', '仍声明 Accept-Ranges');
        assert.equal(get.headers['content-range'], undefined, '无 Range 不应有 Content-Range');

        const head = await rawRequest(base, 'HEAD', zeroUrl);
        assert.equal(head.status, 200, '零长 HEAD 应为 200');
        assert.equal(Number(head.headers['content-length']), 0, 'HEAD Content-Length 应为 0');
        assert.equal(head.body.length, 0, 'HEAD 不应有 body');

        const ranged = await rawRequest(base, 'GET', zeroUrl, { Range: 'bytes=0-9' });
        assert.equal(ranged.status, 416, '零长带 Range 仍应为 416');
        assert.equal(ranged.headers['content-range'], 'bytes */0', '416 Content-Range');

        const opened = spy.calls.filter((c) => c.path.endsWith(zeroName));
        assert.equal(opened.length, 0, '零长音频不应打开任何 fs 读流');
      } finally {
        spy.restore();
        if (created) fs.unlinkSync(zeroPath);
      }
    });
  });

  let passed = 0;
  for (const r of results) {
    if (r.ok) {
      passed += 1;
      console.log('PASS ' + r.name);
    } else {
      console.log('FAIL ' + r.name + ' :: ' + (r.err && r.err.message));
    }
  }
  console.log('---- ' + passed + '/' + results.length + ' passed ----');
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
