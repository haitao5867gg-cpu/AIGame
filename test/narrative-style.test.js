'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/prompts.js');
const env = require('../src/env.js');

function makeState() {
  return {
    bible: {
      title: '测试世界', tone: '苍凉', rules: [], places: [], factions: [],
      npcs: [{ name: '守夜人', role: '', desc: '' }],
      start: { place: '灰烬港', situation: '醒来', items: ['旧铜灯'] },
      eventThemes: ['天灾'],
    },
    character: { name: '旅人', appearance: '灰袍', attrs: {}, items: ['旧铜灯'] },
    npcAttitude: {}, persona: {}, recent: [], chronicle: [],
    apex: { hint: '北方的钟声' }, highlightUntilTurn: 0, turn: 1,
  };
}

function systemText(opts) {
  const [sys] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', opts);
  return sys.content;
}

test('配置默认 NARRATIVE_STYLE 为 v2', () => {
  assert.equal(env.DEFAULTS.NARRATIVE_STYLE, 'v2');
});

test('默认 / v1：messages 与改动前一致（含旧写法句子）', () => {
  const s = systemText({ style: 'v1' });
  assert.ok(s.includes('每段 1~3 句、不超过 90 字'), '默认应含旧的分段硬限');
  assert.ok(s.includes('需要玩家决断'), '默认应含旧的决断局面规则');
  assert.ok(s.includes('玩家意图优先'));
  assert.ok(!s.includes('篇幅随场景'), '默认不应出现 v2 文案');
  assert.ok(!s.includes('写作手法'), '默认不应出现 v2 文案');
  // 显式 v1 与默认完全一致
  assert.equal(systemText({ style: 'v1' }), s);
});

const V2_PHRASES = ['每回合写成一场完整的小戏', '先挫后扬', '信息一点点放', '结尾留钩子', '20~70 字', '8~20 段'];

test('v2：分段要求与写作手法替换、去掉旧规则', () => {
  const s = systemText({ style: 'v2' });
  for (const phrase of V2_PHRASES) {
    assert.ok(s.includes(phrase), `v2 应含「${phrase}」`);
  }
  assert.ok(!s.includes('2~4 个短段落'), 'v2 不应再有 2~4 段限制');
  assert.ok(!s.includes('需要玩家决断'), 'v2 不应再要求需要玩家决断的局面');
  assert.ok(s.includes('玩家意图优先'), 'v2 仍须遵守玩家意图优先');
  // 正文优先：narration 为 JSON 第一个字段，并强调先写完整再写其他字段
  assert.ok(s.includes('先把 narration 写完整，再写其他字段'));
  assert.ok(s.includes('{"narration":'));
  assert.ok(s.indexOf('"narration"') < s.indexOf('"state_diff"'));
});

test('v2-3p：与 v2 同一套写法，改为第三人称（用主角名字）', () => {
  const s = systemText({ style: 'v2-3p' });
  for (const phrase of V2_PHRASES) {
    assert.ok(s.includes(phrase), `v2-3p 应含「${phrase}」`);
  }
  assert.ok(s.includes('第三人称'), 'v2-3p 应含第三人称');
  assert.ok(s.includes('第三人称（用主角名字）'), 'v2-3p 应改用第三人称（用主角名字）');
  assert.ok(!s.includes('第二人称'), 'v2-3p 不应含第二人称');
  assert.ok(!s.includes('2~4 个短段落'));
  assert.ok(!s.includes('需要玩家决断'));
});

test('opts.style 能覆盖配置', () => {
  // 模拟编排层把运行时配置 cfg.NARRATIVE_STYLE 传入
  assert.ok(systemText({ narrativeStyle: 'v2' }).includes('写作手法'), '配置 v2 时应走 v2');
  // opts.style 覆盖配置为 v1
  const sOverV1 = systemText({ narrativeStyle: 'v2', style: 'v1' });
  assert.ok(sOverV1.includes('需要玩家决断'));
  assert.ok(!sOverV1.includes('写作手法'));
  // 反向：配置 v1，覆盖为 v2
  const sOverV2 = systemText({ narrativeStyle: 'v1', style: 'v2' });
  assert.ok(sOverV2.includes('写作手法'));
  assert.ok(!sOverV2.includes('需要玩家决断的具体局面'));
});

test('首次出场 / 续回合：完整规则单一来源，短提醒在 v1/v2/v2-3p 都临近落笔处生效', () => {
  // 用 turn=1 的状态：非首回合，完整规则来自通用条款而非第一幕段。
  for (const style of ['v1', 'v2', 'v2-3p']) {
    const [system, user] = prompts.buildTurnMessages(makeState(), { nextTurn: 2 }, '探查', { style });
    const c = system.content;
    const u = user.content;
    // 单一来源：完整规则的两个锚点在整段 system 里各只出现一次。
    assert.equal((c.match(/不等于玩家已经被告知/g) || []).length, 1, `${style} 完整规则只注入一次`);
    assert.equal((c.match(/续回合默认承接/g) || []).length, 1, `${style} 续写条款只注入一次`);
    assert.doesNotMatch(c, /这是第一幕/, `${style} 非首回合不应有第一幕段`);
    // 短提醒在 user 消息里、紧邻当前行动与落笔指令，三种写法都生效。
    assert.ok(u.includes('落笔前'), `${style} 应含落笔前短提醒`);
    assert.ok(u.indexOf('玩家本回合的行动') < u.indexOf('落笔前') &&
      u.indexOf('落笔前') < u.indexOf('请据此写出本回合叙事'),
      `${style} 短提醒应位于当前行动之后、落笔指令之前`);
    assert.match(u, /不等于读者看过的正文/, `${style} 短提醒应复述核心约束`);
    assert.match(u, /空间关系/, `${style} 短提醒应点明基本空间关系`);
    // 各风格原有写法没有被改动。
    if (style === 'v1') {
      assert.match(c, /需要玩家决断/);
      assert.ok(!c.includes('写作手法'));
    } else {
      assert.match(c, /写作手法/);
      assert.ok(!c.includes('需要玩家决断的具体局面'));
    }
    if (style === 'v2-3p') assert.match(c, /第三人称（用主角名字）/);
  }
});

test('第一幕环境落位：v1/v2/v2-3p 首回合都携带当前地点环境，原有写法不变', () => {
  for (const style of ['v1', 'v2', 'v2-3p']) {
    const state = makeState();
    state.turn = 0;
    state.location = '沟口';
    state.bible.places = [{ name: '沟口', desc: '一块青石板卡在沟口，拨开挪三指就能改水道。' }];
    const [system, user] = prompts.buildTurnMessages(state, { nextTurn: 1 }, '看看水', { style });
    const c = system.content;
    const u = user.content;
    assert.match(u, /【当前地点的环境背景（玩家尚未读过）】/, `${style} 应带首幕环境片段`);
    assert.ok(u.includes('青石板'), `${style} 应带匹配地点 desc`);
    assert.match(u, /1~2 句/, `${style} 应带首幕落位指令`);
    assert.ok(u.indexOf('玩家本回合的行动') < u.indexOf('当前地点的环境背景') &&
      u.indexOf('当前地点的环境背景') < u.indexOf('请据此写出本回合叙事'),
      `${style} 环境片段应临近行动 / 输出`);
    // 通用完整规则单一来源、短提醒、第一幕段仍生效；各写法原有规则未受影响。
    assert.equal((c.match(/不等于玩家已经被告知/g) || []).length, 1, `${style} 完整规则只注入一次`);
    assert.match(u, /落笔前/, `${style} 短提醒仍在`);
    assert.match(c, /这是第一幕/, `${style} 仍有第一幕段`);
    if (style === 'v1') {
      assert.match(c, /需要玩家决断/);
      assert.ok(!c.includes('写作手法'));
    } else {
      assert.match(c, /写作手法/);
      assert.ok(!c.includes('需要玩家决断的具体局面'));
    }
    if (style === 'v2-3p') {
      assert.match(c, /第三人称（用主角名字）/);
      // user 片段不含「你 / 第二人称」，与第三人称写法不冲突。
      const iEnv = u.indexOf('【当前地点的环境背景');
      const iEnd = u.indexOf('【', iEnv + 1);
      assert.doesNotMatch(u.slice(iEnv, iEnd < 0 ? undefined : iEnd), /「你|第二人称/);
    }
  }
});
