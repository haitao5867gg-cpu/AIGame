'use strict';

// 第 4 节：纯函数规则引擎。
// 全部导出函数都不修改入参、不读写文件、不联网；随机数经 opts.rng 注入，
// 时间经 opts.now 注入（默认 Date.now()），便于确定性测试。
// 引擎不调用 LLM：事件标题/描述、新 apex、编年史摘要由编排层组装 prompt 后
// 通过 input 回传，引擎只负责检测、发信号（needEvent / needNewApex / needChapter）并写入状态。

const ATTRS = Object.freeze(['体魄', '心智', '魅力', '气运', '声望', '资源']);
const PERSONA_DIMS = Object.freeze(['冒险', '审慎', '共情', '权谋', '坚韧', '秩序']);

const ATTR_MIN = 0;
const ATTR_MAX = 40;
const ATTR_INIT = 5;
const ATTR_EXTRA_TOTAL = 6;
const ATTR_EXTRA_MAX = 3;

const NPC_MIN = -10;
const NPC_MAX = 10;
const NPC_DIFF_MAX = 2;

const DIFF_MIN = -2;
const DIFF_MAX = 1; // 普通回合单项正向最多 +1（负向仍以 DIFF_MIN=-2 为界）
const DIFF_POSITIVE_TOTAL_MAX = 2; // 普通回合正向总预算；事件结算不受此限

// 时光推进：一回合跳过一段较长时间，复用现有回合流程（不新开接口 / 事件类型）。
const TIME_SKIP_SPANS = Object.freeze({
  month: Object.freeze({ days: 30, label: '一个月' }),
  season: Object.freeze({ days: 90, label: '三个月' }),
  half: Object.freeze({ days: 180, label: '半年' }),
  year: Object.freeze({ days: 365, label: '一年' }),
});
const TIME_SKIP_PLAN_MAX = 200;
const TIME_SKIP_DIFF_MAX = 3;             // 时光推进单项正向上限（跳一个月除外）
const TIME_SKIP_DIFF_MIN = -3;            // 时光推进单项负向下限
const TIME_SKIP_POSITIVE_TOTAL_MAX = 5;   // 时光推进正向总预算（跳一个月除外）

// 通用事件主题：建世界 eventThemes 少于 4 个时补齐；引擎开启事件时主题为空也用它兜底。
const GENERIC_EVENT_THEMES = Object.freeze(
  ['天灾', '瘟疫', '战乱', '权力更迭', '神秘来客', '资源枯竭'],
);

// 导演机制：当玩家在同一场景/谈判里绕圈，或距上次转折太久，强制本回合出现明显转折。
// 转折词只进回合 prompt 与 events.jsonl，绝不写进公开状态（见 toPublicState / toPublicTurnResult）。
const TWISTS = Object.freeze(
  ['闯入者', '意外发现', '背叛', '环境突变', '旧识出现', '时机错过', '交易反转'],
);
const TWIST_STREAK_THRESHOLD = 4; // sceneStreak 达到该值即触发转折
const TWIST_GAP_MIN = 9;         // 距上次转折的随机间隔下界（含）
const TWIST_GAP_SPAN = 6;        // 9~14：TWIST_GAP_MIN + floor(unit(rng) * TWIST_GAP_SPAN)

// 内部拒绝原因标记：记入 rejected 供内部日志，但不出现在公开回合结果里（不给玩家看）。
const INTERNAL_REJECT_TAG = '[internal]';

const ITEMS_ADD_MAX = 2;
const ITEM_NAME_MAX = 12;
// 随身物品介绍：desc 去空白截 60 字，type 截 6 字（可选）。
const ITEM_INFO_DESC_MAX = 60;
const ITEM_INFO_TYPE_MAX = 6;
const NARRATION_MIN = 10;
const NARRATION_MAX = 1200;
const RECENT_MAX = 6;
// recent 每条保留引擎已接纳的完整正文，上限直接与 NARRATION_MAX 绑定，
// 避免「叙事 1200 / recent 只留 300」两处上限各自漂移、再次截断尾部正文。
const RECENT_NARRATION_MAX = NARRATION_MAX;
const CHRONICLE_MAX = 300;
const PERSONA_INIT = 50;
const PERSONA_REGRESSION = 0.2;

// 风声预兆：距离下一次事件 1~2 回合且无进行中事件时，叙事里要埋下不祥征兆。
const OMEN_MIN_GAP = 1;
const OMEN_MAX_GAP = 2;

// 坊间传闻：单条 ≤40 字，state 只留最近 10 条。
const RUMOR_MAX = 40;
const RUMORS_MAX = 10;

// 场景插图 desc 上限：引擎消毒时去首尾空白、截到 60 字（模型建议 ≤40 字）。
const SCENE_DESC_MAX = 60;

// 场景插图新字段：地点 ≤12 字；在场人物 / 物品名每条 ≤12 字，cast 最多 3、items 最多 2；动作 ≤60 字。
const SCENE_PLACE_MAX = 12;
const SCENE_NAME_MAX = 12;
const SCENE_CAST_MAX = 3;
const SCENE_ITEMS_MAX = 2;
const SCENE_ACTION_MAX = 60;

// 事实账本：本回合新确立的客观事实，[{turn,text}]；单条 ≤30 字，每回合 0~2 条，最多 40 条（丢最旧）。
const FACT_TEXT_MAX = 30;
const FACTS_MAX = 40;
const FACTS_PER_TURN_MAX = 2;

// 印记：落在角色身上的持久处境（被盯上、欠人情、负伤…），单条 ≤16 字，最多 8 条；重生时清空。
const MARK_TEXT_MAX = 16;
const MARKS_MAX = 8;

// 未解之谜：state.threads 最多 6 条活跃，超出时最旧的移入 state.fadedThreads；
// 单条 ≤20 字，解开时文本必须与已有完全一致。fadedThreads 也设上限，避免无限增长。
const THREAD_TEXT_MAX = 20;
const THREADS_MAX = 6;
// 叙事 v3（storyMode）：伏笔账本同时活跃最多 5 条，满了拒收新线索、不再自动淡去最旧的。
const STORY_THREADS_MAX = 5;
// 叙事 v3 正文 700~1200 字，深度模式偶尔更长；storyMode 下截断上限放宽到 1800。
const STORY_NARRATION_MAX = 1800;
const FADED_THREADS_MAX = 20;

// 地点与时间：时段依次循环，深夜之后进入次日清晨；单回合推进 0~2 个时段。
const PERIODS = Object.freeze(['清晨', '午后', '黄昏', '深夜']);
const MOVE_TO_MAX = 12;
const TIME_PASSES_MIN = 0;
const TIME_PASSES_MAX = 2;
const TIME_PASSES_DEFAULT = 1;

// 世界专属状态（state.stats）：每回合由 AI 提议增减、随时间自然变化，跌破警戒线有后果。
const STATS_MAX = 4;                // 每个世界最多保留的专属状态数
const STATS_GAUGE_DIFF = 30;        // gauge 单回合变化上限（普通回合）
const STATS_RANK_DIFF = 1;          // rank 单回合变化上限（普通回合）
const STATS_SKIP_GAUGE_DIFF = 100;  // gauge 单回合变化上限（时光推进放宽）
const STATS_SKIP_RANK_DIFF = 2;     // rank 单回合变化上限（时光推进放宽）

// 前世墓志铭：单段 ≤80 字。
const EPITAPH_MAX = 80;

// 濒死阈值：体魄 ≤ 该值即「伤势沉重」，公开状态置 danger:true。
// 与 prompts.js 的回合叙事判定保持一致（那里用字面量 2 并有注释互指）。
const DANGER_THRESHOLD = 2;

// 老存档兼容：NPC 缺 voice 时按序补一组彼此不同的默认口吻（每条 ≤20 字）。
// 只给缺字段的补，已有 voice 的世界原样保留（幂等）。
const DEFAULT_VOICES = Object.freeze([
  '短句铁令，从不解释',
  '哄劝式隐喻，句句带笑',
  '记账式冷语，只报数目',
  '慢条斯理，先问再答',
  '粗声打断，只讲结论',
  '低声耳语，话留半句',
]);

module.exports = {
  ATTRS,
  PERSONA_DIMS,
  ATTR_MIN,
  ATTR_MAX,
  ATTR_INIT,
  ATTR_EXTRA_TOTAL,
  ATTR_EXTRA_MAX,
  NPC_MIN,
  NPC_MAX,
  NPC_DIFF_MAX,
  DIFF_MIN,
  DIFF_MAX,
  DIFF_POSITIVE_TOTAL_MAX,
  TIME_SKIP_SPANS,
  TIME_SKIP_PLAN_MAX,
  TIME_SKIP_DIFF_MAX,
  TIME_SKIP_DIFF_MIN,
  TIME_SKIP_POSITIVE_TOTAL_MAX,
  GENERIC_EVENT_THEMES,
  TWISTS,
  TWIST_STREAK_THRESHOLD,
  TWIST_GAP_MIN,
  TWIST_GAP_SPAN,
  INTERNAL_REJECT_TAG,
  ITEMS_ADD_MAX,
  ITEM_NAME_MAX,
  ITEM_INFO_DESC_MAX,
  ITEM_INFO_TYPE_MAX,
  NARRATION_MIN,
  NARRATION_MAX,
  RECENT_MAX,
  RECENT_NARRATION_MAX,
  CHRONICLE_MAX,
  PERSONA_INIT,
  PERSONA_REGRESSION,
  OMEN_MIN_GAP,
  OMEN_MAX_GAP,
  RUMOR_MAX,
  RUMORS_MAX,
  SCENE_DESC_MAX,
  SCENE_PLACE_MAX,
  SCENE_NAME_MAX,
  SCENE_CAST_MAX,
  SCENE_ITEMS_MAX,
  SCENE_ACTION_MAX,
  FACT_TEXT_MAX,
  FACTS_MAX,
  FACTS_PER_TURN_MAX,
  MARK_TEXT_MAX,
  MARKS_MAX,
  THREAD_TEXT_MAX,
  THREADS_MAX,
  STORY_THREADS_MAX,
  STORY_NARRATION_MAX,
  FADED_THREADS_MAX,
  PERIODS,
  MOVE_TO_MAX,
  TIME_PASSES_MIN,
  TIME_PASSES_MAX,
  TIME_PASSES_DEFAULT,
  STATS_MAX,
  STATS_GAUGE_DIFF,
  STATS_RANK_DIFF,
  STATS_SKIP_GAUGE_DIFF,
  STATS_SKIP_RANK_DIFF,
  EPITAPH_MAX,
  DANGER_THRESHOLD,
  DEFAULT_VOICES,
};
