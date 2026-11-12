'use strict';

// ---- 本世前文（叙事 v3，纯函数） ----
//
// 把玩家在这一世读到过的全部正文按时间顺序拼起来交给写正文的模型：
//   开场（第 1 世用 bible.start.situation，之后用 state.rebirthOpening）
//   + 每回合「第 N 回合　你：行动」与正文原文。
// 超出预算时从最新往前保留原文，更早的部分用覆盖这些回合的章摘要（state.chapters）
// 或旧编年史（state.chronicle）代替。撤回的回合由 visibleEventRecords 去掉。

const { visibleEventRecords } = require('./event-log.js');

const DEFAULT_BUDGET = 30000;

function turnBlock(e) {
  const action = typeof e.action === 'string' && e.action.trim() ? e.action.trim() : '（未填写）';
  return `第 ${e.turn} 回合　你：${action}\n${e.narration}`;
}

function summariesBefore(state, beforeTurn) {
  const out = [];
  const chapters = Array.isArray(state.chapters) ? state.chapters : [];
  for (const c of chapters) {
    if (c && typeof c.summary === 'string' && c.summary && Number(c.toTurn) < beforeTurn) {
      out.push(`第 ${c.index} 章「${c.title || ''}」（第 ${c.fromTurn}~${c.toTurn} 回合）：${c.summary}`);
    }
  }
  if (out.length) return out;
  const chronicle = Array.isArray(state.chronicle) ? state.chronicle : [];
  for (const c of chronicle) {
    if (c && typeof c.summary === 'string' && c.summary && Number(c.toTurn) < beforeTurn) {
      out.push(`第 ${c.fromTurn}~${c.toTurn} 回合：${c.summary}`);
    }
  }
  return out;
}

function buildStoryHistory(events, state, opts) {
  const s = state && typeof state === 'object' ? state : {};
  const budgetRaw = opts && Number(opts.budget);
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : DEFAULT_BUDGET;
  const life = Number.isSafeInteger(s.life) ? s.life : 1;

  const bible = s.bible && typeof s.bible === 'object' ? s.bible : {};
  let opening = '';
  if (life <= 1) opening = (bible.start && typeof bible.start.situation === 'string') ? bible.start.situation.trim() : '';
  else opening = typeof s.rebirthOpening === 'string' ? s.rebirthOpening.trim() : '';

  let records = [];
  try {
    records = visibleEventRecords(events).filter((e) => e && e.type !== 'undo'
      && e.rebirthOpening !== true
      && Number(e.life) === life
      && typeof e.narration === 'string' && e.narration.length > 0);
  } catch (_) {
    records = [];
  }

  // 从最新往前装，直到超出预算。
  const kept = [];
  let used = opening.length;
  for (let i = records.length - 1; i >= 0; i--) {
    const block = turnBlock(records[i]);
    if (kept.length && used + block.length > budget) break;
    kept.unshift(records[i]);
    used += block.length;
  }
  const dropped = records.length - kept.length;
  const coveredFrom = kept.length ? kept[0].turn : null;

  const parts = [];
  if (dropped > 0 && coveredFrom != null) {
    const sums = summariesBefore(s, coveredFrom);
    if (sums.length) parts.push('【更早的经过（摘要）】\n' + sums.join('\n'));
  }
  if (opening) parts.push('【开场】\n' + opening);
  for (const e of kept) parts.push(turnBlock(e));
  const textOut = parts.join('\n\n');
  return { text: textOut, coveredFrom, chars: textOut.length, dropped };
}

module.exports = { buildStoryHistory, DEFAULT_BUDGET };
