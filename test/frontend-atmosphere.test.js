'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const State = require('../public/js/atmosphere-state');
const source = fs.readFileSync(path.join(__dirname, '../public/js/atmosphere.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const settled = () => new Promise(resolve => setImmediate(resolve));

function setup(opts) {
  const o = opts || {};
  const requests = [], timers = new Map(), events = {}, calls = [], classOps = [];
  const backdrop = { hidden: false, dataset: {}, style: {} };
  let timerId = 0, currentPrefs, unlocked = false;
  const controller = {
    setPrefs(p) { currentPrefs = p; }, setScene(s) { calls.push(['scene', plain(s)]); },
    setCatalog(c) { calls.push(['catalog', plain(c)]); }, setHidden(v) { calls.push(['hidden', v]); },
    setVoiceState(v) { calls.push(['voice', plain(v)]); },
    stop() { calls.push(['stop']); }, destroy() { calls.push(['destroy']); },
    onStatus() {}, getStatus() { return { enabled: currentPrefs.enabled, unlocked, playing: false }; },
    enableFromGesture() { unlocked = true; return Promise.resolve(true); },
  };
  const context = {
    AtmosphereState: State, AtmosphereAudio: { create: () => controller },
    myPrefs: { tts: { rate: 1.2 }, scenes: false }, currentWorldId: 'w1',
    document: { hidden: false,
      getElementById: (id) => (o.backdrop && id === 'world-backdrop' ? backdrop : null),
      body: { classList: {
        toggle(name, force) { classOps.push({ name, force }); },
        remove(name) { classOps.push({ name, force: false }); },
      } },
      addEventListener(name, fn) { events[name] = fn; } },
    window: { Audio: function () {}, addEventListener(name, fn) { events[name] = fn; } },
    Tts: { stop() { calls.push(['tts-stop']); } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }, toast(text) { calls.push(['toast', text]); },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(o.catalog || { themes: {}, credits: [] }) }),
    api(url, opts) { return new Promise((resolve, reject) => requests.push({ url, body: JSON.parse(opts.body), resolve, reject })); },
  };
  vm.runInNewContext(source, context);
  return { context, app: context.Atmosphere, requests, calls, events, classOps, backdrop,
    tick() { const jobs = [...timers.values()]; timers.clear(); jobs.forEach(fn => fn()); } };
}

test('氛围偏好接纳真实 API 的 prefs 包装，保留其他设置', async () => {
  const h = setup(); h.app.applyPrefs(h.context.myPrefs, 'host'); h.app.toggle(); h.tick();
  assert.deepEqual(h.requests[0].body, { atmosphere: { enabled: true } });
  h.requests[0].resolve({ prefs: { atmosphere: { enabled: true, musicVolume: 0.23 } } });
  await settled();
  assert.equal(h.context.myPrefs.atmosphere.musicVolume, 0.23);
  assert.deepEqual(plain(h.context.myPrefs.tts), { rate: 1.2 });
  assert.equal(h.context.myPrefs.scenes, false);
});

test('快速连点串行保存，旧响应不能覆盖新编辑', async () => {
  const h = setup(); h.app.applyPrefs({}, 'host');
  h.app.toggle(); h.tick(); h.app.toggle(); h.tick();
  assert.equal(h.requests.length, 1, '上一请求未结束，不并发写偏好');
  h.requests[0].resolve({ prefs: { atmosphere: { enabled: true } } });
  await settled();
  assert.equal(h.context.myPrefs.atmosphere.enabled, false);
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[1].body, { atmosphere: { enabled: false } });
  h.requests[1].resolve({ prefs: { atmosphere: { enabled: false } } });
  await settled();
  h.app.applyPrefs({ atmosphere: { enabled: true } }, 'host');
  assert.equal(h.context.myPrefs.atmosphere.enabled, false, '迟到的同账号读取不覆盖页面内编辑');
});

test('切换玩家停止旧声音，旧玩家的异步响应无权改新偏好', async () => {
  const h = setup(); h.app.applyPrefs({}, 'host'); h.app.toggle(); h.tick();
  h.app.applyPrefs({ atmosphere: { musicVolume: 0.08, enabled: false } }, 'friend');
  h.requests[0].resolve({ prefs: { atmosphere: { enabled: true, musicVolume: 0.8 } } });
  await settled();
  assert.equal(h.context.myPrefs.atmosphere.musicVolume, 0.08);
  assert.equal(h.context.myPrefs.atmosphere.enabled, false);
  assert.ok(h.calls.some(c => c[0] === 'tts-stop'));
  assert.ok(h.calls.some(c => c[0] === 'destroy'));
});

test('世界过期响应不串场，朗读状态和后台事件传到播放器，离开立即停止', async () => {
  const h = setup(); h.app.applyPrefs({}, 'host');
  h.app.enterWorld({ id: 'old-world' });
  assert.equal(h.calls.filter(c => c[0] === 'scene' && c[1]).length, 0);
  h.app.enterWorld({ id: 'w1', genre: 'xuanhuan', bible: { title: '外门杂役录' }, location: '灵田', clock: { period: '午后' } });
  await settled();
  assert.ok(h.calls.some(c => c[0] === 'scene' && c[1] && c[1].worldId === 'w1'));
  h.app.setVoiceState({ active: true, paused: false });
  assert.deepEqual(h.calls.at(-1), ['voice', { active: true, paused: false }]);
  h.context.document.hidden = true; h.events.visibilitychange();
  assert.deepEqual(h.calls.at(-1), ['hidden', true]);
  h.context.document.hidden = false; h.events.pageshow();
  assert.deepEqual(h.calls.at(-1), ['hidden', false]);
  h.app.leaveWorld();
  assert.ok(h.calls.some(c => c[0] === 'stop'));
});

test('协调器：urban 主题无 backgrounds.field 时田地也不显示背景、不抛错', async () => {
  const h = setup({
    backdrop: true,
    catalog: { themes: { urban: { backgrounds: {} } }, credits: [] },
  });
  h.app.applyPrefs({}, 'host');
  h.app.enterWorld({ id: 'w1', genre: 'urban', location: '灵田', clock: { period: '午后' } });
  await settled();
  // 目录加载后 applyScene 正常跑完（setScene 紧随其后即证明未在取背景处抛错）
  const catIdx = h.calls.findIndex(c => c[0] === 'catalog');
  assert.ok(catIdx >= 0, '目录应已加载');
  assert.ok(h.calls.slice(catIdx + 1).some(c => c[0] === 'scene'), '带 catalog 的 applyScene 正常执行');
  const bgToggles = h.classOps.filter(op => op.name === 'atmosphere-background');
  assert.ok(bgToggles.length > 0, 'applyScene 至少 toggle 一次背景类');
  assert.ok(bgToggles.every(op => op.force === false), 'urban 无 field 背景时 visible 恒为 false');
  assert.equal(h.backdrop.hidden, true, '底图保持隐藏');
  assert.equal(h.backdrop.style.backgroundImage, '', '不设置背景图');
});
