'use strict';

// ---- 隐藏大纲（叙事 v3，纯函数） ----
//
// state.outline 是作者自用的隐藏大纲：一卷的节拍表 + 若干张章卡。它只给写正文的模型看，
// 绝不出现在任何公开接口（engine/view.js 的 toPublicState 会删掉它）。
//
// 章卡只写读者能感知到的「信号」，不写作者的内部真相；节点是建议不是必须——玩家走偏时
// 以玩家为准，下一章重新规划。state.chapter = { index, startTurn, turns } 记录正在写的章。

const PREMISE_MAX = 60;
const CORE_TRUTH_MAX = 120;
const HERO_ARC_MAX = 80;
const BEAT_MAX = 60;
const CRISES_MAX = 3;
const CARD_TITLE_MAX = 10;
const CARD_TEXT_MAX = 40;
const CARD_BEAT_MAX = 30;
const CARD_BEATS_MAX = 4;
const CARD_QUESTION_MAX = 30;
const CARD_AVOID_MAX = 3;
const CHAPTERS_MAX = 12;

function text(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function textList(v, itemMax, countMax) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const t = text(item, itemMax);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= countMax) break;
  }
  return out;
}

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 单张章卡：非对象返回 null；字段缺失给空串 / 空数组；index 由调用方指定。
function normalizeChapterCard(raw, index) {
  if (!isObj(raw)) return null;
  const card = {
    index: Number.isSafeInteger(index) && index >= 1 ? index : 1,
    title: text(raw.title, CARD_TITLE_MAX),
    goal: text(raw.goal, CARD_TEXT_MAX),
    start: text(raw.start, CARD_TEXT_MAX),
    beats: textList(raw.beats, CARD_BEAT_MAX, CARD_BEATS_MAX),
    end: text(raw.end, CARD_TEXT_MAX),
    question: text(raw.question, CARD_QUESTION_MAX),
    avoid: textList(raw.avoid, CARD_TEXT_MAX, CARD_AVOID_MAX),
  };
  // 至少要有目标或节点，否则这张卡对写作没有指导意义。
  if (!card.goal && !card.beats.length && !card.title) return null;
  return card;
}

function normalizeVolume(raw) {
  const v = isObj(raw) ? raw : {};
  return {
    title: text(v.title, CARD_TITLE_MAX * 2),
    promise: text(v.promise, BEAT_MAX),
    catalyst: text(v.catalyst, BEAT_MAX),
    crises: textList(v.crises, BEAT_MAX, CRISES_MAX),
    midpoint: text(v.midpoint, BEAT_MAX),
    low: text(v.low, BEAT_MAX),
    payoff: text(v.payoff, BEAT_MAX),
    hook: text(v.hook, BEAT_MAX),
  };
}

// 整份大纲：章卡至少 1 张才算合法，否则返回 null。章卡 index 按顺序重排为 1..n。
function normalizeOutline(raw) {
  if (!isObj(raw)) return null;
  const chapters = [];
  const list = Array.isArray(raw.chapters) ? raw.chapters : [];
  for (const c of list) {
    const card = normalizeChapterCard(c, chapters.length + 1);
    if (card) chapters.push(card);
    if (chapters.length >= CHAPTERS_MAX) break;
  }
  if (!chapters.length) return null;
  return {
    version: 1,
    premise: text(raw.premise, PREMISE_MAX),
    core_truth: text(raw.core_truth, CORE_TRUTH_MAX),
    hero_arc: text(raw.hero_arc, HERO_ARC_MAX),
    volume: normalizeVolume(raw.volume),
    chapters,
  };
}

// 当前章卡：state.outline.chapters 里 index === state.chapter.index 的那张；没有返回 null。
function currentCard(state) {
  const s = isObj(state) ? state : {};
  const outline = isObj(s.outline) ? s.outline : null;
  const idx = isObj(s.chapter) && Number.isSafeInteger(s.chapter.index) ? s.chapter.index : 1;
  if (!outline || !Array.isArray(outline.chapters)) return null;
  return outline.chapters.find((c) => c && c.index === idx) || null;
}

function freshChapter(startTurn) {
  return { index: 1, startTurn: Number.isSafeInteger(startTurn) && startTurn >= 1 ? startTurn : 1, turns: 0 };
}

module.exports = {
  normalizeOutline,
  normalizeChapterCard,
  currentCard,
  freshChapter,
  CARD_BEATS_MAX,
  CHAPTERS_MAX,
};
