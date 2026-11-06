'use strict';

const { ATTRS, PERSONA_DIMS, ATTR_MIN, ATTR_MAX, NPC_MIN, NPC_MAX, NPC_DIFF_MAX, DIFF_MIN, DIFF_MAX, DIFF_POSITIVE_TOTAL_MAX, ITEMS_ADD_MAX, ITEM_NAME_MAX, NARRATION_MIN, NARRATION_MAX, PERSONA_INIT, PERSONA_REGRESSION } = require('./constants.js');
const { clamp, toInt, cleanDialogueTics } = require('./util.js');

// ---- validateProposal：把 LLM 提议消毒成实际可应用的 diff ----

function validateProposal(state, proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const rejected = [];
  const applied = {
    state_diff: {},
    items_add: [],
    items_remove: [],
    npc_attitude: {},
    persona_tags: [],
    persona: {},
    suggestions: [],
    narration: '',
  };

  // 叙事：10~1200 字；超出截断，过短 = 无效回合。
  let narration = typeof p.narration === 'string' ? p.narration : '';
  if (narration.length > NARRATION_MAX) {
    narration = narration.slice(0, NARRATION_MAX);
    rejected.push(`叙事超过 ${NARRATION_MAX} 字，已截断`);
  }
  narration = cleanDialogueTics(narration);
  applied.narration = narration;
  if (narration.length < NARRATION_MIN) {
    return { applied, rejected, error: `叙事过短（少于 ${NARRATION_MIN} 字），本回合无效，请重试` };
  }

  // state_diff：白名单 / 取整 / 单项 [-2,+1] / 正向总和 ≤ 2（按顺序截断）/ 属性 [0,40]
  const diff = p.state_diff && typeof p.state_diff === 'object' ? p.state_diff : {};
  let positiveTotal = 0;
  for (const key of Object.keys(diff)) {
    if (!ATTRS.includes(key)) {
      rejected.push(`忽略未知属性「${key}」`);
      continue;
    }
    const raw = diff[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      rejected.push(`属性「${key}」的变化值无效，已忽略`);
      continue;
    }
    let delta = toInt(raw);
    if (delta === 0) continue;
    if (delta > DIFF_MAX) {
      rejected.push(`「${key}」单项变化超过 +${DIFF_MAX}，已截断`);
      delta = DIFF_MAX;
    }
    if (delta < DIFF_MIN) {
      rejected.push(`「${key}」单项变化超过 ${DIFF_MIN}，已截断`);
      delta = DIFF_MIN;
    }
    if (delta > 0) {
      if (positiveTotal >= DIFF_POSITIVE_TOTAL_MAX) {
        rejected.push(`正向变化总和已达 ${DIFF_POSITIVE_TOTAL_MAX}，忽略「${key}」`);
        continue;
      }
      if (positiveTotal + delta > DIFF_POSITIVE_TOTAL_MAX) {
        const allowed = DIFF_POSITIVE_TOTAL_MAX - positiveTotal;
        rejected.push(`正向变化总和超过 ${DIFF_POSITIVE_TOTAL_MAX}，「${key}」由 +${delta} 截断为 +${allowed}`);
        delta = allowed;
      }
      positiveTotal += delta;
    }
    const cur = state.character.attrs[key];
    if (delta > 0 && cur >= ATTR_MAX) {
      rejected.push(`「${key}」已达上限 ${ATTR_MAX}，增长丢弃（叙事照常）`);
      continue;
    }
    const next = clamp(cur + delta, ATTR_MIN, ATTR_MAX);
    const actual = next - cur;
    if (actual === 0) {
      rejected.push(`「${key}」变化后无实际增减`);
      continue;
    }
    applied.state_diff[key] = actual;
  }

  // items_add：每回合 ≤ 2，每个 ≤ 12 字，不重复已有物品
  const owned = Array.isArray(state.character.items) ? state.character.items : [];
  const addInput = Array.isArray(p.items_add) ? p.items_add : [];
  for (const raw of addInput) {
    if (applied.items_add.length >= ITEMS_ADD_MAX) {
      rejected.push(`每回合最多新增 ${ITEMS_ADD_MAX} 件物品，其余忽略`);
      break;
    }
    if (typeof raw !== 'string') {
      rejected.push('忽略非字符串物品名');
      continue;
    }
    const name = raw.trim();
    if (!name) {
      rejected.push('忽略空物品名');
      continue;
    }
    if (name.length > ITEM_NAME_MAX) {
      rejected.push(`物品「${name}」超过 ${ITEM_NAME_MAX} 字，已忽略`);
      continue;
    }
    if (owned.includes(name) || applied.items_add.includes(name)) {
      rejected.push(`物品「${name}」已拥有，不重复添加`);
      continue;
    }
    applied.items_add.push(name);
  }

  // items_remove：只能移除已拥有的
  const removeInput = Array.isArray(p.items_remove) ? p.items_remove : [];
  const seenRemove = new Set();
  for (const raw of removeInput) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim();
    if (!name || seenRemove.has(name)) continue;
    seenRemove.add(name);
    if (!owned.includes(name)) {
      rejected.push(`物品「${name}」并未拥有，不能移除`);
      continue;
    }
    applied.items_remove.push(name);
  }

  // npc_attitude：bible.npcs 里存在，或叙事里新出现的人名（零依赖：子串启发式）
  const npcInput = p.npc_attitude && typeof p.npc_attitude === 'object' ? p.npc_attitude : {};
  const bibleNpcs = state.bible && Array.isArray(state.bible.npcs) ? state.bible.npcs : [];
  const knownNames = new Set(
    bibleNpcs.map((n) => (n && typeof n.name === 'string' ? n.name : '')).filter(Boolean),
  );
  const stateNpcs = state.npcAttitude && typeof state.npcAttitude === 'object' ? state.npcAttitude : {};
  for (const name of Object.keys(npcInput)) {
    const known = knownNames.has(name) || Object.prototype.hasOwnProperty.call(stateNpcs, name);
    const appeared = narration.includes(name);
    if (!known && !appeared) {
      rejected.push(`忽略未在设定或叙事中出现的 NPC「${name}」`);
      continue;
    }
    const raw = npcInput[name];
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      rejected.push(`NPC「${name}」态度变化值无效，已忽略`);
      continue;
    }
    const wanted = toInt(raw);
    const delta = clamp(wanted, -NPC_DIFF_MAX, NPC_DIFF_MAX);
    if (delta !== wanted) rejected.push(`NPC「${name}」单回合态度变化截断为 ${delta}`);
    const cur = stateNpcs[name] || 0;
    const next = clamp(cur + delta, NPC_MIN, NPC_MAX);
    applied.npc_attitude[name] = next - cur;
  }

  // persona_tags：只接受 6 个维度；命中 +1，其余向 50 回归 0.2；夹 [0,100]
  const tagInput = Array.isArray(p.persona_tags) ? p.persona_tags : [];
  const hits = new Set();
  for (const tag of tagInput) {
    if (PERSONA_DIMS.includes(tag)) hits.add(tag);
    else rejected.push(`忽略未知人格维度「${String(tag)}」`);
  }
  applied.persona_tags = Array.from(hits);
  const curPersona = state.persona && typeof state.persona === 'object' ? state.persona : {};
  for (const dim of PERSONA_DIMS) {
    const cur = typeof curPersona[dim] === 'number' ? curPersona[dim] : PERSONA_INIT;
    const v = hits.has(dim) ? cur + 1 : cur + (PERSONA_INIT - cur) * PERSONA_REGRESSION;
    applied.persona[dim] = Math.round(clamp(v, 0, 100) * 100) / 100;
  }

  applied.suggestions = (Array.isArray(p.suggestions) ? p.suggestions : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => x.trim());

  return { applied, rejected, error: null };
}

module.exports = {
  validateProposal,
};
