'use strict';
// 纯场景选择（UMD，零依赖、只读）：把公开世界状态 + 可选回合信息映射为氛围 DTO，
// 供背景层 / 音频层使用。绝不读 omen / apex / 导演倒计时 / 隐藏 NPC 意图 / 未发生事件；
// 不调用模型、不碰文件与网络、不维护游戏时钟或定时器；不改 state / 剧情。
//   normalizePrefs(raw, base?)                         与后端 normalizeAtmosphere 同语义
//   resolve(state, opts?) -> {worldId, theme, background, period, mood, ambience, location}
//
// resolve 的输入（只读）：
//   state : { id, genre, bible:{title,genre,start:{place}}, location,
//             clock:{period}, focus, continuing, danger, recent:[{narration}] }
//   opts  : { prefs, mode?, focus?, narration?, scene?:{action,place} }
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;                 // Node
  } else if (root) {
    root.AtmosphereState = api;           // 浏览器 window / vm 沙箱全局
  }
})(typeof globalThis !== 'undefined' ? globalThis
  : typeof self !== 'undefined' ? self
    : typeof window !== 'undefined' ? window : this,
function () {
  'use strict';

  var MODES = { auto: true, calm: true, explore: true, tense: true };
  var READING_MODES = { auto: true, paper: true, night: true };
  var DEFAULT_ATMOSPHERE = Object.freeze({
    background: true,
    enabled: false,
    musicVolume: 0.16,
    ambienceVolume: 0.10,
    mode: 'auto',
    reading: 'auto',
  });

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  // 音量仅有限 number，夹 0..1；非法（字符串 / NaN / Infinity / 缺省）保留 fallback。
  function clampVolume(v, fallback) {
    if (typeof v !== 'number' || !isFinite(v)) return fallback;
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  // normalizePrefs(raw, base?) 与后端同语义：合法字段生效；非法 / 缺省取 base 对应值。
  // base 先完全归一化，保证 fallback 始终合法；无 base 时 base 即默认（缺省取默认）。
  function normalizePrefs(raw, base) {
    var b = (base && typeof base === 'object' && !Array.isArray(base))
      ? normalizePrefs(base) : DEFAULT_ATMOSPHERE;
    var t = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    return {
      background: typeof t.background === 'boolean' ? t.background : b.background,
      enabled: typeof t.enabled === 'boolean' ? t.enabled : b.enabled,
      musicVolume: clampVolume(t.musicVolume, b.musicVolume),
      ambienceVolume: clampVolume(t.ambienceVolume, b.ambienceVolume),
      mode: typeof t.mode === 'string' && hasOwn(MODES, t.mode) ? t.mode : b.mode,
      reading: typeof t.reading === 'string' && hasOwn(READING_MODES, t.reading) ? t.reading : b.reading,
    };
  }

  // 阅读底色：显式 paper / night 原样返回；其余（auto / 非法）随时辰——dawn/day 亮、其它暗。
  function resolveReading(reading, period) {
    if (reading === 'paper' || reading === 'night') return reading;
    return (period === 'dawn' || period === 'day') ? 'paper' : 'night';
  }

  // ---------- 只读、确定性分类 ----------

  var PERIOD_MAP = { '清晨': 'dawn', '午后': 'day', '黄昏': 'dusk', '深夜': 'night' };
  var QUIET_FOCUS = { social: true, private: true, rest: true, intimate: true };

  // 明确室外田地才 field；房/屋/阁/堂/殿/室/洞/药庐 等室内优先判 neutral；未知 neutral。
  // 仅用地点名字符串，绝不读 bible.places 描写去「造」新物件。
  // 郊野/旷野/山野/荒野/野地是野地不是农田，一律不进 FIELD_RE。
  var FIELD_RE = /灵田|田埂|田间|稻田|田野|田地|麦田|水田|农田|菜田|田垄|垄间|庄稼地|田边/;
  var INDOOR_RE = /房|屋|阁|堂|殿|室|洞|庐|舍|院|楼|馆|栈|庵|寺|府|宅|厅|厢|斋|轩|榭|廊|檐|塔|祠|坊|铺|居/;
  // 「屋外/阁外/院外/庐外…」：室内词后紧跟「外」表示室外，不再按室内处理。
  var OUTDOOR_RE = /(?:屋|房|阁|院|庐|楼|堂|殿|室|洞|舍|馆|轩|斋|廊|檐|塔|祠|坊|铺|居|门|窗|墙|寨|城|庄)外/;

  // 已发生的交战 / 搏斗（公开、现实）——唯一允许的 tense 文本信号。
  var COMBAT_RE = /交战|搏斗|厮杀|混战|激战|恶战|血战|大战|交手|打斗|缠斗|开打|动手|兵刃相接|挥剑相向|厮打|格斗|过招|对阵|迎战|砍杀|肉搏|打了起来|动起手|杀将过来/;
  // 曾经 / 传闻 / 如果 / 战后 / 否定 / 未来 / 假设 / 回忆 ——一律不当「已发生」，保守不切危险乐。
  var NONREAL_RE = /曾经|往日|昔日|从前|当年|那年|以前|过去|旧时|回忆|想起|记得|忆起|传闻|据说|听说|据传|相传|如果|要是|假如|倘若|万一|一旦|假设|明日|明天|明儿|来日|改日|将来|将要|即将|恐将|打算|准备|计划|预计|战后|战罢|事后|后来|之后|停战|休战|收兵|没有|并未|不曾|不想|不愿|不肯|不敢|不会|不再|若是|说不定|会不会|可能要|怕是要|像要|莫非|难道/;

  var RAIN_WORD_RE = /雨/; // 粗筛：rainAudibleIndoors 用，正文是否出现「雨」字
  // 正向：只认明确「正在下雨 / 雨打落」等现实事件；单独一个「雨」字或雨伞 / 雨衣 / 雨水等名词都不算。
  var RAIN_EVENT_RE = /(?:下|落|降|飘|淋|冒|洒)[着了起过]?[^，。！？；\s]{0,2}雨|(?:大|细|暴|骤|小|春|秋|阵|急|毛|瓢泼|倾盆|滂沱)雨|雨(?:点|滴|丝|幕|势|声|珠|帘|注|箭)?(?:敲|打|拍|击|落|下|洒|飘|淋|密|急|大|不停|纷纷|滂沱|淅|沥|哗|如注|倾盆)|淅淅沥沥|淅沥|哗啦|雨声|雨打|雨敲|雨幕|雨帘|雨中|冒雨|淋雨|雨势|雨下个不停|雨越下越大/;
  // 停雨：先下雨后停雨，以后面的「停」为准；覆盖「雨早就停了」等雨与停分开的写法。
  var RAIN_STOP_RE = /雨(?:早就|早已|已经|已|渐|刚|才|方|忽|骤|便|就)?[停住歇]|停雨|雨霁|雨收|初霁|云收雨歇|放晴|天晴|转晴|雨势渐歇|不再下雨|雨过天晴/;
  // 雨停 / 否定 / 回忆 / 未来 / 假设 / 传闻 / 战后 / 期盼 ——不下雨。
  var RAIN_EXCLUDE_RE = /雨停|雨住|雨歇|雨过|停雨|雨霁|放晴|天晴|雨收|初霁|没有雨|没雨|无雨|未雨|不下雨|没下雨|没有下雨|并未下雨|不曾下雨|不见雨|毫无雨|无半点雨|回忆|想起|记得|忆起|曾|昔日|往日|从前|当年|那年|以前|过去|旧时|明天|明日|明儿|来日|改日|翌日|将来|将要|即将|要下|快下|预报|预计|恐怕要|或许要|可能要|说不定|万一|如果|要是|假如|倘若|一旦|假设|会不会|打算|准备|计划|盼雨|求雨|等雨|听说|据说|传闻|据传|闻言|有人说|相传|传言|战后|停战|战罢|事后|后来|之后/;
  var SILENCE_RE = /万籁俱寂|一片寂静|寂静无声|悄无声息|鸦雀无声|四下无声|寂然无声|无声无息|没有一丝声|不闻一点声|静谧无声/;

  // 引用台词（「…」/“…”/‘…’/"…"）不参与下雨 / 交战判定。
  function stripQuotes(text) {
    return String(text == null ? '' : text)
      .replace(/「[^」]*」/g, '')
      .replace(/『[^』]*』/g, '')
      .replace(/“[^”]*”/g, '')
      .replace(/"[^"]*"/g, '')
      .replace(/'[^']*'/g, '');
  }

  // 句子范围保留逗号：只在句末标点 / 换行切句，逗号、顿号、分号都留在句内，
  // 让「明天，雨水…」「雨停了，田里还留着雨水」里未来 / 否定 / 停止词的约束覆盖整句。
  function splitSentences(text) {
    return String(text).split(/[。！？!?\n\r]+/);
  }

  // 现实「正在下雨」：逐句判定，后面的状态覆盖前面；只认明确雨事件、排除停雨 / 未来 /
  // 回忆 / 否定 / 假设 / 传闻 / 引用台词，雨伞 / 雨水等名词不算；不确定沿用安静默认。
  function rainNow(text) {
    var sentences = splitSentences(stripQuotes(text));
    var raining = false;
    for (var i = 0; i < sentences.length; i++) {
      // 等雨停/等雨势缓，不代表雨已经停或尚未下；保留前文的现实天气证据。
      // 只去掉这类等待表达，句子内其他明确的下雨/停雨描述仍照常判定。
      var c = sentences[i]
        .replace(/(?:等候|等待|等到|待到|等|待)(?:这|那)?(?:场|阵)?雨(?:势|声)?(?:停|住|歇|小|缓|弱|过)(?:下来|一缓|一点|些|了)?(?:之后|以后|后)?/g, '')
        .replace(/(?:等待|等候|等着|等到|等)下雨/g, '');
      if (!c) continue;
      if (RAIN_STOP_RE.test(c) || RAIN_EXCLUDE_RE.test(c)) { raining = false; continue; }
      if (RAIN_EVENT_RE.test(c)) raining = true;
    }
    return raining;
  }

  function explicitSilence(text) {
    return SILENCE_RE.test(stripQuotes(text));
  }

  // 室内 / 未知时，正文确实写「雨打窗 / 雨敲瓦 / 窗外下雨」等可听见雨才启 rain。
  function rainAudibleIndoors(text) {
    var clean = stripQuotes(text);
    return RAIN_WORD_RE.test(clean)
      && /(雨打|雨敲|雨拍|雨击|雨落|雨点[^。]{0,3}[窗瓦檐]|窗外[^。]{0,10}雨|雨[^。]{0,6}[窗瓦檐]|雨声|檐下|瓦上|屋顶|屋檐|听[^。]{0,4}雨)/.test(clean);
  }

  function occurredCombat(action) {
    if (typeof action !== 'string' || !action) return false;
    var clean = stripQuotes(action);
    if (!COMBAT_RE.test(clean)) return false;
    if (NONREAL_RE.test(clean)) return false;
    return true;
  }

  function firstString() {
    for (var i = 0; i < arguments.length; i++) {
      if (typeof arguments[i] === 'string' && arguments[i]) return arguments[i];
    }
    return '';
  }

  // 雨声只认 opts.narration（或最近正文 state.recent[*].narration），不读其它字段。
  function narrationText(state, opts) {
    if (typeof opts.narration === 'string' && opts.narration) return opts.narration;
    var rec = state && Array.isArray(state.recent) ? state.recent : [];
    for (var i = rec.length - 1; i >= 0; i--) {
      var r = rec[i];
      if (r && typeof r.narration === 'string' && r.narration) return r.narration;
    }
    return '';
  }

  function classifyTheme(state) {
    var genre = firstString(state.genre, state.bible && state.bible.genre);
    var title = firstString(state.bible && state.bible.title, state.title);
    if (genre === 'xuanhuan' || title === '外门杂役录') return 'lingtian';
    if (genre === 'urban' || genre === 'game' || genre === 'horror' ||
        genre === 'cozy' || genre === 'general') return genre;
    return 'general'; // 缺失 / 未知 / 识别中：所有世界都有配乐，按通用处理
  }

  function resolveLocation(state, opts) {
    var scene = (opts && opts.scene && typeof opts.scene === 'object') ? opts.scene : {};
    var loc = firstString(
      state.location,
      scene.place,
      state.bible && state.bible.start && state.bible.start.place
    );
    return loc.trim();
  }

  function classifyBackground(loc) {
    if (!loc) return 'neutral';
    // 「屋外/阁外/院外…」明确在室外：此时只有明确田地才 field，不把「外」本身画成农田。
    if (OUTDOOR_RE.test(loc)) return FIELD_RE.test(loc) ? 'field' : 'neutral';
    if (INDOOR_RE.test(loc)) return 'neutral';   // 真正屋内优先 neutral
    if (FIELD_RE.test(loc)) return 'field';
    return 'neutral';                            // 未知 / 野地 neutral
  }

  function classifyPeriod(state) {
    var c = state && state.clock && typeof state.clock === 'object' ? state.clock : {};
    var p = firstString(c.period, state && state.period);
    return PERIOD_MAP[p] || 'day'; // 未知 day
  }

  function classifyMood(state, opts) {
    var prefs = normalizePrefs(opts && opts.prefs);
    var mode = (opts && typeof opts.mode === 'string' && hasOwn(MODES, opts.mode))
      ? opts.mode : prefs.mode;
    if (mode !== 'auto') return mode; // 人工 mode 优先

    // 私下意图优先：仅 social/private/rest/intimate 一律 calm；
    // 后台事件（omen / 导演倒计时 / apex / 隐藏 NPC 意图 / 未发生事件）绝不顶成 tense。
    // continuing 只用于顺延定时世界事件：不覆盖当前 action 的真实交战，也不把继续探索压成 calm。
    var focus = firstString(opts && opts.focus, state && state.focus);
    if (hasOwn(QUIET_FOCUS, focus)) return 'calm';

    // 真实公开危险：只认明确 state.danger（玩家伤势）或 opts.scene.action 里已发生的交战。
    var scene = (opts && opts.scene && typeof opts.scene === 'object') ? opts.scene : {};
    if (state.danger === true || occurredCombat(scene.action)) return 'tense';

    if (focus === 'travel' || focus === 'explore') return 'explore';
    return 'calm';
  }

  function resolveAmbience(state, opts, background, period) {
    var text = narrationText(state, opts);
    if (explicitSilence(text)) return [];            // 明确无声则 []
    var rain = rainNow(text);
    var out = [];
    if (background === 'field') {
      out.push('wind');                              // 田野平常 wind
      if (period === 'night') out.push('insects');   // 夜晚可加 insects（绝不在屋里播）
    }
    if (rain && (background === 'field' || rainAudibleIndoors(text))) out.push('rain');
    // 音频 contract 最多 2 个环境声：雨天优先 rain、停虫鸣，绝不把真正的雨挤掉；结果始终 <=2。
    if (out.length > 2) out = out.filter(function (a) { return a !== 'insects'; });
    return out.slice(0, 2);
  }

  // 纯函数：只读输入、每次返回全新 DTO、不修改 state/opts、无随机 / 时钟 / 网络 / 文件 / 模型。
  function resolve(state, opts) {
    var s = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
    var o = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts : {};
    var loc = resolveLocation(s, o);
    var background = classifyBackground(loc);
    var period = classifyPeriod(s);
    var mood = classifyMood(s, o);
    var ambience = resolveAmbience(s, o, background, period);
    return {
      worldId: firstString(s.id, s.worldId) || null,
      theme: classifyTheme(s),
      background: background,
      period: period,
      mood: mood,
      ambience: ambience,
      location: loc || null,
    };
  }

  return {
    normalizePrefs: normalizePrefs,
    resolve: resolve,
    resolveReading: resolveReading,
    DEFAULT_ATMOSPHERE: DEFAULT_ATMOSPHERE,
  };
});
