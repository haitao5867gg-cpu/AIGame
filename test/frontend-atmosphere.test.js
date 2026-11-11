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
  const requests = [], timers = new Map(), events = {}, calls = [], classOps = [], attrs = {};
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
      body: {
        setAttribute(k, v) { attrs[k] = String(v); },
        removeAttribute(k) { delete attrs[k]; },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
        classList: {
          toggle(name, force) { classOps.push({ name, force }); },
          remove(name) { classOps.push({ name, force: false }); },
        },
      },
      addEventListener(name, fn) { events[name] = fn; } },
    window: { Audio: function () {}, addEventListener(name, fn) { events[name] = fn; } },
    Tts: { stop() { calls.push(['tts-stop']); } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; },
    clearTimeout(id) { timers.delete(id); }, toast(text) { calls.push(['toast', text]); },
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(o.catalog || { themes: {}, credits: [] }) }),
    api(url, opts) { return new Promise((resolve, reject) => requests.push({ url, body: JSON.parse(opts.body), resolve, reject })); },
  };
  vm.runInNewContext(source, context);
  return { context, app: context.Atmosphere, requests, calls, events, classOps, backdrop, attrs,
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

test('协调器：urban 主题无 backgrounds.field 时显示题材门图、不抛错', async () => {
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
  assert.equal(bgToggles.at(-1).force, true, '最后一次背景类 toggle 为 true');
  assert.equal(h.backdrop.hidden, false, '底图显示');
  assert.equal(h.backdrop.dataset.art, 'genre', '来源为题材门图');
  assert.equal(h.backdrop.style.backgroundImage, 'url("/assets/home/door-urban-v1.jpg")', '显示 urban 门图');
  assert.equal(h.attrs['data-genre'], 'urban', 'body 标记 data-genre');
});

test('setSceneArt 合法场景图换底图，非法地址等同 null 退回题材门图', async () => {
  const h = setup({
    backdrop: true,
    catalog: { themes: { urban: { backgrounds: {} } }, credits: [] },
  });
  h.app.applyPrefs({}, 'host');
  h.app.enterWorld({ id: 'w1', genre: 'urban', location: '灵田', clock: { period: '午后' } });
  await settled();
  h.app.setSceneArt('/api/images/scene-0123456789ab.jpg');
  assert.equal(h.backdrop.style.backgroundImage, 'url("/api/images/scene-0123456789ab.jpg")', '底图换成场景图');
  assert.equal(h.backdrop.dataset.art, 'scene', '来源为场景图');
  const invalid = ['/api/images/../x.jpg', 'https://evil.example/x.jpg', '/api/images/item-0123456789ab.jpg', 123];
  for (const bad of invalid) {
    h.app.setSceneArt(bad);
    assert.equal(h.backdrop.style.backgroundImage, 'url("/assets/home/door-urban-v1.jpg")', '非法地址退回门图: ' + String(bad));
    assert.equal(h.backdrop.dataset.art, 'genre', '非法地址来源为 genre: ' + String(bad));
  }
});

test('玄幻灵田间有 catalog 背景时，场景图不覆盖 catalog 田间图', async () => {
  const h = setup({
    backdrop: true,
    catalog: { themes: { lingtian: { backgrounds: { field: { src: '/assets/atmosphere/field-afternoon.jpg' } } } }, credits: [] },
  });
  h.app.applyPrefs({}, 'host');
  h.app.enterWorld({ id: 'w1', genre: 'xuanhuan', location: '灵田', clock: { period: '午后' } });
  await settled();
  h.app.setSceneArt('/api/images/scene-0123456789ab.jpg');
  assert.equal(h.backdrop.dataset.art, 'catalog', 'catalog 优先');
  assert.equal(h.backdrop.style.backgroundImage, 'url("/assets/atmosphere/field-afternoon.jpg")', '显示 catalog 田间图');
});

test('prefs.background=false 时底图隐藏，但 body 仍设 data-genre 供整页上色', async () => {
  const h = setup({ backdrop: true });
  h.app.applyPrefs({ atmosphere: { background: false } }, 'host');
  h.app.enterWorld({ id: 'w1', genre: 'urban' });
  await settled();
  assert.equal(h.backdrop.hidden, true, '底图隐藏');
  assert.equal(h.backdrop.style.backgroundImage, '', '不设置背景图');
  assert.equal(h.backdrop.dataset.art, '', '无来源标记');
  assert.equal(h.attrs['data-genre'], 'urban', '仍设置 data-genre');
});

test('题材门图：未知/缺失题材用 door-general，xuanhuan 非田间用 door-xuanhuan', async () => {
  const cases = [
    [{ id: 'w1', genre: 'scifi' }, 'general'],
    [{ id: 'w1' }, 'general'],
    [{ id: 'w1', genre: 'xuanhuan' }, 'xuanhuan'],
  ];
  for (const [world, genre] of cases) {
    const h = setup({ backdrop: true });
    h.app.applyPrefs({}, 'host');
    h.app.enterWorld(world);
    await settled();
    assert.equal(h.backdrop.dataset.art, 'genre', '来源为 genre');
    assert.equal(h.backdrop.style.backgroundImage,
      'url("/assets/home/door-' + genre + '-v1.jpg")', '门图 ' + genre);
    assert.equal(h.attrs['data-genre'], genre, 'data-genre ' + genre);
  }
});

test('leaveWorld 清掉场景图与 body 标记，重进世界不带旧场景图', async () => {
  const h = setup({ backdrop: true });
  h.app.applyPrefs({}, 'host');
  h.app.enterWorld({ id: 'w1', genre: 'urban' });
  await settled();
  h.app.setSceneArt('/api/images/scene-0123456789ab.jpg');
  assert.equal(h.backdrop.dataset.art, 'scene', '已显示场景图');
  h.app.leaveWorld();
  assert.equal(h.attrs['data-genre'], undefined, '移除 data-genre');
  assert.equal(h.attrs['data-period'], undefined, '移除 data-period');
  assert.equal(h.backdrop.style.backgroundImage, '', '清空 backgroundImage');
  h.app.enterWorld({ id: 'w1', genre: 'urban' });
  await settled();
  assert.equal(h.backdrop.dataset.art, 'genre', '重进世界回到门图');
  assert.equal(h.backdrop.style.backgroundImage, 'url("/assets/home/door-urban-v1.jpg")', '不带旧场景图');
});
