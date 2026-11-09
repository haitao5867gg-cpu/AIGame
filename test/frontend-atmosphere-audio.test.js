'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mod = require('../public/js/atmosphere-audio.js');
const catalog = { themes: { lingtian: { music: {
  calm: { src: '/assets/atmosphere/calm-v1.mp3' }, explore: { src: '/assets/atmosphere/explore-v1.mp3' },
  tense: { src: '/assets/atmosphere/tense-v1.mp3' } }, ambience: {
  wind: { src: '/assets/atmosphere/wind-v1.mp3' }, rain: { src: '/assets/atmosphere/rain-v1.mp3' } } } } };
const scene = (mood = 'calm', worldId = 'w1') => ({ worldId, theme: 'lingtian', mood, ambience: ['wind'] });
function fixture(opts = {}) {
  const audios = [], params = [], contexts = [], timers = new Map(); let tid = 0;
  class Audio {
    constructor() { this.paused = true; this.volume = 1; this.src = ''; this.calls = 0; audios.push(this); }
    pause() { this.paused = true; }
    removeAttribute() { this.src = ''; }
    load() {}
    play() { this.calls++; this.paused = false; return opts.play ? opts.play(this) : Promise.resolve(); }
  }
  class Context {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.destination = {}; this.sourceCount = 0; contexts.push(this); }
    resume() { this.state = 'running'; return Promise.resolve(); }
    suspend() { this.state = 'suspended'; return Promise.resolve(); }
    close() { this.state = 'closed'; return Promise.resolve(); }
    createGain() { const p = { value: 0, cancelScheduledValues() {}, setValueAtTime(v) { this.value = v; }, linearRampToValueAtTime(v) { this.value = v; } }; params.push(p); return { gain: p, connect() {}, disconnect() {} }; }
    createMediaElementSource() { this.sourceCount++; return { connect() {}, disconnect() {} }; }
  }
  const c = mod.create({ Audio, AudioContext: opts.fallback ? null : Context,
    setTimeout: fn => { const id = ++tid; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id) });
  c.setCatalog(catalog); c.setScene(scene());
  return { c, audios, params, contexts, timers, flush() { const all = [...timers.values()]; timers.clear(); all.forEach(fn => fn()); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('未点击时不设置音频src；恢复已保存意愿也不冒充解锁', () => {
  const f = fixture(); f.c.setPrefs({ enabled: true });
  assert(f.audios.every(a => !a.src && !a.calls));
  assert.equal(f.c.getStatus().unlocked, false); assert.equal(f.c.getStatus().playing, false); f.c.destroy();
});
test('实际点击同步发起play，WebAudio gain控制音量，整段朗读duck并恢复', async () => {
  const f = fixture(); f.c.setPrefs({ enabled: true });
  const started = f.c.enableFromGesture(); assert.equal(f.audios[0].calls, 1); await started;
  assert.equal(f.audios[0].volume, 1); assert.equal(f.params[0].value, 0.16);
  f.c.setVoiceState({ active: true, paused: false }); assert(Math.abs(f.params[0].value - 0.032) < 1e-9);
  f.c.setVoiceState({ active: true, paused: false }); assert.equal(f.audios[0].calls, 1);
  f.c.setVoiceState({ active: true, paused: true }); assert.equal(f.params[0].value, 0.16);
  assert(f.c.getStatus().playing); f.c.destroy();
});
test('同曲刷新不重播，换曲柔和串接，静音使旧定时回调失效', async () => {
  const f = fixture(); f.c.setPrefs({ enabled: true }); await f.c.enableFromGesture();
  f.c.setScene(scene()); assert.equal(f.audios[0].calls, 1);
  f.c.setScene(scene('explore')); assert(f.timers.size); assert(f.audios[0].src.includes('calm'));
  f.flush(); await tick(); assert(f.audios[0].src.includes('explore'));
  f.c.setScene(scene('tense')); f.c.setPrefs({ enabled: false }); f.flush(); await tick();
  assert(f.audios.every(a => a.paused && !a.src)); assert(!f.c.getStatus().playing); f.c.destroy();
});
test('旧play Promise在离开或后台后完成也不能复活声音', async () => {
  const resolvers = []; const f = fixture({ play: () => new Promise(resolve => resolvers.push(resolve)) });
  f.c.setPrefs({ enabled: true }); const p = f.c.enableFromGesture(); f.c.setHidden(true);
  resolvers.forEach(fn => fn()); await p; await tick(); assert(f.audios.every(a => a.paused));
  f.c.stop(); f.flush(); assert(f.audios.every(a => !a.src)); f.c.destroy();
});
test('被浏览器拒播会要求恢复，不虚报播放；后续真实点击可恢复', async () => {
  let reject = true; const f = fixture({ play: () => reject ? Promise.reject(Object.assign(new Error(), { name: 'NotAllowedError' })) : Promise.resolve() });
  f.c.setPrefs({ enabled: true }); assert.equal(await f.c.enableFromGesture(), false);
  assert(f.c.getStatus().blocked); assert(!f.c.getStatus().playing);
  reject = false; assert(await f.c.enableFromGesture()); assert(!f.c.getStatus().blocked); f.c.destroy();
});
test('系统挂起或中断音频上下文时主动提示恢复，点击恢复而非误当静音', async () => {
  const f = fixture(); f.c.setPrefs({ enabled: true }); await f.c.enableFromGesture();
  let observed; f.c.onStatus(s => { observed = s; });
  for (const state of ['suspended', 'interrupted']) {
    f.contexts[0].state = state; f.contexts[0].onstatechange();
    assert.equal(observed.blocked, true); assert.equal(observed.playing, false);
    assert.equal(await f.c.enableFromGesture(), true);
    assert.equal(f.c.getStatus().blocked, false);
  }
  f.c.destroy();
});
test('音量0不加载对应频道，音源错误不阻断其它频道，手动恢复可重试', async () => {
  const f = fixture(); f.c.setPrefs({ enabled: true, musicVolume: 0 }); await f.c.enableFromGesture();
  assert(!f.audios[0].src); assert(f.audios[1].src);
  f.c.setPrefs({ musicVolume: 0.3 }); await tick(); assert(f.audios[0].src);
  f.audios[0].onerror(); assert(f.c.getStatus().error); assert(!f.audios[1].paused);
  await f.c.enableFromGesture(); assert(!f.c.getStatus().error); f.c.destroy();
});
test('退出、切世界与destroy清理旧src、定时器、节点和订阅', async () => {
  const f = fixture(); f.c.setPrefs({ enabled: true }); await f.c.enableFromGesture();
  f.c.setScene(scene('tense')); f.c.setScene(null); f.flush(); assert(f.audios.every(a => a.paused && !a.src));
  f.c.setScene(scene('calm', 'w2')); await tick(); assert(f.audios[0].src.includes('calm'));
  let calls = 0; f.c.onStatus(() => calls++); f.c.destroy(); const last = calls;
  f.c.setScene(scene()); f.c.setPrefs({ enabled: true }); f.flush(); assert.equal(calls, last);
});
test('拒绝远程或目录穿越音频；无WebAudio时保留原生volume回退', async () => {
  const f = fixture({ fallback: true }); f.c.setPrefs({ enabled: true }); await f.c.enableFromGesture();
  assert.equal(f.audios[0].volume, 0.16);
  f.c.setCatalog({ themes: { lingtian: { music: { calm: { src: 'https://example.test/x.mp3' } }, ambience: {} } } });
  assert(f.audios.every(a => a.paused && !a.src)); f.c.destroy();
});
