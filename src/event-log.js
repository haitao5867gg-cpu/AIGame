'use strict';

// ---- 共享「可见事件」过滤（纯函数） ----
//
// events.jsonl 只追加不删除。撤回（undo）以 {type:'undo', undoneTurn} 标记，
// 紧跟在被撤回回合记录之后。一条记录是否「canonical 可见」用位置判定：
//   - 所有 undo 标记本身不是叙事，隐藏；
//   - 每条 undo 标记前一条 turn === undoneTurn 的回合记录一并隐藏；
//   - 撤回后再走一步会复用同一 turn 号，新记录位于标记之后、仍可见。
//
// 这是 game.visibleEventRecords 的共享实现，NPC 档案回填 / 历史 / AI 资料都
// 必须复用它，确保「撤回旧分支不能复活」。game.js 保留自己的同名导出以兼容，
// 后续任务可把它迁移到本模块。
//
// visibleEventEntries 额外保留每条记录在原始 events 数组中的位置 eventIndex，
// 供历史分页使用：cursor 用原始日志位置而非 turn 号（撤回后会重用 turn 号）。

function visibleEventEntries(events) {
  const list = Array.isArray(events) ? events : [];
  const hidden = new Set();
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.type !== 'undo') continue;
    hidden.add(i);
    const prev = list[i - 1];
    if (prev && prev.type !== 'undo' && prev.turn === e.undoneTurn) hidden.add(i - 1);
  }
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (hidden.has(i)) continue;
    out.push({ eventIndex: i, record: list[i] });
  }
  return out;
}

// 与 game.visibleEventRecords 行为一致：只返回可见记录本身（无 eventIndex）。
function visibleEventRecords(events) {
  return visibleEventEntries(events).map((e) => e.record);
}

module.exports = {
  visibleEventEntries,
  visibleEventRecords,
};
