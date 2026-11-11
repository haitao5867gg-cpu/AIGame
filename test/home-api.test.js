'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { req, withServer } = require('./helpers/api-helpers.js');

test('GET /api/worlds：每项含 cover / excerpt / genre 等首页摘要字段', async () => {
  await withServer(async ({ base }) => {
    const created = await req(base, 'POST', '/api/worlds', {
      seed: '黄沙覆盖的机械圣城',
      name: '旅人',
      appearance: '灰袍',
    });
    assert.equal(created.status, 201, created.text);

    const r = await req(base, 'GET', '/api/worlds');
    assert.equal(r.status, 200, r.text);
    assert.ok(Array.isArray(r.json));
    assert.equal(r.json.length, 1);
    const w = r.json[0];
    assert.equal(w.id, created.json.id);
    // 新字段
    assert.equal('cover' in w, true, '应含 cover 字段');
    assert.ok(w.cover === null || (w.cover && typeof w.cover === 'object'), 'cover 为 null 或对象');
    assert.equal(typeof w.excerpt, 'string', '应含 excerpt 字符串');
    assert.equal('genre' in w, true, '应含 genre 字段');
    // 原有字段仍在
    assert.equal(typeof w.title, 'string');
    assert.equal(typeof w.updatedAt, 'number');
    assert.equal(typeof w.alive, 'boolean');
  });
});
