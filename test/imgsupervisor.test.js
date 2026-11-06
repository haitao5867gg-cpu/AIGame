'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startImageSupervisor, healthUrlOf } = require('../src/imgsupervisor.js');

test('healthUrlOf strips /v1', () => {
  assert.equal(healthUrlOf('http://127.0.0.1:8790/v1'), 'http://127.0.0.1:8790/health');
  assert.equal(healthUrlOf('http://127.0.0.1:8790/v1/'), 'http://127.0.0.1:8790/health');
});

test('supervisor is off unless provider=local and python configured', () => {
  assert.equal(startImageSupervisor({ IMAGE_PROVIDER: 'local', IMAGE_LOCAL_PYTHON: '' }), null);
  assert.equal(startImageSupervisor({ IMAGE_PROVIDER: 'gateway', IMAGE_LOCAL_PYTHON: 'python' }), null);
});

test('does not spawn when health answers; spawns when it does not', async () => {
  let spawned = 0;
  const fakeSpawn = () => { spawned++; return { on() {}, unref() {} }; };
  const cfg = { IMAGE_PROVIDER: 'local', IMAGE_LOCAL_PYTHON: 'python', IMAGE_BASE_URL: 'http://127.0.0.1:1/v1' };
  const up = startImageSupervisor(cfg, { fetch: async () => ({ status: 200 }), spawn: fakeSpawn });
  await up.first; up.stop();
  assert.equal(spawned, 0);
  const down = startImageSupervisor(cfg, { fetch: async () => { throw new Error('refused'); }, spawn: fakeSpawn });
  await down.first; down.stop();
  assert.equal(spawned, 1);
});
