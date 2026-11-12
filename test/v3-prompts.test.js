'use strict';

// 叙事 v3：写正文的五段任务书与记账提示词。
const test = require('node:test');
const assert = require('node:assert/strict');
const prompts = require('../src/prompts.js');
const engine = require('../src/engine.js');

function state() {
  const s = engine.createWorld({
    id: 'wtest', genre: 'urban',
    bible: {
      title: '十年后的来电', rules: ['电话只在深夜零点到三点间接通'],
      npcs: [{ name: '老周', role: '面馆老板', desc: '胖', want: 'WANT_SECRET', voice: '絮絮叨叨' }],
      start: { place: '天台', period: '深夜', situation: '你在天台接到来电。' },
      prologue: { world: '澜城', me: '你叫叶峰', goal: '查清手机', now: '雨夜' },
    },
    name: '叶峰',
  }, { rng: () => 0.5, now: 1 });
  s.facts = [{ turn: 0, text: '手机只在深夜零点到三点之间能接通' }, { turn: 1, text: '通话上限为三分钟，屏幕会出现倒计时' }];
  s.threads = ['南门电表箱会有人被抬出', '别把手机给穿蓝牌子的看'];
  return s;
}

const card = { index: 1, title: '来电', goal: '弄清电话的规则', start: '天台来电', beats: ['电表箱应验'], end: '决定再接一次', question: '下一通电话会说什么', avoid: ['不要揭开写信人'] };
const history = { text: '【开场】\n你在天台接到来电。\n\n第 1 回合　你：接通电话\n「时间不多，通话上限三分钟。」屏幕上出现倒计时，在跳。老周的面馆还亮着灯。' };

test('写正文：system 有作者身份、写作准则、只输出正文；user 是五段任务书，读者行动在最后', () => {
  const [sys, user] = prompts.buildWriterMessages(state(), { action: '下楼找老周吃面', history, card, chapterTurn: 2, plan: {} });
  assert.match(sys.content, /十年后的来电/);
  assert.match(sys.content, /只输出正文/);
  assert.match(sys.content, /去掉 AI 腔/);
  assert.match(sys.content, /不看读者的输入也能读懂/);
  for (const h of ['本世前文', '二、故事到这里', '三、相关的人', '四、怎么写更顺', '五、收在哪里', '一、这一节要写什么']) {
    assert.ok(user.content.includes(h), h);
  }
  assert.ok(user.content.lastIndexOf('下楼找老周吃面') > user.content.indexOf('五、收在哪里'), '读者行动在任务书最后');
  assert.match(user.content, /建议，不是必须/);
  assert.match(user.content, /第 1 章《来电》的第 2 节/);
  assert.match(user.content, /屏幕上出现倒计时/); // 本世前文
  assert.match(user.content, /背景设定（读者还不知道[^\n]*零点到三点/);
  assert.match(user.content, /读者已经知道的事：[^\n]*三分钟/);
  assert.match(user.content, /絮絮叨叨/);
  assert.doesNotMatch(sys.content + user.content, /"narration"/);
});

test('写正文：没有章卡不崩；第 4 节起提示可以收章', () => {
  const [, u1] = prompts.buildWriterMessages(state(), { action: '走', history, card: null, plan: {} });
  assert.match(u1.content, /停在一个自然的/);
  const [, u2] = prompts.buildWriterMessages(state(), { action: '走', history, card, chapterTurn: 4, plan: {} });
  assert.match(u2.content, /下一通电话会说什么/);
  assert.match(u2.content, /不要硬收/);
});

test('写正文：状态警戒和伤势变成大白话；时光推进写进第一段', () => {
  const s = state();
  s.character.attrs['体魄'] = 2;
  s.stats = [{ name: '饱腹', kind: 'gauge', max: 100, value: 12, warn: [{ below: 20, label: '饿得发虚', effect: '手脚发软' }] }];
  const [, u] = prompts.buildWriterMessages(s, { action: '走', history, card, plan: {}, timeSkip: { label: '一个月', plan: '找工作' } });
  assert.match(u.content, /伤势沉重/);
  assert.match(u.content, /主角此刻饿得发虚（饱腹 12\/100）/);
  assert.match(u.content, /过去一个月/);
});

test('记账：只记正文里发生的事，字段说明不含写作要求，带 v3 额外字段', () => {
  const [sys, user] = prompts.buildLedgerMessages(state(), { action: '下楼', prose: '你下了楼。老周递来一碗面。', card, plan: { settling: true } });
  assert.match(sys.content, /只记录正文里真实发生的事/);
  assert.match(sys.content, /"state_diff"/);
  assert.match(sys.content, /suggestions/);
  assert.match(sys.content, /chapter_end/);
  assert.match(sys.content, /"due":1~3/);
  assert.match(sys.content, /event_check/);
  assert.doesNotMatch(sys.content, /\{"narration":/);
  assert.doesNotMatch(sys.content, /narration 必须分成 2~4 个短段落/);
  assert.match(user.content, /老周递来一碗面/);
  assert.match(user.content, /南门电表箱会有人被抬出/);
});

test('v2 回合输出格式不受记账改动影响', () => {
  const s = state();
  const msgs = prompts.buildTurnMessages(s, engine.planTurn(s, { rng: () => 0.5 }), '走', {});
  const all = msgs.map((m) => m.content).join('\n');
  assert.match(all, /\{"narration":/);
  assert.doesNotMatch(all, /chapter_end/);
});
