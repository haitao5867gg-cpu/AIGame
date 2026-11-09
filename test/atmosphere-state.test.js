'use strict';

// 任务A：纯场景选择 selector 的确定性单元验证。
// resolve 只读、无 LLM / 文件 / 网络 / 时钟定时器，稳定输入得稳定 DTO，不改 state。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../public/js/atmosphere-state.js');

const DTO_KEYS = ['ambience', 'background', 'location', 'mood', 'period', 'theme', 'worldId'];

function state(over) {
  return Object.assign({
    id: 'w1',
    genre: 'xuanhuan',
    bible: { title: '外门杂役录' },
    location: '灵田',
    clock: { period: '午后' },
    focus: 'action',
    continuing: false,
    danger: false,
    recent: [],
  }, over || {});
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

// ---------- normalizePrefs：与后端同语义 ----------

test('normalizePrefs：缺省 / 非法入参一律回完整默认（首次安静 enabled:false）', () => {
  for (const bad of [undefined, null, 'x', 42, [], {}, { background: 'yes' }]) {
    assert.deepEqual(A.normalizePrefs(bad), A.DEFAULT_ATMOSPHERE);
  }
  assert.equal(A.DEFAULT_ATMOSPHERE.enabled, false, '首次安静');
  assert.equal(A.DEFAULT_ATMOSPHERE.mode, 'auto');
});

test('normalizePrefs：合法字段原样；非法类型保留默认；原型键不当合法 mode', () => {
  assert.deepEqual(A.normalizePrefs({
    background: false, enabled: true, musicVolume: 0.5, ambienceVolume: 0, mode: 'tense',
  }), { background: false, enabled: true, musicVolume: 0.5, ambienceVolume: 0, mode: 'tense' });

  const allBad = A.normalizePrefs({
    background: 'true', enabled: 1, musicVolume: 'loud', ambienceVolume: {}, mode: 'constructor',
  });
  assert.deepEqual(allBad, A.DEFAULT_ATMOSPHERE, '非法全部回默认，constructor/__proto__ 不被当合法 mode');
  assert.equal(A.normalizePrefs({ mode: '__proto__' }).mode, 'auto');
});

test('normalizePrefs：音量仅有限 number 夹 0..1（0 合法、NaN/Infinity/越界按规则）', () => {
  assert.equal(A.normalizePrefs({ musicVolume: 0 }).musicVolume, 0, '0 是合法音量');
  assert.equal(A.normalizePrefs({ ambienceVolume: 0 }).ambienceVolume, 0);
  assert.equal(A.normalizePrefs({ musicVolume: NaN }).musicVolume, A.DEFAULT_ATMOSPHERE.musicVolume);
  assert.equal(A.normalizePrefs({ musicVolume: Infinity }).musicVolume, A.DEFAULT_ATMOSPHERE.musicVolume);
  assert.equal(A.normalizePrefs({ musicVolume: '0.5' }).musicVolume, A.DEFAULT_ATMOSPHERE.musicVolume);
  assert.equal(A.normalizePrefs({ musicVolume: -1 }).musicVolume, 0, '负数夹到 0');
  assert.equal(A.normalizePrefs({ ambienceVolume: 2 }).ambienceVolume, 1, '超过 1 夹到 1');
  assert.equal(A.normalizePrefs({ musicVolume: 0.37 }).musicVolume, 0.37);
});

test('normalizePrefs(raw, base)：部分 merge 保留当前值，非法字段保留当前，缺省取当前', () => {
  const cur = A.normalizePrefs({ enabled: true, mode: 'tense', musicVolume: 0.3 });
  assert.deepEqual(A.normalizePrefs({ ambienceVolume: 0.2 }, cur), {
    background: true, enabled: true, musicVolume: 0.3, ambienceVolume: 0.2, mode: 'tense',
  });
  // 非法部分不擦当前值
  assert.equal(A.normalizePrefs({ musicVolume: 'loud' }, cur).musicVolume, 0.3);
  assert.equal(A.normalizePrefs({ mode: 'BOGUS' }, cur).mode, 'tense');
  // 无 base 时缺省取默认
  assert.equal(A.normalizePrefs({ enabled: true }).musicVolume, A.DEFAULT_ATMOSPHERE.musicVolume);
  // 脏 base 自身先被归一化，fallback 始终合法
  assert.equal(A.normalizePrefs({}, { musicVolume: 'bad' }).musicVolume, A.DEFAULT_ATMOSPHERE.musicVolume);
});

// ---------- resolve：DTO 形状与纯只读 ----------

test('resolve：固定 DTO 形状；同输入稳定；不改 state / opts；返回全新对象', () => {
  const s = state();
  const o = { prefs: { mode: 'auto' }, narration: '' };
  const before = JSON.parse(JSON.stringify(s));
  const beforeOpts = JSON.parse(JSON.stringify(o));
  const r1 = A.resolve(s, o);
  const r2 = A.resolve(s, o);
  assert.deepEqual(Object.keys(r1).sort(), DTO_KEYS);
  assert.deepEqual(r1, r2, '同输入稳定');
  assert.deepEqual(s, before, '不修改 state');
  assert.deepEqual(o, beforeOpts, '不修改 opts');
  r1.ambience.push('HACK');
  assert.deepEqual(A.resolve(s, o).ambience, ['wind'], '返回全新对象，改结果不影响下次');
  // 冻结输入也不抛错（严格只读）
  assert.doesNotThrow(() => A.resolve(deepFreeze(state()), deepFreeze({ prefs: {} })));
});

test('resolve：源码无模型 / 文件 / 网络 / 时钟定时器副作用', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'atmosphere-state.js'), 'utf8');
  for (const forbidden of [
    /\bfetch\s*\(/, /XMLHttpRequest/, /WebSocket/, /\brequire\s*\(/, /\bimport\s/,
    /setTimeout/, /setInterval/, /\bDate\b/, /Math\.random/, /\bprocess\b/, /child_process/,
  ]) {
    assert.equal(forbidden.test(src), false, `不应出现 ${forbidden}`);
  }
});

test('resolve：worldId / theme 仅玄幻或指定书名才 lingtian，其它题材不套仙侠素材', () => {
  assert.equal(A.resolve(state({ id: 'w1', genre: 'xuanhuan' })).theme, 'lingtian');
  assert.equal(A.resolve(state({ id: 'w1', genre: 'urban', bible: { title: '外门杂役录' } })).theme,
    'lingtian', 'title 命中也套 lingtian');
  assert.equal(A.resolve(state({ id: 'w1', genre: 'urban', bible: { title: '别的' } })).theme,
    null, '其它题材保持原界面');
  assert.equal(A.resolve(state({ id: 'w1' })).worldId, 'w1');
  assert.equal(A.resolve({ worldId: 'w2' }).worldId, 'w2');
  assert.equal(A.resolve({}).worldId, null);
});

// ---------- 明确地点 → background ----------

test('resolve：明确室外田地才 field，室内 / 未知均 neutral；室内优先；不读 bible.places 描写', () => {
  for (const loc of ['灵田', '田埂', '田间', '稻田', '田野', '麦田']) {
    assert.equal(A.resolve(state({ location: loc })).background, 'field', loc);
  }
  for (const loc of ['药庐', '厢房', '草屋', '阁楼', '大堂', '殿内', '静室', '山洞', '丹房']) {
    assert.equal(A.resolve(state({ location: loc })).background, 'neutral', loc);
  }
  assert.equal(A.resolve(state({ location: '灵田边的草屋' })).background, 'neutral', '室内优先');
  assert.equal(A.resolve(state({ location: '' })).background, 'neutral', '未知');
  // bible.places 描写里出现田野物件也不许造出新场景：只读地点名字符串
  const s = state({ location: '药庐', bible: { title: '外门杂役录', places: [{ name: '灵田', desc: '一望无际的稻田与谷仓' }] } });
  assert.equal(A.resolve(s).background, 'neutral');
  assert.equal(A.resolve(s).location, '药庐');
  // location 缺省回退 bible.start.place / scene.place
  assert.equal(A.resolve({ bible: { start: { place: '灵田' } } }).background, 'field');
  assert.equal(A.resolve({}, { scene: { place: '稻田' } }).background, 'field');

  // 郊野/旷野/山野/荒野是野地，不是农田
  for (const loc of ['旷野', '郊野', '山野', '荒野', '野地']) {
    assert.equal(A.resolve(state({ location: loc })).background, 'neutral', loc);
  }
  // 明确「屋外/阁外/院外/庐外」+ 田地 = 室外农田
  for (const loc of ['药庐外的灵田', '屋外的稻田', '阁外的麦田', '院外的水田', '草屋外的田间']) {
    assert.equal(A.resolve(state({ location: loc })).background, 'field', loc);
  }
  // 真正屋内仍 neutral
  for (const loc of ['药庐内', '屋内', '静室之中']) {
    assert.equal(A.resolve(state({ location: loc })).background, 'neutral', loc);
  }
  // 只写「外」但无田地，仍 neutral，不把「外」画成农田
  assert.equal(A.resolve(state({ location: '屋外' })).background, 'neutral');
});

// ---------- 昼夜 → period ----------

test('resolve：清晨/午后/黄昏/深夜 → dawn/day/dusk/night，未知 day', () => {
  const map = { 清晨: 'dawn', 午后: 'day', 黄昏: 'dusk', 深夜: 'night' };
  for (const [zh, en] of Object.entries(map)) {
    assert.equal(A.resolve(state({ clock: { period: zh } })).period, en, zh);
  }
  assert.equal(A.resolve(state({ clock: { period: '正午' } })).period, 'day');
  assert.equal(A.resolve({}).period, 'day');
});

// ---------- mood：人工优先 / 私下意图 / 真实公开危险 / 探索 ----------

test('resolve：人工 mode 优先于一切自动判定', () => {
  const s = state({ focus: 'private', danger: true });
  assert.equal(A.resolve(s, { prefs: { mode: 'tense' } }).mood, 'tense');
  assert.equal(A.resolve(s, { prefs: { mode: 'calm' } }).mood, 'calm');
  assert.equal(A.resolve(s, { prefs: { mode: 'explore' } }).mood, 'explore');
  assert.equal(A.resolve(s, { mode: 'tense', prefs: { mode: 'calm' } }).mood, 'tense', 'opts.mode 覆盖');
});

test('resolve：私下意图优先 calm；continuing 不压真实交战/探索；后台 omen/apex 不影响音乐', () => {
  // 后台事件（omen / 导演转折 / apex / 隐藏意图 / 未发生事件 / 倒计时）一律不读、不切 tense。
  const noisy = {
    omen: true, apex: { hidden: true }, twist: true, pendingEventTheme: '伏兵',
    npcProfiles: { 某NPC: { want: '暗害' } }, clock: { day: 9, period: '午后', countdown: 3 },
  };
  for (const f of ['social', 'private', 'rest', 'intimate']) {
    const s = state(Object.assign({ focus: f }, noisy));
    assert.equal(A.resolve(s, { scene: { action: '传闻山外曾有伏兵' } }).mood, 'calm', f);
    // 私下意图即便 continuing 仍优先 calm
    assert.equal(A.resolve(state(Object.assign({ focus: f, continuing: true }, noisy))).mood,
      'calm', f + ' continuing');
  }
  // 这些字段完全不参与判定：没有真实交战仍 calm，不凭后台事件切危险乐
  assert.equal(A.resolve(state(Object.assign({ focus: 'action' }, noisy))).mood, 'calm');
  assert.equal(A.resolve(state(Object.assign({ focus: 'action', continuing: true }, noisy))).mood,
    'calm', 'continuing 顺延定时事件，无真实交战仍 calm');

  // continuing 不能把玩家正在进行的真实战斗配乐压成 calm
  const combat = { scene: { action: '与妖兽激烈搏斗' } };
  assert.equal(A.resolve(state({ focus: 'action' }), combat).mood, 'tense');
  assert.equal(A.resolve(state(Object.assign({ focus: 'action', continuing: true }, noisy)), combat).mood,
    'tense', 'continuing 不覆盖当前 action 真实交战');
  // continuing 也不把继续探索变成 calm
  assert.equal(A.resolve(state(Object.assign({ focus: 'explore', continuing: true }, noisy))).mood, 'explore');
  assert.equal(A.resolve(state(Object.assign({ focus: 'travel', continuing: true }, noisy))).mood, 'explore');
});

test('resolve：真实公开危险——明确 state.danger 才 tense', () => {
  assert.equal(A.resolve(state({ danger: true })).mood, 'tense');
  assert.equal(A.resolve(state({ danger: false })).mood, 'calm');
  assert.equal(A.resolve(state({ danger: 'true' })).mood, 'calm', '非布尔不当危险');
});

test('resolve：opts.scene.action 里已发生的交战/搏斗才 tense；排除曾经/传闻/如果/战后/否定/未来/台词', () => {
  const tenseActions = ['与妖兽激烈搏斗', '双方当街交战', '提剑厮杀在一处', '众人动起手来'];
  for (const a of tenseActions) {
    assert.equal(A.resolve(state(), { scene: { action: a } }).mood, 'tense', a);
  }
  const nonTense = [
    '曾经与人搏斗', '听说明日有大战', '如果交战该如何', '战后收拾残局',
    '没有交战', '他想起昔日大战', '他低声说「明日大战」，随后沉默', '明日即将开打',
  ];
  for (const a of nonTense) {
    assert.equal(A.resolve(state(), { scene: { action: a } }).mood, 'calm', a);
  }
});

test('resolve：travel/explore → explore，其余 calm', () => {
  assert.equal(A.resolve(state({ focus: 'travel' })).mood, 'explore');
  assert.equal(A.resolve(state({ focus: 'explore' })).mood, 'explore');
  assert.equal(A.resolve(state({ focus: 'action' })).mood, 'calm');
  assert.equal(A.resolve(state({ focus: 'BOGUS' })).mood, 'calm');
});

// ---------- ambience：风 / 虫 / 雨 ----------

test('resolve：田野平常 wind，夜晚可加 insects；室内/未知绝不播田野虫鸣', () => {
  assert.deepEqual(A.resolve(state({ location: '灵田', clock: { period: '午后' } })).ambience, ['wind']);
  assert.deepEqual(A.resolve(state({ location: '灵田', clock: { period: '深夜' } })).ambience,
    ['wind', 'insects'], '夜晚田野可加虫鸣');
  assert.deepEqual(A.resolve(state({ location: '药庐', clock: { period: '深夜' } })).ambience,
    [], '屋内夜里也不播田野虫鸣');
  assert.deepEqual(A.resolve(state({ location: '', clock: { period: '深夜' } })).ambience,
    [], '未知地点默认 []');
  assert.deepEqual(A.resolve(state({ location: '药庐' }), { narration: '四周万籁俱寂' }).ambience,
    [], '明确无声则 []');
});

test('resolve：只对明确现实正在下雨的句子启 rain；深夜雨天收敛到 <=2、优先 rain、停虫鸣', () => {
  assert.deepEqual(A.resolve(state({ location: '灵田' }), { narration: '屋外正下着大雨。' }).ambience,
    ['wind', 'rain']);
  // 真实雨正例
  for (const n of ['屋外正下着瓢泼大雨。', '大雨正哗啦啦地下个不停。', '骤雨忽落，打在田埂上。']) {
    assert.deepEqual(A.resolve(state({ location: '灵田' }), { narration: n }).ambience,
      ['wind', 'rain'], n);
  }
  // 深夜真实下雨：不再返回 wind+insects+rain 三个，雨天优先 rain、停虫鸣，结果 <=2
  const nightRain = A.resolve(state({ location: '灵田', clock: { period: '深夜' } }),
    { narration: '细雨淅淅沥沥落个不停。' }).ambience;
  assert.deepEqual(nightRain, ['wind', 'rain']);
  assert.ok(nightRain.length <= 2, '环境声始终 <=2');
  assert.ok(nightRain.includes('rain'), '真正的 rain 不被挤掉');
  assert.ok(!nightRain.includes('insects'), '雨天停虫鸣');
  // 「或最近正文」：opts.narration 缺省时读 state.recent 最后一条正文
  const s = state({ location: '灵田', recent: [{ turn: 1, narration: '窗外正下着雨。' }] });
  assert.deepEqual(A.resolve(s).ambience, ['wind', 'rain']);
});

test('resolve：明天下雨/雨停了/听说/回忆/假设/否定/台词引用都不得误判为雨声', () => {
  const notRain = [
    '明天下雨。', '雨停了，天放晴。', '听说明天要下雨。', '如果下雨就好了。',
    '他回忆起那年的一场大雨。', '没有下雨。', '并未下雨，月色正好。',
    '他低声说「明天下雨」，随后沉默。', '预报说将要下雨。', '盼雨盼了整月。',
    // 雨具 / 积水等名词、未来+雨水、先雨后停（逗号留在句内）都不得误判
    '你把雨伞放在田埂边。', '他披上雨衣出了门。', '明天，雨水会把田埂打湿。',
    '雨早就停了，田里还留着雨水。', '地上积着雨水，映出天光。',
  ];
  for (const n of notRain) {
    assert.deepEqual(A.resolve(state({ location: '灵田' }), { narration: n }).ambience,
      ['wind'], n);
  }
});

test('resolve：雨中等待雨停/雨势转弱不清除现实雨声，未来盼雨不凭空开启', () => {
  const s = state({ location: '灵田区', clock: { period: '深夜' }, focus: 'rest' });
  const actual = '细雨落在田间，雨点打湿田埂。';
  for (const wait of ['你站在田边，等雨势缓一缓。', '你等雨小一点。', '你等雨停。', '你等到雨停之后再回屋。']) {
    assert.deepEqual(A.resolve(s, { narration: actual + wait }).ambience, ['wind', 'rain'], wait);
  }
  for (const future of ['等雨来。', '等下雨。', '盼雨。', '明天下雨。', '你等雨停。']) {
    assert.ok(!A.resolve(s, { narration: future }).ambience.includes('rain'), future);
  }
  for (const stop of ['雨停了。', '雨早就停了。', '你等雨停，但雨已经停了。']) {
    assert.ok(!A.resolve(s, { narration: actual + stop }).ambience.includes('rain'), stop);
  }
});

test('resolve：室内/未知默认[]，正文确实写雨打窗/窗外雨打窗才 rain', () => {
  assert.deepEqual(A.resolve(state({ location: '药庐' }), { narration: '屋外正下着大雨。' }).ambience,
    [], '只说下雨、没写听见雨，室内仍 []');
  assert.deepEqual(A.resolve(state({ location: '药庐' }),
    { narration: '屋外正下着大雨，雨点敲在窗上。' }).ambience, ['rain']);
  // 窗外雨打窗正例
  for (const n of ['窗外雨点打在窗上。', '雨打窗棂，淅沥作响。', '窗外正下着雨，雨敲瓦檐。']) {
    assert.deepEqual(A.resolve(state({ location: '药庐' }), { narration: n }).ambience, ['rain'], n);
  }
  // 引用台词里的雨打窗不是当前天气
  assert.deepEqual(A.resolve(state({ location: '药庐' }),
    { narration: '他低声说「明日雨打窗」，随后沉默。' }).ambience, [], '引用从句不算');
});

test('resolve：ambience 始终是 wind/rain/insects 子集且长度 <=2（音频 contract）', () => {
  const cases = [
    [state({ location: '灵田', clock: { period: '午后' } }), { narration: '' }],
    [state({ location: '灵田', clock: { period: '深夜' } }), { narration: '' }],
    [state({ location: '灵田', clock: { period: '深夜' } }), { narration: '屋外正下着大雨。' }],
    [state({ location: '灵田', clock: { period: '午后' } }), { narration: '细雨淅淅沥沥落个不停。' }],
    [state({ location: '药庐', clock: { period: '深夜' } }), { narration: '窗外雨点打在窗上。' }],
  ];
  for (const [s, o] of cases) {
    const amb = A.resolve(s, o).ambience;
    assert.ok(amb.length <= 2, '不超过 2: ' + JSON.stringify(amb));
    for (const a of amb) assert.ok(['wind', 'rain', 'insects'].includes(a), '合法环境声: ' + a);
  }
});

// ---------- 场景未知保守回退 ----------

test('resolve：场景未知 / 非法入参保守回退，不抛错', () => {
  const fallback = {
    worldId: null, theme: null, background: 'neutral', period: 'day',
    mood: 'calm', ambience: [], location: null,
  };
  for (const bad of [undefined, null, 'x', 42, [], {}]) {
    let r;
    assert.doesNotThrow(() => { r = A.resolve(bad); }, `入参 ${JSON.stringify(bad)}`);
    assert.deepEqual(r, fallback, `入参 ${JSON.stringify(bad)}`);
    assert.deepEqual(A.resolve(bad, undefined), fallback);
  }
});
