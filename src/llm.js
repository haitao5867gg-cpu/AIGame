'use strict';

// 第 2 / 5 节：调用 OpenAI 兼容 /chat/completions。
// - 零第三方依赖：用 Node 内置 fetch + AbortController 实现超时。
// - 每次调用（含失败）追加一行到 data/usage.jsonl。
// - 当日 token 用量达到上限时拒绝调用（抛出带 status / expose 的中文错误）。
// - LLM_MOCK=1：完全离线，按 purpose 返回确定性假 JSON：
//   建世界(world)、普通回合(turn)、事件开启/结算(turn 变体)、编年史(chapter)、新顶点(apex)。

const store = require('./store.js');

const PURPOSES = Object.freeze({
  WORLD: 'world',     // 建世界
  TURN: 'turn',       // 普通回合 / 事件开启 / 事件结算
  CHAPTER: 'chapter', // 编年史压缩
  APEX: 'apex',       // 新顶点
});

// 由 seed 派生少量差异，保证「同一输入 → 同一输出」的确定性。
function hash(s) {
  let h = 2166136261 >>> 0;
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

// ---- 确定性假数据 ----

function mockWorld(m) {
  const seed = m && m.seed ? String(m.seed) : '一句世界观';
  const n = hash(seed) % 7;
  const title = clip(seed, 10) + '·' + ['纪元', '残卷', '秘史', '长夜', '边境', '旧约', '回响'][n];
  return {
    bible: {
      title,
      tone: '苍茫而诡谲，暗流涌动',
      rules: ['力量皆有代价', '名字即契约', '夜行者不受欺', '旧债终须偿'],
      places: [
        { name: '灰烬港', desc: '终年落灰的旧港，船骸堆成山丘' },
        { name: '无灯塔', desc: '传说顶层藏着一封信，却无人见过亮灯' },
        { name: '枯井集市', desc: '以记忆而非钱币交易的黑市' },
      ],
      factions: [
        { name: '守夜会', desc: '掌管钟声与更漏', stance: '中立偏保守' },
        { name: '拾骨者', desc: '在废墟里淘换旧物', stance: '逐利' },
        { name: '缄默庭', desc: '不立文字的审判者', stance: '敌意未明' },
      ],
      npcs: [
        { name: '守夜人', role: '引路者', desc: '总在雾里提一盏不灭的灯' },
        { name: '铸剑师', role: '匠人', desc: '只肯为记得名字的人锻铁' },
        { name: '拾骨少女', role: '线人', desc: '消息比刀快，笑里藏着价码' },
      ],
      start: { place: '灰烬港', situation: '你在一条搁浅的船上醒来，手里攥着一封无字信。' },
      eventThemes: ['魔族入侵', '宫廷政变', '天灾', '秘境开启', '商路断绝', '古神低语'],
    },
    apex: {
      title: '隐秘王冠',
      hint: '北方的钟声',
      // 初始声望即为 6，条件刻意设为可达，便于跑通顶点检测 / 高光 / 刷新链路。
      condition: { attrs: { 声望: 6 } },
      achievedAt: null,
    },
  };
}

function mockTurn(m) {
  const turn = (m && m.turn) || 1;
  const out = {
    narration: `第${turn}回合，你顺着灰烬港的旧道继续前行，雾里传来断续的钟声，远处有人在低声交换消息。你停下脚步，权衡着下一步该信任谁。`,
    state_diff: { 心智: 1 },
    items_add: turn % 5 === 0 ? ['一枚旧币'] : [],
    items_remove: [],
    npc_attitude: {},
    persona_tags: ['冒险'],
    suggestions: ['继续沿旧道探查', '向守夜人打听钟声', '先去枯井集市补给'],
  };
  // 事件开启：仅当引擎要求时给出 event.title / event.desc。
  if (m && m.needEvent) {
    const theme = m.theme || '秘境开启';
    out.event = {
      title: `${theme}·第${turn}回`,
      desc: `关于「${theme}」的风声骤然收紧，整座灰烬港都屏住了呼吸。`,
    };
  }
  // 事件结算：仅当引擎要求时给出 event_check（attr 为白名单属性，quality 0~3）。
  if (m && m.needSettlement) {
    // quality=3 保证结算分数 >=16（体魄 + 12 + 随机 0~6），不会掉进代价/殒命档，
    // 让 mock 的长时间循环确定性地不死亡。
    out.event_check = { attr: '体魄', response_quality: 3 };
  }
  return out;
}

function mockChapter(m) {
  const from = (m && m.fromTurn) || 1;
  const to = (m && m.toTurn) || 20;
  return {
    summary: (
      `第${from}至${to}回合，旅人在灰烬港与无灯塔之间辗转，几度卷入城中暗流；` +
      `钟声反复出现，守夜人的态度若即若离，旧信仍无一字。声名渐起，却也招来缄默庭的注视。`
    ).slice(0, 300),
  };
}

function mockApex(m) {
  const gen = (m && m.generation) || 2;
  return {
    title: ['隐秘王冠', '无冕之约', '沉钟之主', '雾中冠冕', '未名的加冕'][(gen - 1) % 5],
    hint: ['北方的钟声', '塔顶不灭的灯', '被抹去的第七更', '枯井深处的名字'][gen % 4],
    condition: { attrs: { 声望: 8 + gen } },
  };
}

function mockFor(purpose, m) {
  switch (purpose) {
    case PURPOSES.WORLD: return mockWorld(m);
    case PURPOSES.TURN: return mockTurn(m);
    case PURPOSES.CHAPTER: return mockChapter(m);
    case PURPOSES.APEX: return mockApex(m);
    default: return mockTurn(m);
  }
}

// ---- 用量统计 ----

function dayKey(ts) {
  const d = new Date(ts);
  return (
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

function sumUsage(rows, filterDay) {
  let pt = 0;
  let ct = 0;
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    if (filterDay && dayKey(r.ts) !== filterDay) continue;
    pt += Number(r.prompt_tokens) || 0;
    ct += Number(r.completion_tokens) || 0;
  }
  return { prompt_tokens: pt, completion_tokens: ct, total: pt + ct };
}

function createClient(cfg, dataDir) {
  const mock = !!cfg.LLM_MOCK;
  const timeout = cfg.LLM_TIMEOUT_MS > 0 ? cfg.LLM_TIMEOUT_MS : 90000;
  const dailyLimit = Number(cfg.LLM_DAILY_TOKEN_LIMIT) || 0;
  const base = String(cfg.LLM_BASE || '').replace(/\/+$/, '');
  const apiKey = String(cfg.LLM_API_KEY || '');

  function rows() {
    return store.readJsonl(store.usagePath(dataDir));
  }

  function todayTokens(now) {
    return sumUsage(rows(), dayKey(now)).total;
  }

  function assertLimit(now) {
    if (dailyLimit > 0 && todayTokens(now) >= dailyLimit) {
      const err = new Error(`今日 token 用量已达上限 ${dailyLimit}，拒绝调用 LLM`);
      err.status = 429;
      err.expose = true;
      throw err;
    }
  }

  function appendUsage(rec) {
    store.appendUsage(dataDir, rec);
  }

  function fakeTokens(messages, content) {
    let chars = 0;
    for (const m of Array.isArray(messages) ? messages : []) {
      chars += String((m && m.content) || '').length;
    }
    return {
      prompt_tokens: Math.max(1, Math.ceil(chars / 3)),
      completion_tokens: Math.max(1, Math.ceil(String(content).length / 3)),
    };
  }

  async function httpChat(model, messages, responseFormat) {
    if (!base) {
      const err = new Error('未配置 LLM_BASE，无法调用真实模型');
      err.status = 500;
      err.expose = true;
      throw err;
    }
    const payload = {
      model,
      messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '') }],
      response_format: { type: responseFormat === false ? 'text' : 'json_object' },
    };
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let resp;
    try {
      resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err && err.name === 'AbortError') {
        const e = new Error(`LLM 调用超时（${timeout} ms）`);
        e.status = 504;
        e.expose = true;
        throw e;
      }
      const e = new Error(`LLM 网络请求失败：${err && err.message ? err.message : err}`);
      e.status = 502;
      e.expose = true;
      throw e;
    }
    clearTimeout(timer);
    if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch (_) { /* 忽略读取错误 */ }
      const e = new Error(`LLM 接口返回 ${resp.status}：${clip(text, 200)}`);
      e.status = 502;
      e.expose = true;
      throw e;
    }
    let data;
    try { data = await resp.json(); } catch (_) {
      const e = new Error('LLM 返回不是合法 JSON');
      e.status = 502;
      e.expose = true;
      throw e;
    }
    const content =
      data && data.choices && data.choices[0] &&
      data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string') {
      const e = new Error('LLM 返回缺少 choices[0].message.content');
      e.status = 502;
      e.expose = true;
      throw e;
    }
    const u = (data && data.usage) || {};
    return {
      content,
      usage: {
        prompt_tokens: Number(u.prompt_tokens) || 0,
        completion_tokens: Number(u.completion_tokens) || 0,
      },
    };
  }

  // 返回 { content, model, usage:{prompt_tokens,completion_tokens}, ms, ok }
  async function complete(opts) {
    const o = opts || {};
    const now = Date.now();
    assertLimit(now);
    const purpose = o.purpose || PURPOSES.TURN;
    const model = o.model || cfg.LLM_MODEL;
    const messages = o.messages || [];

    if (mock) {
      const content = JSON.stringify(mockFor(purpose, o.mock));
      const usage = fakeTokens(messages, content);
      appendUsage({
        ts: now, model, purpose,
        prompt_tokens: usage.prompt_tokens,
        completion_tokens: usage.completion_tokens,
        ms: 1, ok: true,
      });
      return { content, model, usage, ms: 1, ok: true };
    }

    const t0 = Date.now();
    try {
      const r = await httpChat(model, messages, o.responseFormat);
      const ms = Date.now() - t0;
      appendUsage({
        ts: now, model, purpose,
        prompt_tokens: r.usage.prompt_tokens,
        completion_tokens: r.usage.completion_tokens,
        ms, ok: true,
      });
      return { content: r.content, model, usage: r.usage, ms, ok: true };
    } catch (err) {
      const ms = Date.now() - t0;
      appendUsage({ ts: now, model, purpose, prompt_tokens: 0, completion_tokens: 0, ms, ok: false });
      throw err;
    }
  }

  function summarizeUsage(now) {
    const ts = now == null ? Date.now() : now;
    const all = rows();
    return {
      date: dayKey(ts),
      today: sumUsage(all, dayKey(ts)),
      cumulative: sumUsage(all, null),
      limit: dailyLimit,
    };
  }

  return { complete, summarizeUsage, mock, PURPOSES };
}

module.exports = { createClient, PURPOSES };
