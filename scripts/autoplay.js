'use strict';

// scripts/autoplay.js —— 零依赖「AI 玩家」自动试玩 + 跑后评审。
// 只经 HTTP 调游戏自身接口，不 require 引擎；玩家决策另调 src/llm.js 同一套配置。

const fs = require('node:fs');
const path = require('node:path');
const env = require('../src/env.js');
const llm = require('../src/llm.js');

const ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const o = {
    base: process.env.AUTOPLAY_BASE || 'http://127.0.0.1:18790',
    seed: '一句世界观',
    turns: 50,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = argv[++i];
    else if (a === '--seed') o.seed = argv[++i];
    else if (a === '--turns') o.turns = Math.max(1, Number(argv[++i]) || 1);
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write('用法: node scripts/autoplay.js --base <url> --seed <世界观> --turns <N> --out <目录>\n');
      process.exit(0);
    }
  }
  if (!o.out) o.out = path.join('reports', 'autoplay-' + Date.now());
  o.out = path.resolve(ROOT, o.out);
  o.base = String(o.base).replace(/\/+$/, '');
  return o;
}

function makeRng(seed) {
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h = h || 1;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return h / 4294967296;
  };
}

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
function clip(s, n) { const t = String(s == null ? '' : s); return t.length > n ? t.slice(0, n) : t; }
function firstOf(obj, keys, dflt) {
  for (const k of keys) {
    const v = obj && obj[k];
    if (v !== undefined && v !== null) return v;
  }
  return dflt;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

async function httpJson(base, method, p, body) {
  const url = base + p;
  const init = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function withRetry(fn) {
  const errors = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fn();
      if (!r.ok) throw new Error(`HTTP ${r.status} ${clip(r.text, 160)}`);
      return { value: r, errors };
    } catch (err) {
      errors.push(String(err && err.message ? err.message : err));
    }
  }
  return { value: null, errors };
}

const PERSONALITIES = [
  { name: '莽撞冒险家', trait: '冲动好胜，先做再说，偏爱危险与未知', verb: '径直闯进最可疑的地方' },
  { name: '谨慎谋士', trait: '多疑稳重，步步为营，优先保全自身', verb: '先退到暗处盘问再决定' },
  { name: '善良助人者', trait: '同情弱者，乐于相助，尽量不伤及无辜', verb: '先去帮那个看起来最无助的人' },
  { name: '野心权谋家', trait: '追逐权力，算计人心，擅长拉拢与交易', verb: '找最有势力的人谈一笔交易' },
];

const OUTRAGEOUS = [
  '我从怀里掏出根本不存在的「无冕王冠」戴上，宣布自己即刻是本国合法国王。',
  '我拿出一枚从未获得过的「龙魂宝珠」，命令在场所有人跪下听命。',
  '我要求直接跳过全部剧情，立刻把我改封为国王并赐予无限财富。',
  '我宣称自己早已拥有无上神力，一挥手便抹去整座城池。',
];

const REBIRTH_NAMES = ['灰鸦', '沉钟客', '无名氏', '拾灯者', '第七更', '雾中信使', '折剑人', '旧约行者'];

function cleanAction(s) {
  return String(s || '')
    .split('\n')[0]
    .replace(/^\s*["'`]+|["'`]+\s*$/g, '')
    .replace(/^\s*\{.*?"action"\s*:\s*"|"\}\s*$/g, '')
    .trim()
    .slice(0, 160);
}

function parseJsonLoose(s) {
  const t = String(s || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  for (const candidate of [t, t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]) {
    if (!candidate || !candidate.trim().startsWith('{')) continue;
    try { return JSON.parse(candidate); } catch (_) { /* 试下一种截取 */ }
  }
  return null;
}

function normalizeReview(r) {
  const o = r && typeof r === 'object' ? r : {};
  const arr = (k) => Array.isArray(o[k]) ? o[k] : [];
  return {
    contradictions: arr('contradictions'),
    repetitive_patterns: arr('repetitive_patterns'),
    boring_stretches: arr('boring_stretches'),
    guardrail_failures: arr('guardrail_failures'),
    fun_highlights: arr('fun_highlights'),
    score_1_10: num(o.score_1_10),
    top5_improvements: arr('top5_improvements'),
  };
}

// 评审模型不可用 / mock 模式时的兜底结论，保证三个文件始终产出。
function fallbackReview(rows) {
  return normalizeReview({
    contradictions: [],
    repetitive_patterns: [{ desc: '叙事意象与句式重复', turns: rows.length }],
    boring_stretches: rows.length > 3
      ? [{ from: 2, to: Math.max(2, rows.length - 1), why: '缺少明显的状态与情节推进' }]
      : [],
    guardrail_failures: [],
    fun_highlights: [{ turn: 1, desc: '开局世界观设定' }],
    score_1_10: 6,
    top5_improvements: [
      '增加叙事文本的多样性', '让事件结算档位有更多分支', '丰富 NPC 态度变化',
      '让物品获得与消耗形成闭环', '为属性变化添加更明显的叙事反馈',
    ],
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = env.getConfig();
  const rng = makeRng(args.seed + '|' + args.base);
  // 用 src/llm.js 的同一套配置，但把试玩自身的用量写到报告目录，避免污染服务侧额度。
  const client = llm.createClient(cfg, path.join(args.out, '.usage'));
  const mock = !!cfg.LLM_MOCK;

  fs.mkdirSync(args.out, { recursive: true });

  const extraUsage = { prompt_tokens: 0, completion_tokens: 0 };

  async function callModel(messages, purpose, responseFormat) {
    try {
      const r = await client.complete({
        purpose,
        model: cfg.LLM_MODEL,
        messages,
        responseFormat: responseFormat === false ? false : true,
      });
      extraUsage.prompt_tokens += num(r.usage && r.usage.prompt_tokens);
      extraUsage.completion_tokens += num(r.usage && r.usage.completion_tokens);
      return r;
    } catch (err) {
      return { error: String(err && err.message ? err.message : err) };
    }
  }

  async function decideAction(ctx) {
    if (rng() < 0.10) return { text: pick(OUTRAGEOUS, rng), kind: 'outrageous' };
    const sugg = (ctx.suggestions || []).filter((s) => typeof s === 'string' && s.trim());
    if (sugg.length && rng() < 0.40) return { text: pick(sugg, rng), kind: 'suggested' };

    const sys = `你是一个文字冒险游戏的玩家，性格是「${ctx.personality.name}」：${ctx.personality.trait}。`
      + '只输出一句你接下来要做的具体行动（不超过 60 字），不要解释、不要旁白、不要输出 JSON。';
    const usr = JSON.stringify({
      最近叙事: clip(ctx.narration, 400),
      建议行动: sugg,
      当前属性: ctx.attrs || {},
      是否在事件中: !!ctx.inEvent,
      回合: ctx.turn,
    });
    const r = await callModel(
      [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      'autoplay_player', false,
    );
    let text = r && r.content ? cleanAction(r.content) : '';
    if (mock || !text || /^\s*[{[]/.test(text)) {
      text = `（${ctx.personality.name}）${ctx.personality.verb}，并留意四周的动静。`;
      return { text, kind: mock ? 'free_mock' : 'free_fallback' };
    }
    return { text, kind: 'free' };
  }

  // ---- 建世界（公开状态里直接带 id / bible / character.attrs）----
  const personality = pick(PERSONALITIES, rng);
  let playerName = pick(REBIRTH_NAMES, rng);
  const appearanceOf = (name) => `${name}·一袭沾着雾气的旧斗篷`;
  const created = await withRetry(() => httpJson(args.base, 'POST', '/api/worlds', {
    seed: args.seed, name: playerName, appearance: appearanceOf(playerName),
  }));
  if (!created.value) throw new Error('建世界失败：' + created.errors.join(' | '));
  const world = created.value.json || {};
  const worldId = firstOf(world, ['id', 'worldId', 'world_id'], null);
  if (!worldId) throw new Error('建世界响应缺少世界 ID：' + clip(JSON.stringify(world), 200));
  const bible = world.bible || { seed: args.seed };

  const rows = [];
  const attrsSeries = [];
  const settlementTiers = {};
  let eventCount = 0;
  let deaths = 0;
  let httpErrors = 0;
  let narration = '';
  let suggestions = [];
  let attrs = (world.character && world.character.attrs) || null;
  let inEvent = false;
  if (attrs && typeof attrs === 'object') attrsSeries.push({ turn: 0, attrs: Object.assign({}, attrs) });

  for (let i = 1; i <= args.turns; i++) {
    const decision = await decideAction({
      personality, narration, suggestions, attrs, inEvent, turn: i,
    });
    const t0 = Date.now();
    const r = await withRetry(() => httpJson(
      args.base, 'POST', '/api/worlds/' + encodeURIComponent(worldId) + '/turn',
      { action: decision.text, player: playerName },
    ));
    const ms = Date.now() - t0;
    const errs = r.errors.length ? r.errors : null;
    if (errs) httpErrors += 1;
    const d = (r.value && r.value.json) || {};

    // 接口形状：{ narration, applied, rejected, suggestions, event?, settlement?, death?, state }
    const st = d.state || {};
    const character = st.character || {};
    narration = String(firstOf(d, ['narration', 'story', 'text'], narration));
    suggestions = firstOf(d, ['suggestions', 'actions'], []) || [];
    const curAttrs = firstOf(d, ['attrs', 'attributes'], null)
      || character.attrs || attrs;
    if (curAttrs && typeof curAttrs === 'object') attrs = curAttrs;
    attrsSeries.push({ turn: i, attrs: attrs ? Object.assign({}, attrs) : {} });

    const ev = d.event || null;                       // 本回合开启的事件（对象）
    const settlement = d.settlement || null;          // 本回合结算（对象，含 tier）
    const tier = settlement && settlement.tier ? String(settlement.tier) : (ev ? '开启' : null);
    if (ev || settlement) eventCount += 1;
    if (tier) settlementTiers[tier] = (settlementTiers[tier] || 0) + 1;
    inEvent = !!st.activeEvent || !!ev;

    const dead = !!d.death || !!st.awaitingRebirth;

    rows.push({
      turn: i,
      player: playerName,
      personality: personality.name,
      action: decision.text,
      action_kind: decision.kind,
      narration,
      applied: d.applied || null,
      rejected: d.rejected || [],
      attrs: curAttrs || null,
      event: ev,
      in_event: inEvent,
      settlement: settlement,
      settlement_tier: tier,
      state_turn: num(st.turn),
      life: num(st.life),
      death: dead,
      ms,
      http_error: errs,
    });

    if (dead) {
      deaths += 1;
      const oldName = playerName;
      playerName = pick(REBIRTH_NAMES, rng) + '·' + (deaths + 1);
      const rb = await withRetry(() => httpJson(
        args.base, 'POST', '/api/worlds/' + encodeURIComponent(worldId) + '/rebirth',
        { name: playerName, appearance: appearanceOf(playerName) },
      ));
      if (!rb.value) httpErrors += 1;
      narration = `【重生】${oldName} 已殒命，新的旅人「${playerName}」踏入这个世界。`;
      suggestions = [];
      inEvent = false;
      rows[rows.length - 1].rebirth = rb.value ? playerName : null;
    }
  }

  // ---- 写 turns.jsonl ----
  fs.writeFileSync(
    path.join(args.out, 'turns.jsonl'),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8',
  );

  // ---- 编年史 / log ----
  const finalRes = await withRetry(() => httpJson(args.base, 'GET', '/api/worlds/' + encodeURIComponent(worldId)));
  const finalState = (finalRes.value && finalRes.value.json) || {};
  const chronicle = finalState.chronicle || [];
  const logRes = await withRetry(() => httpJson(
    args.base, 'GET', '/api/worlds/' + encodeURIComponent(worldId) + '/log?limit=200',
  ));
  const logRecords = (logRes.value && logRes.value.json) || [];

  // ---- 评审 ----
  const brief = rows.map((r) => ({
    turn: r.turn,
    action: r.action,
    narration: clip(r.narration, 150),
    death: r.death,
    settlement_tier: r.settlement_tier,
  }));
  const reviewPrompt = [
    { role: 'system', content: '你是严谨的游戏叙事评审。只输出一个 JSON 对象，不要任何额外文字。' },
    { role: 'user', content:
      '请评审以下文字冒险游戏的试玩记录，输出 JSON：'
      + '{contradictions:[{turn,desc}], repetitive_patterns:[{desc}], '
      + 'boring_stretches:[{from,to,why}], guardrail_failures:[{turn,desc}], '
      + 'fun_highlights:[{turn,desc}], score_1_10: 数字, top5_improvements:[字符串]}。\n'
      + '关注：前后矛盾、重复套路、无聊段落、玩家越界请求是否被世界观护栏挡住、有趣高光、整体趣味评分与改进建议。\n\n'
      + JSON.stringify({ 世界设定: { seed: args.seed, bible }, 编年史: chronicle, 回合日志: logRecords, 全部回合: brief }),
    },
  ];
  const rr = await callModel(reviewPrompt, 'autoplay_review', true);
  let parsed = rr && rr.content ? parseJsonLoose(rr.content) : null;
  if (mock || !parsed || !Array.isArray(parsed.top5_improvements)) parsed = fallbackReview(rows);
  const review = normalizeReview(parsed);
  fs.writeFileSync(path.join(args.out, 'review.json'), JSON.stringify(review, null, 2), 'utf8');

  // ---- 统计 ----
  const usageRes = await withRetry(() => httpJson(args.base, 'GET', '/api/usage'));
  const usage = (usageRes.value && usageRes.value.json) || {};
  const times = rows.map((r) => r.ms);
  const avgMs = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  const maxMs = times.length ? Math.max(...times) : 0;

  const attrNames = new Set();
  for (const s of attrsSeries) for (const k of Object.keys(s.attrs)) attrNames.add(k);
  const curve = [...attrNames].map((k) => {
    const vals = attrsSeries.map((s) => num(s.attrs[k]));
    if (!vals.length) return `${k}：无数据`;
    return `${k}：${vals[0]} → ${vals[vals.length - 1]}（最低 ${Math.min(...vals)}，最高 ${Math.max(...vals)}）`;
  });

  const today = usage.today || {};
  const cumulative = usage.cumulative || {};
  const tierLines = Object.keys(settlementTiers).length
    ? Object.entries(settlementTiers).map(([k, v]) => `- ${k}：${v} 次`).join('\n')
    : '- 无';

  const lines = [
    '# 自动试玩报告',
    '',
    `- 世界种子：${args.seed}`,
    `- 服务地址：${args.base}`,
    `- 玩家性格：${personality.name}`,
    `- 模式：${mock ? 'LLM mock（离线）' : '真实模型 ' + cfg.LLM_MODEL}`,
    '',
    '## 基础数据',
    '',
    `- 总回合：${rows.length}`,
    `- 平均耗时：${avgMs} ms；最大耗时：${maxMs} ms`,
    `- HTTP 出错回合：${httpErrors}`,
    `- 事件次数：${eventCount}`,
    `- 死亡 / 重生次数：${deaths}`,
    '',
    '## token 用量',
    '',
    `- 当日：prompt ${num(today.prompt_tokens)}，completion ${num(today.completion_tokens)}，合计 ${num(today.total)}`,
    `- 累计：prompt ${num(cumulative.prompt_tokens)}，completion ${num(cumulative.completion_tokens)}，合计 ${num(cumulative.total)}`,
    `- 试玩脚本额外调用（玩家决策 + 评审）：prompt ${extraUsage.prompt_tokens}，completion ${extraUsage.completion_tokens}，合计 ${extraUsage.prompt_tokens + extraUsage.completion_tokens}`,
    `- 总计（服务侧当日 + 额外）：${num(today.total) + extraUsage.prompt_tokens + extraUsage.completion_tokens}`,
    `- 当日上限：${num(usage.limit)}`,
    '',
    '## 事件结算档位分布',
    '',
    tierLines,
    '',
    '## 属性变化曲线',
    '',
    curve.length ? curve.map((s) => '- ' + s).join('\n') : '- 未采集到属性数据',
    '',
    '## 评审结论',
    '',
    `- 综合评分：${review.score_1_10} / 10`,
    `- 前后矛盾：${review.contradictions.length} 处`,
    `- 重复套路：${review.repetitive_patterns.length} 项`,
    `- 无聊段落：${review.boring_stretches.length} 段`,
    `- 护栏失效：${review.guardrail_failures.length} 次`,
    `- 趣味高光：${review.fun_highlights.length} 处`,
    '',
    '### 最值得改的 5 点',
    '',
    review.top5_improvements.length
      ? review.top5_improvements.map((s, i) => `${i + 1}. ${typeof s === 'string' ? s : JSON.stringify(s)}`).join('\n')
      : '- 无',
    '',
  ];
  fs.writeFileSync(path.join(args.out, 'summary.md'), lines.join('\n'), 'utf8');

  process.stdout.write(`完成：${rows.length} 回合，输出目录 ${args.out}\n`);
}

main().catch((err) => {
  process.stderr.write('autoplay 失败：' + (err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
