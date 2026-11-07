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
