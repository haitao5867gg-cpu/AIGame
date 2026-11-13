'use strict';

const env = require('./env.js');
const { GENRE_STYLES, STORY_STYLES, OUTLINE_NOTES, SUGGEST_NOTES, normalizeGenre } = require('./genres.js');
// buildProfileMessages 要用 publicProfile 把六维 ema 归一成 0..100 的倾向数字。
// profiles.js 只依赖 store / engine 常量，不与本模块形成循环依赖。
const profiles = require('./profiles.js');
// npcs.js 是纯数据层（只依赖 crypto + event-log），不 require 任何 engine/* 模块，
// 因此这里 require 它取有界的 npcPromptContext 不会与提示词 / 引擎产生循环依赖。
// 命名成 npcModule：buildTurnMessages / worldBibleText 内部另有局部变量 npcs（bible 的 NPC 数组），
// 避免遮蔽这里的模块引用。
const npcModule = require('./npcs.js');

// 第 5 节：所有 prompt 模板 + JSON 解析。
// 只组装字符串 / 消息数组，是纯函数：不联网、不读写文件、不调用引擎。
// 回合 prompt 恒定由「宪法 + 锁定 bible + 当前状态 + 最近 2 章 + 最近 6 回合 + 条件片段」组成，
// 近期记录恒定为最近 6 回合、每条正文最多 NARRATION_MAX=1200 字（合计上限 6×1200 字），
// 故不随回合数增长；单条正文上限由旧 300 字提到 1200 字，整段量级约 6K token（随 tokenizer 浮动）。

function section(title, body) {
  return `【${title}】\n${body}`;
}

// 把字符串数组排成无序列表；忽略空项。用于把动态状态（事实 / 印记 / 线索）列进 prompt。
function bulletList(items) {
  return (Array.isArray(items) ? items : [])
    .filter((x) => typeof x === 'string' && x.trim())
    .map((x) => `- ${x.trim()}`)
    .join('\n');
}

// 与 engine.DANGER_THRESHOLD 保持一致：体魄 ≤ 2 即濒死（回合叙事必须写出伤势）。
const DANGER_BODY = 2;

// 越界后果的固定形式：第 3 次起按累计次数轮换，保证「每次后果形式不同」。
const OVERSTEP_FORMS = Object.freeze(['被驱逐', '被拘押', '关键 NPC 断交', '受伤']);

// 越界升级阶梯：把累计次数（state.oversteps）与本次该用的后果写成给模型的指令。
// 纯函数，单独导出便于单测；oversteps 为「截至上回合」的累计次数，本次即第 oversteps+1 次。
function overstepDirective(oversteps) {
  const n = Number.isInteger(oversteps) && oversteps >= 0 ? oversteps : 0;
  const next = n + 1;
  let tier;
  if (next === 1) {
    tier = '第 1 次：必须留下印记（marks_add，如「被登进疯人名册」「被卫兵记了脸」「被当成疯子」），' +
      '并让世界当场把这桩妄为记成一笔账；明确驳回，但绝不只是冷遇或口头警告、绝不零成本放过。';
  } else if (next === 2) {
    tier = '第 2 次：声望 -1（state_diff）且有实质后果（被逐出当场 / 被短暂拘押 / 关键线索被旁人先拿走 / 关键 NPC 拒再交底），' +
      '另留一枚新印记；后果必须比第 1 次更重，并明确援引第 1 次留下的那枚印记。';
  } else {
    const form = OVERSTEP_FORMS[(next - 3) % OVERSTEP_FORMS.length];
    tier = `第 3 次起：严重后果，本次固定采用「${form}」，写成叙事里真实发生、改变处境的事；` +
      '不得退回冷遇、只记一笔或前两次用过的处置，每次后果形式都不得与前几次重复。';
  }
  // 已用后果形式（第 3 次起按累计次数轮换），供模型明确回避重复。
  const used = [];
  for (let i = 3; i <= n; i++) used.push(OVERSTEP_FORMS[(i - 3) % OVERSTEP_FORMS.length]);
  const repeatRule = [
    '同一种越界请求（同样的封王 / 同样的神力 / 同样不存在的宝物 / 同样的强闯）不得得到相同处理：',
    '若玩家重复提出之前做过的越界请求，必须在叙事里点明「这已是第几次」、援引上次留下的印记或后果，',
    '并把处置升级到更高一档；同一种请求每次的后果形式都不得相同，也不得淡化、改述或抹掉之前的惩罚。',
    used.length ? `此前已用过的严重后果形式：${used.join('、')}；本次不得重复其中任何一种。` : '',
  ].filter(Boolean).join('\n');
  return [
    `玩家迄今已越界 ${n} 次；若本回合判定为越界，即为第 ${next} 次。`,
    '越界指：声称不存在的能力或物品、要求直接成为统治者、无理强闯禁地、对 NPC 动粗等。',
    '升级阶梯：第 1 次必须留下印记；第 2 次声望 -1 且有实质后果；第 3 次起必须是严重后果且每次形式不同。',
    `本次应采用：${tier}`,
    repeatRule,
    '越界后果一律以本段阶梯为准。若本回合越界，在输出 JSON 里写 "overstep":true 并按上述阶梯写出对应后果；否则省略该字段或写 false。',
  ].join('\n');
}

const CONSTITUTION = [
  '你是「无限世界」的叙事引擎，只负责写第二人称叙事与提议状态变化。',
  '铁律：',
  '- 只输出一个 JSON 对象，不要任何解释、前后缀或 Markdown 文字。',
  '- 用第二人称「你」叙述，永远不替玩家做决定、不替玩家说话。',
  '- 不改写、不新增、不否定下面锁定的世界设定（bible）。',
  '- 世界没有主线也没有结局，永不结束；不要写「终章」「完结」。',
  '- 不要说破、点名或解释任何隐藏目标；隐藏线索只能通过传闻、机会、NPC 态度隐晦暗示。',
  '- 你的状态变化只是「提议」，真正的数值由后端引擎裁定，可能与你提议的不同，叙事不要依赖数值一定生效。',
].join('\n');

// 场景连贯（首次出场 / 续写）通用规则：单一来源，只注入【叙事与状态规则】一次，
// 覆盖所有回合与 v1/v2/v2-3p；第一幕只保留「衔接序章」独有职责，不在此重复同义要求。
// 核心：后台设定 ≠ 读者看过的正文；重要新物件 / 地标要先从玩家当前视角在场景里落位，
// 交代可见位置、形态或合理可知的作用，再用「它下面 / 它旁边」承载人物动作。
const SCENE_COHERENCE_LINES = [
  '- 后台设定（锁定的世界设定里的内容）不等于玩家已经被告知，也不能当成读者已经看过的正文：' +
  '新出现、且影响玩家理解当前行动 / 所处空间 / 线索的人物、地标、物件，第一次写进叙事时，' +
  '要先从玩家当前视角在场景里落位，交代它可见的位置、形态或合理可知的作用（通常半句到一句），' +
  '之后才用「它下面 / 它旁边」这类方位短语承载人物动作；' +
  '只把地标塞进「[某物] 旁 / [某物] 下」的复合短语里当修饰语（[ ] 为占位符，换成本世界自己的物件，不要让所有世界照搬同一个例子物件），' +
  '不算完成首次交代。身份与动机可以留住悬念不说破，但基本的空间关系（谁在哪、和眼前处境什么关系）不能缺失；' +
  '普通名词不必逐一解释，也不要把已介绍过的设定整段复述一遍。',
  '- 续回合默认承接上一回合末尾的现场、动作、对话往下写，不把没交代完的场面凭空丢开；可以合理补进新细节，' +
  '但不能把本回合才出现、还没向玩家交代过的新细节写成玩家早就熟悉的旧事；' +
  '以玩家为准：玩家本回合另有新行动就按新行动写，不因承接而强行改写玩家的选择，也不强行转场、推进线索或塞进新事件。',
];

// 落笔前短提醒：注入每条回合 user 消息末尾（紧邻「玩家本回合的行动 / 请据此写出」），
// 把核心约束从约 1 万字符的 system 提到模型临近落笔处。只复述核心、不堆规则，
// 完整条款以【叙事与状态规则】里的 SCENE_COHERENCE_LINES 为单一来源，这里用短提醒引用。
const SCENE_COHERENCE_REMINDER = [
  '写本回合正文前，先对照这条（完整规则见【叙事与状态规则】的首次出场 / 续写条款）：',
  '- 后台设定不等于读者看过的正文：重要新物件 / 地标先从玩家当前视角在场景里落位，' +
  '交代可见位置、形态或可知作用，再用「它下面 / 它旁边」承载人物动作；' +
  '只把地标塞进「X 旁 / X 下」的复合短语不算完成首次交代。身份与动机可留住悬念，基本空间关系不能缺。',
  '- 续写以玩家为准（本回合的新行动）；普通名词不必逐个解释、不整段复述设定、不强行转场或推进线索 / 新事件。',
  '- 「刚才」「那条」「你记得」「你没听漏」「之前说的」这类回指，只能指向前文里真正写过的内容；设定和事实账本里正文还没写过的东西，第一次出现时要交代主角是怎么得知的。',
].join('\n');

// 第一幕专属：与「当前地点的环境背景（玩家尚未读过）」片段配套的首幕落位指令。
// 仅在 state.turn===0 且确实匹配到当前地点 desc 时，随片段一起注入 user 消息（临近行动 / 输出处）。
// desc 是写作背景、不是玩家已知正文：先从人物当前视角把与行动相关的地标 / 物件在场景里落位，
// 再立即回应玩家行动；不强制观察 / 转场 / 作决定、不塞新事件，后续回合沿用通用规则、不重讲环境。
const FIRST_ACT_ENV_INSTRUCTION = [
  '上面这段是写作背景，不是玩家读过或已经知道的正文：按当前时间、人物所处视角选取其中合理可见 / 可听的内容，',
  '其中若含尚未发现的秘密或当下看不见的信息，不得当作玩家已知直接写出来。',
  '正文开头先用 1~2 句，自然呈现眼前场景里、且与本回合行动相关的重要地标 / 物件，',
  '让读者看清它放在哪里、是什么可见形态、或有什么合理就可知的用途，然后立即回应玩家本回合的行动；',
  '不要只把物件埋进「X 旁 / X 下」这类 NPC 动作的修饰语里，也不要照抄整段设定、或给每个普通名词都作解释。',
  '这只是第一幕把眼前场景落位，不替玩家增加观察、转场、作决定的动作，不塞入新事件；后续回合沿用通用规则，不必重讲环境。',
].join('\n');

// 回合叙事与状态规则：约束真模型「每回合 +1」「越界冷处理」「原地打转」「NPC 复读机」等失衡行为。
const TURN_RULES = [
  '叙事与状态规则（务必遵守）：',
  '- 大多数回合不要改属性：只有玩家本回合的行动带来实质成长或损失时才给 state_diff；平淡回合宁可不给，也不要每回合固定 +1。',
  '- 玩家越界时（声称拥有不存在的神力/宝物、要求直接称王封王、强闯禁地、对 NPC 动粗），世界必须给出具体、可见的后果：',
  '  第 1 次就必须留下印记（marks_add，如被登记、被当成疯子、被记了脸），绝不能只是冷处理或口头警告；',
  '  相关 NPC 态度下降、声望 -1、被势力盯上/记档、被驱逐或触发守卫禁制等，写成叙事里真实发生的事，',
  '  不能无人接话或轻描淡写带过；重复同一种越界请求时，处置必须逐次升级、不得与上次相同。',
  '- 安全选择也有代价：玩家退让 / 观望 / 回避时同样要有代价或错失（NPC 信任下降、机会溜走、线索被别人拿走），',
  '  不能零成本避险，详见【安全选项的代价】；此规则不适用于玩家主动选择的私密、社交、休息、亲密场景。',
  '- 玩家意图优先：本回合必须执行玩家声明的行动并写出结果；结果只能因为世界内的合理性或 NPC 自己的性格与立场而部分成功或失败，' +
  '不能用与玩家行动无关的外部事件（突然来电、来人、警报、公告、意外消息等）打断。' +
  '玩家主动停留在同一场景、继续同一件事是正当选择，不算拖沓，不要强行转场。',
  // 场景连贯：首次出场 / 续写通用规则，单一来源见 SCENE_COHERENCE_LINES（覆盖所有写法与回合）。
  ...SCENE_COHERENCE_LINES,
  '- 每个 NPC 都有自己的欲望与立场（见世界设定里的「想要」），对同一件事的反应要有差异、会主动趋利避害，',
  '  不能只轮流充当信息出口或沉默旁观。',
  '- 已确立的事实（见【已确立的事实】）是客观真理，叙事必须遵守，不得与之矛盾、改写或重新解释；',
  '  本回合若新确立了客观事实（时间/地点规则、人物身份、已发生且不可更改之事），用 new_facts 记录（0~2 条，每条 ≤30 字）。',
  '- 身上的印记（见【身上的印记】）必须持续产生后果：被盯上就被监视盘查、欠人情就被讨还、带伤就行动受限、被记档就寸步难行；',
  '  不要这一回合写过、下一回合就当没发生。玩家每次越界（宣称不存在的神力/宝物、动粗、强闯、冒犯势力）都要用 marks_add 留下一枚新印记；',
  '  印记已了结时用 marks_remove 移除（文本须与已有完全一致）。',
  '- 未解之谜（见【未解之谜】）：玩家主动接触相关人物或地点时再推进；玩家不理会时，线索可以作为背景传闻出现一次，但不要每回合重复，主线等玩家。',
  '  不能只埋不收，也不要让同一条线索反复原地打转；已淡去/已解开的线索不要再重新埋设。',
  '- 不要重复最近回合已用过的意象、环境描写和 NPC 小动作（擦杯、停手、正花、推牌、压低声音、沉默打量等），',
  '  每回合换新的细节；也不要把同一条线索反复「重新发现一次」，或把同一个「欠一笔/别问」话术换个 NPC 再说一遍。',
  '- 每段叙事结尾必须停在一个需要玩家决断的具体局面：有人等你回话、两条路只能选一条、手里的东西要不要交出去、',
  '  要不要当场相信某个人；不要替玩家作决定，也不要用总结、抒情或「你陷入沉思」收尾，别让玩家只是被动听完一段对话。',
  '- 叙事分段：把本回合叙事写成 2~4 个短段落，每段 1~3 句、不超过 90 字；人物对白（含引号台词）单独成段；',
  '  段落之间用一个空行分隔（JSON 字符串里写作 \\n\\n），不要写成一整段长文字到底。',
  '- suggestions 必须给 3 条方向明显不同的行动：一条大胆冒险、一条谨慎稳妥、一条借人/用计',
  '  （拉拢、交易、设局、借某人的立场），不要三条都只是「继续打听」的不同说法。',
].join('\n');

// ---- 叙事写法 v2（对比实验用）----
// 由 v1 文本派生：只替换/新增下列规则行，其余行原样保留；v1 常量本身绝不改动，
// 因此默认（v1）输出与改动前完全一致。NL 用字符码表示换行，避免在此写转义序列。
const NL = String.fromCharCode(10);
const V2_DECISION_LINES = [
  '- 整回合的结尾要留一个钩子：停在一个悬念、一句没说完的话、一个刚露出的异常上，让人想知道下一步；',
  '  不必每回合都给玩家出选择题，中间的段落按故事需要自然推进，不要用总结、抒情或「你陷入沉思」收尾。',
];
const V2_SEGMENT_LINES = [
  '- 段落短、段数多：一段只写一个动作、一个念头或一句对白，通常 20~70 字；关键场景（初见、冲突、亲密、揭秘、事件开始或结算）8~20 段、600~1200 字，过场 3~6 段、150~300 字。',
  '【写作手法】',
  '- 每回合写成一场完整的小戏：玩家想做的事 → 遇到的阻碍或意外 → 主角的尝试与应对 → 有分量的结果；结果常常先挫后扬或先扬后挫，不要平铺直叙地交代发生了什么。',
  '- 用具体、有生活气的细节立住人和情感（递过来的半块饼、用袖子擦干净的凳子），少用「五味杂陈」「气氛凝重」这类概括。',
  '- 写主角的身体感受和五感：疼、冷、饿、气味、心跳、手心出汗。',
  '- 主角会观察、推算、试探：世界里有能摸清的规律（多久出现一次、谁在什么时候来、哪里不对劲），玩家动脑就能占到便宜。',
  '- 信息一点点放：先看到异常，再猜错，再发现真相的一角，不要一次说清谜底。',
  '- 情绪有起伏：受挫、被轻视、被逼到墙角之后，给一次靠自己挣来的小胜；势利的人前倨后恭、看不起主角的人终会被打脸，但要合情合理、来得不轻易。',
  '- 配角有自己的心思和反差：嘴上刻薄的人暗中帮一把，热情的人别有所图；用一句话、一个小动作露出来，不说破。',
  '- 偶尔一两句主角的心里话或自言自语，短，带情绪。',
  '- 语言朴素有劲：动词为主，少堆形容词，不卖弄辞藻；对白口语化、符合身份；不同世界观用各自的腔调。',
  '- 成长看得见：本事、修为、名声、关系的变化要有具体体现。',
  '- 结尾留钩子：旁人察觉了不该察觉的事、一句带敌意或暗示的话、刚到手的东西显出异样、远处传来的动静。钩子是悬念，不是选择题；不能抵消玩家这一回合想做成的事；私下、亲密场景里钩子只用内心念头或一个细节，不用外部打断。不要用总结或抒情收尾。',
];
const V2_TURN_RULES = TURN_RULES.split(NL).flatMap((line) => {
  if (line.startsWith('- 每段叙事结尾必须停在一个需要玩家决断的具体局面')) return V2_DECISION_LINES;
  if (line.startsWith('  要不要当场相信某个人')) return [];
  if (line.startsWith('- 叙事分段：')) return V2_SEGMENT_LINES;
  return [line];
}).join(NL);

// 亲密关系规则：两档共用硬规则 + 按本回合成人模式选一档写法。
const INTIMACY_COMMON = [
  '成年角色之间你情我愿的亲密关系可以发生并完成，不要用外部事件逃避或打断；NPC 按自己的性格和意愿回应，可以在角色内拒绝或提条件。',
  '两档共同的硬规则（必须遵守）：只涉及明确是成年人的角色——未成年、孩童化或年龄不明的角色一律不进入任何性或亲密情节（年龄不明按关处理并转开）；',
  '必须你情我愿，不写强迫、胁迫、迷奸或任何非自愿内容；不涉及真实存在的人物。',
].join('\n');
const INTIMACY_ADULT_OFF = '成人模式未开启：用暗场或时间跳转含蓄带过，不写露骨的性描写与身体细节，然后从之后继续。';
const INTIMACY_ADULT_ON = '本世界已开启成人模式：允许把成年角色之间你情我愿的亲密情节具体写出来，不回避、不跳过。';

const TURN_OUTPUT_FORMAT = [
  '输出 JSON 格式（字段固定，数组可为空）：',
  '{"narration":"第二人称叙事，10~1200 字，分成 2~4 个短段落，段落间用 \\n\\n 分隔",',
  ' "state_diff":{"心智":1},',
  ' "stats_diff":{"饱腹":15},',
  ' "items_add":[],"items_remove":[],',
  ' "items_info":{"新物品名":{"desc":"…","type":"…"}},',
  ' "overstep":false,',
  ' "npc_attitude":{"某人":1},',
  ' "persona_tags":["冒险"],',
  ' "suggestions":["可选项一","可选项二","可选项三"],',
  ' "new_facts":["本回合新确立的客观事实，≤30 字（可选，0~2 条）"],',
  ' "marks_add":["本回合新留下的印记（可选）"],"marks_remove":["要移除的印记（可选）"],',
  ' "threads_add":["本回合新埋下的线索（可选，≤20 字）"],"threads_resolve":["要解开的已有线索（可选）"],',
  ' "rumor":"一句 ≤40 字的坊间传闻（可选）",',
  ' "move_to":"≤12 字的地点名（可选）",',
  ' "time_passes":1,',
  ' "scene":{"draw":false,"place":"地点（≤12 字）","cast":["在场人物的名字"],"items":["画面里用到的物品名"],"action":"≤40 字：谁在做什么、光线氛围"},',
  ' "event":{"title":"事件标题","desc":"事件描述"},',
  ' "event_check":{"attr":"体魄","response_quality":2},',
  ' "voice_hints":[{"para":0,"mood":"tense","pace":"normal","speaker":"小林"}],',
 ' "focus":"action|explore|travel|social|private|rest|intimate",',
 ' "continuing":false,',
 ' "npc_updates":[{"id":"已存在的稳定 id；新人物可省略","name":"某人","kind":"change","evidence":"本回合叙事里写到新衣着的原文短语（narration 连续子串）","known":{"traits":{"appearance":{"衣着":"新衣短语"}}}}],',
 ' "adult":false}',
 '说明：',
  '- suggestions 固定给 3 条方向明显不同的行动：一条大胆冒险、一条谨慎稳妥、一条借人/用计（拉拢、交易、设局）；',
  '  不要三条都在打听同一件事。',
  '- new_facts 记录本回合新确立的客观事实（≤30 字，0~2 条）：如「城门每日戌时落锁」「顾秋白是76号的人」；',
  '  已确立的事实见【已确立的事实】段落，叙事必须遵守、不得改写；没有新事实就省略该字段，不要复述旧事实。',
  '- stats_diff 的键必须是【专属状态】里已有的名字，数值槽单回合一般 -30~+30，等级阶梯只能 ±1，没有变化就省略。',
  '- marks_add / marks_remove 每条 ≤16 字：如「被76号盯上」「欠白玫一个人情」「左臂刀伤」；',
  '  越界行为必留印记（marks_add）；已了结的印记用 marks_remove 移除，文本必须与【身上的印记】里某一条完全一致。',
  '- threads_add 每条 ≤20 字，本回合新埋下的未解之谜；threads_resolve 解开已有线索，文本必须与【未解之谜】里某一条完全一致；',
  '  玩家主动接触相关人物或地点时再推进，玩家不理会时不要每回合重复；不能只埋不收。',
  '- rumor 是可选的坊间流言（≤40 字），约每三回合给一条即可，不要每回合都给；',
  '  内容可是对隐晦线索的侧面暗示、其他势力的风声，或真假难辨的闲话，写成听来的口吻。',
  '- move_to 是本回合去往的地点：必须是世界设定「地点」里已有的名字，或本回合叙事里新出现的地点名；',
  '  ≤12 字；没有移动就不要输出该字段。',
  '- time_passes 是本回合推进的时段数，只能是 0、1、2（默认 1）；0 表示几乎未流动，2 表示明显跨越时段。',
  '- 叙事必须与【时与地】给出的当前地点、第几日、时段一致；若给了 move_to，叙事里要真的到达该处。',
  '- scene.draw 只在关键回合为 true：换了地点、重要人物首次出场、打斗/追逐/危险、剧情转折、事件开始或结算、死亡，或特别值得一画的瞬间；平淡对话、打听、闲逛为 false。',
  '- cast 只写名字：主角写「你」，NPC 写设定里的原名（与【人物】里的名字完全一致），最多 3 个；items 只写物品栏里的原名，最多 2 个；action 只写动作、位置关系（谁在左、谁在右）和光线氛围，不要描写任何人的外貌、衣着、长相，也不要描写物品的外观（这些会由已有的人物图和物品图决定）。',
  '- persona_tags 只能从这 6 个词里取：冒险、审慎、共情、权谋、坚韧、秩序。',
  '  绝不要自造词（例如「谨慎」「水路」「冷静」等都不是合法值，会被引擎拒绝），只填本回合真正体现的维度。',
  '- 角色当前拥有的物品见【当前状态】的「物品」一行及【当前随身物品（物品栏必须与叙事同步）】。',
  '  玩家若声称使用自己没有的物品，narration 里必须写出「你摸遍全身也没有」之类的失败，',
  '  不得凭空让它出现，也不得把它写进 items_add；items_add 只能填本回合真实获得的新物品。',
  '- 物品栏必须与叙事同步：叙事里交出、丢失、用掉、被收走的物品，必须同时写进 items_remove；',
  '  只有真正得到新物品才写 items_add。已失去的物品不能再出现在角色身上，也不能在后续叙述里被重新使用。',
  '- items_add 里的每个新物品都要在 items_info 里给 1~2 句介绍和类型：',
  '  desc ≤60 字，说清它是什么、有什么用或特别之处、来历；type ≤6 字（法器/丹药/兵器/杂物/信物/文书…，可选）；',
  '  items_info 的键必须与 items_add 的物品名完全一致，不要给未加入物品栏的东西写介绍。',
  '- overstep 是可选布尔：玩家本回合行动属于越界（声称不存在的能力或物品、要求直接成为统治者、无理强闯禁地等）',
  '  时填 true，否则省略该字段或写 false；越界后果一律按【越界升级】给出的累计次数与阶梯处理，' +
  '  第 1 次也要留印记，重复同一种越界请求必须升级处置、不得与上次相同。',
  '- event 仅在「本回合需要开启事件」时出现，否则不要输出该字段。',
  '- event_check 仅在「本回合需要结算事件」时出现；response_quality 为 0~3 整数，据实评价玩家应对；',
  '  attr 只能是 体魄/心智/魅力/气运/声望/资源 之一。',
  '- narration 必须分成 2~4 个短段落：每段 1~3 句、≤90 字，人物对白单独成段；',
  '  段落之间用 \\n\\n 分隔（即一个空行，JSON 字符串里写作 \\n\\n），不要输出成没有分段的一整段长文字。',
  '- voice_hints 是可选的朗读提示，最多 8 条，按叙事段落从 0 开始编号（para）：',
  '  mood 只能是 calm/tense/sad/joyful/angry/mysterious 之一，pace 只能是 slow/normal/fast 之一；',
  '  缺省一律 calm/normal（不填或值非法时按缺省处理）。',
  '  speaker 只在该段是某个 NPC 的台词时填该 NPC 的设定原名（与【人物】里的名字完全一致），旁白段不填、留空或省略；',
  '  例：[{"para":0,"mood":"mysterious","pace":"slow"},{"para":2,"mood":"angry","speaker":"钟离"}]。',
  '- focus 是本回合玩家在做的事属于哪一类，只能取 action/explore/travel/social/private/rest/intimate：',
  '  private 指私下独处或密谈，intimate 指亲密；非法或缺省按 action。',
  '- continuing 是布尔：玩家本回合是不是在继续上一回合的同一件事；非法或缺省按 false。',
  '- adult 是布尔：本回合是否包含性或亲密的露骨内容；仅在规则允许且对象是明确成年人时填 true，否则 false。',
  '- narration 永远是输出的第一个字段：先自然写出完整正文，再写其他字段（流式按正文优先边生成边推）；' +
  '  npc_updates 只作补充，绝不挤到正文前面，也不为补档回头改写已经写好的正文。',
  '- npc_updates 必须随完整正文一并输出为数组：没有新资料 / 无需登记就给空数组 []；' +
  '  不强求每回合增资料 / 关系变化 / 人物成长；' +
  '  没有新变化绝不可为填数组编造变化、强推关系、打断玩家或改变 NPC 意愿。',
  '  正文写完后做一次资料核对：正文中若确实新披露了新人物、新外貌、稳定性格 / 能力 / 处境、' +
  '  已公开的目标或承诺关系，或某项明确变化，就把该人的原文短语摘到 known 对应字段，' +
  '  并给一段 narration 的连续子串作 evidence；原有未变项不必复述。' +
  '  新值无需硬凑长摘要，一对简单键值即可（如 traits.appearance 下的「疤痕：原文短语」）；' +
  '  不要把情绪 / 一时动作当成永久性格，隐藏设定不公开、不写进 known。',
  '  每条格式：{"id":"已存在的稳定 id；新人物可省略","name":"canonical 原名",' +
  '  "kind":"interaction|mention|change","evidence":"复制本回合叙事里的原文片段（须是 narration 的连续子串）",' +
  '  "known":{"role":"原文公开身份","description":"原文描述","voice":"原文口吻线索",' +
  '  "publicGoal":"原文已公开目标","relationshipSummary":"原文关系线索",' +
  '  "traits":{"appearance":{"衣着":"原文短语"}}},' +
  '  "internal":{"motivation":"只在内部保留的动机/状态"}}；单次最多 6 条。',
  // 第 4 轮返工（真实模型第 2 次）：模型把公共值概括 / 换词重组、并自造「复合标签」，
  // 引擎已正确拒绝；这里把「逐值逐字复制连续子串」「标签沿用已有键 / 中性词」写成明文契约，
  // 并给一组通用原文→JSON 正确示例。evidence 合法 ≠ known 里其它字符串合法，逐字段单独核对。
  '  逐值铁律：known 里每一个「真正新增 / 变化」的公共文本值（role / description / voice / publicGoal / ' +
  '  relationshipSummary，以及 traits 下每个键的「值」）都必须是本回合 narration 的「单个连续子串」，逐字复制：' +
  '  不得概括、换词、删词后重组、换词序，或把正文里相隔的几处拼成一句；' +
  '  可以直接引用一整句可见描写，不必压成摘要，更不要为省字改写。' +
  '  evidence 是原文连续子串，并不代表 known 里其它字符串就合法——每个 value 都要单独通过这项检查；' +
  '  引擎会逐值核对 value 是否在 narration 里连续出现，不符合就整条拒绝。',
  '  特征键 / 标签规则：优先沿用当前档案里该人物已有的键；确需新增才用简单中性标签' +
  '  （如「外貌」「衣着」「疤痕」「声音」「性格」「专长」「近况」「关系」等），' +
  '  标签本身不携带新事实、不泄露隐藏身份；' +
  '  不要组合或自造「复合自造标签」（把部位 / 物件 / 几个词拼成一个正文里不存在的新词当键），' +
  '  这类正文里并不存在的标签不应输出；标签要么中性、要么逐字出现在 narration 里，否则整条被拒。',
  '  原文→JSON 正确示例（通用写法；示例里的「值」必须真的出现在本回合正文，切勿照抄示例凭空填值）：' +
  '  若本回合正文写「那人今日换了件灰袍，袖口磨得发白」，该人的 evidence / known 应写成' +
  '  {"evidence":"那人今日换了件灰袍，袖口磨得发白","known":{"traits":{"appearance":{"衣着":"灰袍","特征":"袖口磨得发白"}}}}；' +
  '  值「灰袍」「袖口磨得发白」都逐字取自该句、是 narration 连续子串，标签「衣着」「特征」都是中性词；' +
  '  不要概括成「发白的旧灰袍」、不要自造「灰袍袖口」这类正文里不存在的复合标签，也不要把正文没有的词写进值或标签。',
  '  只记「真实已发生、与当前叙事相关、且有本回合原文 evidence」的资料：' +
  '  公共值一律摘自本回合原文，不把后台设定 / 隐藏动机 / 模型猜测包装成玩家已知的身份或性格；' +
  '  未知资料留空，不为填卡编造；「提及」不等于「当面见过」。',
  '  增量语义：已接纳且未变化的旧值允许重复出现、但不产生任何变化；' +
  '  真正的新值 / 变化必须有本回合叙事原文 evidence；' +
  '  这不要求把每个相同旧值都再逐字复述一遍，没变化不强求、空数组即可。',
  '  一时语气 / 情绪不能无缘由当成永久性格改变；完整原始人设与后来的变化并存，' +
  '  后来的变化不篡改过去、不改写锁定的世界设定（bible）。',
  '  人物档案不是在场名单，也不是任务清单：不得为凑资料插入未登场 / 不在当前场景的外人，' +
  '  不得打断玩家、替玩家做决定、强行转场或推进线索；玩家意图优先、私下 / 安静模式照旧保持。' +
  '  前世的交情不等于新主角已经相识；未来「可能 / 一年后」一律不得写成已发生事件；' +
  '  本轮没有时间推进按钮 / API，不要无故自动更新 NPC 年龄或年历。',
  '  name 用 canonical 原名（与【人物】里的名字一致），稳定 id 用来对应已有档案，' +
  '  避免好感 / 描述更新换人；既有 npc_attitude / voice_hints / scene.cast 继续用原名字，' +
  '  资料更新不会换掉原头像 / 音色设置。',
  '- 最终输出检查：有真实新资料就登记进 npc_updates、没有就给 []，' +
  '  不得反过来为填档案编剧情 / 造变化；npc_updates 始终是补充，正文优先、第一个字段。',
  '  逐字段检查（写完正文、登记 npc_updates 后）：每个 value 是本回合 narration 的连续子串（逐字、不概括不拼接）；' +
  '  标签是已有键 / 中性词；真正新资料就按原文登记，无变化给 []，不得编剧情填档案；' +
  '  narration 仍第一、正文先自然写完，不为 metadata 回头改写正文。',
].join('\n');

// v2 的输出格式：narration 仍为 JSON 第一个字段，正文优先；只改这两行，其余说明原样保留。
const V2_NARRATION_EXAMPLE = '{"narration":"第二人称叙事：段落短、段数多，一段只写一个动作、一个念头或一句对白，通常 20~70 字；关键场景 8~20 段、600~1200 字，过场 3~6 段、150~300 字，段间用空行分隔",';
const V2_NARRATION_NOTES = '- narration 是输出的第一个字段，先把 narration 写完整，再写其他字段：段落短、段数多，一段只写一个动作、一个念头或一句对白，通常 20~70 字；关键场景 8~20 段、600~1200 字，过场 3~6 段、150~300 字，对白单独成段。';
const V2_TURN_OUTPUT_FORMAT = TURN_OUTPUT_FORMAT.split(NL).flatMap((line) => {
  if (line.startsWith('{"narration":')) return [V2_NARRATION_EXAMPLE];
  if (line.startsWith('- narration 必须分成 2~4 个短段落')) return [V2_NARRATION_NOTES];
  return [line];
}).join(NL);

// 世界专属状态的设计规则：建世界（WORLD_OUTPUT_FORMAT）与老世界补设计
// （buildStatsMessages）共用同一份文案，避免两处规则漂移。
const STATS_DESIGN_RULES = [
  'bible.stats 是这个世界主角专属的 2~4 个状态值，按世界观量身设计，玩家在角色面板上看得到、会随剧情和时间变化：',
  '· 两种：数值槽 {"name","kind":"gauge","icon","desc","max","start","drift","warn":[{"below"或"above","label","effect","drain"}]}，等级阶梯 {"name","kind":"rank","icon","desc","ranks":[…],"start"}；',
  '· name ≤4 字，不能和六项基础属性（体魄/心智/魅力/气运/声望/资源）重名或意思重复；icon 用一个贴切的表情符号；desc ≤30 字说清它代表什么、怎么变化；',
  '· 数值槽 max 一般 100；start 是开局值；drift 是每过一个时段（清晨/午后/黄昏/深夜）自然变化多少（饥饿口渴这类会自然下降的给 -2~-5，理智、名声这类不自然变化的给 0）；',
  '· warn 给 1~2 条警戒线：低于（below）或高于（above）某值时的状态名 label（≤8 字）和后果 effect（≤40 字，写出对行动和叙事的具体影响）；最严重的一条可以带 drain（每回合扣 1 点的基础属性名，如饿到极点扣「体魄」、理智崩溃扣「心智」）；',
  '· 等级阶梯给 4~12 个由低到高的阶名（如修仙境界、游戏等级、帮派地位），start 是开局所在阶的下标；',
  '· 修仙题材的「境界」阶梯必须是修为本身，从低到高按小层列，前面细后面粗（如 练气一层、练气二层……练气九层、筑基初期、筑基中期、筑基后期），不要把门内身份（记名弟子、外门弟子、内门弟子）混进境界里；主角开局还没引气入体的，阶梯最前面加一阶「凡人」，start 指向它；start 按主角开局的修为定；',
  '· 举例：末日求生给「饱腹」「水分」（会自然下降，归零伤身）；修仙给「境界」（阶梯）和「灵力」；恐怖给「理智」（低了出现幻觉、崩溃）；游戏系统给「等级」（阶梯）和「能量」；',
  '· 不要设计和世界无关的通用数值，也不要超过 4 个。',
];

const WORLD_OUTPUT_FORMAT = [
  '输出 JSON：',
  '{"genre":"xuanhuan|urban|game|horror|cozy|general",',
  ' "bible":{"title":...,"tone":...,"rules":[str],"places":[{name,desc}],',
  ' "factions":[{name,desc,stance}],"npcs":[{name,role,desc,want,voice,rank}],',
  ' "start":{"place","period","situation","items":[str x2~3],"items_info":{"物品名":{"desc","type"}},"facts":[str x2~3]},',
  ' "prologue":{"world":"…","me":"…","goal":"…","now":"…"},',
 ' "stats":[{name,kind:"gauge",icon,desc,max,start,drift,warn},{name,kind:"rank",icon,desc,ranks,start}],"eventThemes":[str x6]},',
  ' "apex":{"title":...,"hint":...,"condition":{"attrs":{"声望":30}}},',
  ' "hero":{"name":"主角名","appearance":"一句外貌","voice":"主角的说话方式 ≤20 字"},',
  ' "edge":{"name":"≤8 字","look":"≤40 字","rules":["≤30 字 x3~4"],"cost":"≤30 字","secret":"≤30 字"},',
  ' "origins":[{"title":"≤8 字","blurb":"≤40 字","style":"冒险|审慎|共情|权谋|坚韧|秩序","attrs":{"体魄":2,"心智":1,"魅力":1,"气运":0,"声望":1,"资源":1},"item":{"name":"≤12 字","desc":"≤60 字","type":"≤6 字"}}]}',
  'genre 按玩家那句话世界观和 bible 的题材判断，只取 xuanhuan / urban / game / horror / cozy / general 之一；',
  '要求：名词具体、有张力、起点明确；eventThemes 给 6 个符合世界观的大事类型；',
  ...STATS_DESIGN_RULES,
  'bible.prologue 是给玩家看的「序章」，四段都要用通俗的话、不堆专有名词；首次提到的地名、人名顺带一句交代（是谁、什么地方）：',
  '  world = 这个世界是什么样的（3~4 句：时代、势力格局、力量体系、氛围）；',
  '  me = 你是谁（姓名或称呼 / 身份、出身、现在的处境、有什么本事或短板，2~3 句，用第二人称「你」）；',
  '  goal = 你想要什么、长期目标（1~2 句）；',
  '  now = 眼下的处境和该做什么（1~2 句，自然引出第一幕，与 start.situation 一致）；',
  'npcs[].role / desc / voice 写「可公开、玩家可读」的部分：role 是公开身份 / 职责，' +
  'desc 是外显形象 / 性格 / 行事风格，voice 是说话风格；角色确已出场后会作为「初始设定」' +
  '基础介绍展示给玩家，所以这里只写能公开看见的，绝不塞入隐藏身份 / 暗线 / 隐秘目标 / 幕后动机；',
  '暗线、隐秘目标、不可告人的欲望一律放进 npcs[].want（只作模型内部驱动反应，不进公开介绍），' +
  '不要混进 role / desc / voice 的公开描述里；',
  'npcs[].want 写清「这个人想要什么」（能驱使他的欲望/立场），每个 NPC 各不相同，用于让反应有差异；',
  'npcs[].voice 写「这个人的说话方式」，≤20 字（如「短句铁令，从不解释」「哄劝式隐喻，句句带笑」「记账式冷语，只报数目」），' +
  '  voice 只描述风格（句式长短、语气、用词习惯），不要写成『句尾加某个字』『每句都以…结尾』这类机械规则；' +
  '  每个 NPC 必须明显不同：句式长短、用词、语气、是否解释、是否带隐喻都要拉开差异，作为台词的语言指纹；',
  'start.items 给 2~3 个符合世界观的起始物品（角色开局随身携带，名称 ≤12 字，如「一封无字信」「旧铜灯」）；',
  'start.items_info 给 start.items 里每个物品 1~2 句介绍和类型，键与物品名一致：',
  '  desc ≤60 字（是什么、有什么用或特别之处、来历），type ≤6 字（法器/丹药/兵器/杂物/信物/文书…，可选）；',
  'start.period 是开场所处的时段，只能是 清晨 / 午后 / 黄昏 / 深夜 之一，必须和 start.situation 写的天色一致（雨夜、深夜来电就写「深夜」）；',
  'start.facts 给 2~3 条关键时间/规则事实（每条 ≤30 字，如「满月在三日后」「城门每日戌时落锁」「报出真名会被登记」），',
  '  用来锁定开局时间线与世界规则（例如满月究竟是哪天）；这些会被写入世界事实账本，之后的叙事必须遵守、不得改写或前后矛盾；',
  'apex 是玩家不可见的隐藏长期目标，condition.attrs 用 体魄/心智/魅力/气运/声望/资源 中的键与可达阈值。',
  'hero：玩家给了主角姓名就原样用；没给就起一个符合世界观的名字。appearance 一句话外貌（玩家给了形象就照着写）。voice 是主角说话的腔调（≤20 字，贴合出身和性子，和 NPC 的 voice 一样只写风格）。',
  'npcs[].rank：修仙题材必填，这个人的修为（≤8 字，用 stats 里境界阶梯的阶名，或更高的境界名），其他题材不填；',
  'edge：只有修仙题材给，其他题材不填。这是主角的金手指——一件只有主角有、能让他比别人修炼得快或活得下去的东西或本事：name 叫什么；look 它刚出现时看上去是什么样（主角最初能感知到的样子）；rules 是 3~4 条它的隐藏规律，主角要靠试探一条条摸清，每条都能换来看得见的好处（由浅到深）；cost 用它的代价或限制；secret 为什么绝不能让人知道。它的来历是全书的核心谜底，不写进 edge。',
  'origins 给 3 个主角出身，玩家开局时从中选一个：',
  '  · 先读懂玩家那句世界观里主角本人的设定（如「全世界唯一的男性」「重生回到十年前」「穿成反派身边的炮灰」「觉醒了系统」「被选中的祭品」），这是三个出身共同的前提：每个出身都必须带着这个设定，并让它在 title 或 blurb 里看得见，绝不能把主角写回一个放到哪个世界都成立的普通人；',
  '  · 三个出身是同一个前提下三种不同的处境和活法（比如「重生回到十年前」可以是「带着记忆的穷学生」「提前押中风口的小老板」「知道凶手是谁的证人」），方向明显不同（站在不同势力里、握着不同筹码：一个能打、一个有门路、一个会钻营），都要能自然落在同一个开场情境（start.situation）里；',
  '  · 每个出身都扎根在这个世界里：来自、依附或对抗 bible 里的某个势力、地点或人物，blurb 里点出这层关系；世界观没给主角特殊设定时也一样，不要给和本世界无关、换个世界也成立的通用身份；',
  '  · title ≤8 字，一眼看得出是这个世界里的身份；blurb ≤40 字，写清这个出身的处境、长处和随之而来的麻烦；',
  '  · attrs 是这个出身在六项基础属性上的额外加点，合计正好 6 点、单项 0~3；style 是这个出身最接近的行事风格，只能取 冒险 / 审慎 / 共情 / 权谋 / 坚韧 / 秩序 之一，三个出身的 style 各不相同；',
  '  · item 是这个出身多带的一件起始物品（名称 ≤12 字，desc ≤60 字，type ≤6 字），要和这个出身、这个世界对得上，不要和 start.items 重复；',
  '  · 如果玩家写了「你是谁」，第一个出身就照玩家写的来（title 概括玩家写的身份，同样带上世界观给主角的设定），另外两个给不同方向的选择；',
  '  · 因为出身由玩家选，prologue.me 只写三个出身共通的部分（姓名、世界观给主角的特殊设定、眼下的处境），不要写死具体出身。',
].join('\n');

function worldBibleText(bible) {
  const b = bible || {};
  const places = (b.places || []).map((p) => `${p.name}：${p.desc || ''}`).join('；');
  const factions = (b.factions || []).map((f) => `${f.name}（${f.stance || ''}）：${f.desc || ''}`).join('；');
  const npcs = (b.npcs || [])
    .map((n) => `${n.name}（${n.role || ''}）：${n.desc || ''}` +
      `${n.want ? `；想要：${n.want}` : ''}${n.voice ? `；口吻：${n.voice}` : ''}`)
    .join('；');
  return [
    `标题：${b.title || ''}`,
    `基调：${b.tone || ''}`,
    `规则：${(b.rules || []).join('；')}`,
    `地点：${places}`,
    `势力：${factions}`,
    `人物：${npcs}`,
    `起点：${(b.start && b.start.place) || ''} — ${(b.start && b.start.situation) || ''}`,
    `事件主题：${(b.eventThemes || []).join('、')}`,
  ].join('\n');
}

function characterText(state) {
  const c = state.character || {};
  const attrs = Object.entries(c.attrs || {}).map(([k, v]) => `${k}:${v}`).join(' ');
  const attitude = Object.entries(state.npcAttitude || {}).map(([k, v]) => `${k}:${v}`).join(' ');
  return [
    `姓名：${c.name || '（无名）'}；形象：${c.appearance || ''}`,
    ...(c.origin && c.origin.title ? [`出身：${c.origin.title}——${c.origin.blurb || ''}`] : []),
    `属性：${attrs}`,
    `物品：${(c.items || []).join('、') || '无'}`,
    `NPC 态度：${attitude || '无记录'}`,
  ].join('\n');
}

function timePlaceText(state) {
  const loc = state.location ||
    (state.bible && state.bible.start && state.bible.start.place) || '未知之地';
  const c = state.clock && typeof state.clock === 'object' ? state.clock : {};
  const day = Number.isInteger(c.day) && c.day >= 1 ? c.day : 1;
  const period = ['清晨', '午后', '黄昏', '深夜'].includes(c.period) ? c.period : '清晨';
  return `地点：${loc}；时间：第${day}日 ${period}`;
}

function recentText(state) {
  const rec = state.recent || [];
  if (!rec.length) return '（尚无近期记录）';
  return rec.map((r) => `#${r.turn} 行动：${r.action} / 叙事：${r.narration}`).join('\n');
}

function chronicleText(state) {
  const ch = (state.chronicle || []).slice(-2);
  if (!ch.length) return '（尚无编年史）';
  return ch.map((c) => `第${c.chapter}章（${c.fromTurn}-${c.toTurn}）：${c.summary}`).join('\n');
}

// 第一幕用的当前地点环境：只取 state.location（缺失时回退 bible.start.place）
// 精确匹配到的那一个 bible.places 的 name/desc；无匹配或 desc 为空则返回 null（片段整体省略），
// 不取别的地点、不编造环境。非首回合由调用方跳过，避免每回合重讲环境。
function firstActEnvironment(state) {
  if (!state || state.turn !== 0) return null;
  const b = state.bible;
  if (!b || !Array.isArray(b.places)) return null;
  const loc = state.location || (b.start && b.start.place);
  if (typeof loc !== 'string' || !loc) return null;
  const place = b.places.find((p) => p && p.name === loc);
  if (!place || typeof place.desc !== 'string' || !place.desc.trim()) return null;
  return { name: place.name, desc: place.desc.trim() };
}

// 回合提示词里的「专属状态」逐行文本。纯函数：自己按 below/above 判断生效警戒，
// 不 require engine/*（保持 prompts.js 无引擎依赖、避免循环 require）。
// state.stats 缺失 / 为空返回 ''，老存档据此整段省略。
function statsSectionText(state) {
  const list = state && Array.isArray(state.stats) ? state.stats : [];
  const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
  const lines = [];
  for (const st of list) {
    if (!st || typeof st !== 'object') continue;
    const name = typeof st.name === 'string' ? st.name : '';
    const icon = typeof st.icon === 'string' && st.icon ? st.icon : '◆';
    const warns = Array.isArray(st.warn) ? st.warn : [];
    if (st.kind === 'rank') {
      const ranks = Array.isArray(st.ranks) ? st.ranks.filter((r) => typeof r === 'string') : [];
      const idx = Math.max(0, Math.min(ranks.length - 1, Math.round(num(st.value, 0))));
      const cur = ranks[idx] !== undefined ? ranks[idx] : '';
      lines.push(`${name} ${icon}：${cur}（${ranks.join(' → ')}）`);
      continue;
    }
    const max = num(st.max, 100);
    const value = num(st.value, 0);
    const drift = num(st.drift, 0);
    let line = `${name} ${icon}：${value}/${max}（每个时段自然 ${drift > 0 ? '+' : ''}${drift}）`;
    const active = warns.filter((w) => {
      if (!w || typeof w !== 'object') return false;
      if (typeof w.below === 'number' && Number.isFinite(w.below)) return value <= w.below;
      if (typeof w.above === 'number' && Number.isFinite(w.above)) return value >= w.above;
      return false;
    });
    if (active.length) {
      // 多条生效时优先显示最严重的一条（带 drain），与引擎结算口径一致。
      const w = active.find((x) => x && x.drain) || active[active.length - 1];
      line += `；当前：${typeof w.label === 'string' ? w.label : ''}——${typeof w.effect === 'string' ? w.effect : ''}`;
    } else if (warns.length) {
      const w = warns.find((x) => x && typeof x === 'object') || {};
      const bound = typeof w.below === 'number' && Number.isFinite(w.below)
        ? `低于 ${w.below}` : (typeof w.above === 'number' && Number.isFinite(w.above) ? `高于 ${w.above}` : '');
      line += `；警戒线：${bound}${bound ? ' ' : ''}${typeof w.label === 'string' ? w.label : ''}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

// 「专属状态」段的配套说明：本回合造成的变化与随时间自然变化的分工。
const STATS_TURN_NOTES = [
  '本回合玩家的行动或遭遇直接造成的变化，用 stats_diff 写（如吃下半个面包「饱腹」+15、目睹惨状「理智」-8、修炼突破「境界」+1）；',
  '随时间自然流逝的变化由系统自动结算，不要在 stats_diff 里重复扣；',
  '当前生效的状态（上面「当前：…」）必须在叙事里体现后果，不能无视；',
  '等级阶梯只在叙事里确实发生突破或跌落时才 ±1，突破要有铺垫和代价，不要轻易给。',
].join('\n');

// 时光推进（仅 plan.timeSkip 存在时）：替换「时与地（叙事一致性）」段。
// 单项 / 合计上限与 validateProposal 保持一致：month 为 1 / 2，其余为 3 / 5。
function timeSkipSectionText(ts) {
  const month = ts && ts.span === 'month';
  const diffMax = month ? 1 : 3;
  const totalMax = month ? 2 : 5;
  const planText = ts && ts.plan ? ts.plan : '玩家没有说明，按主角眼下的处境和性格过日子';
  const label = ts && ts.label ? ts.label : '';
  const days = Number.isFinite(ts && ts.days) ? ts.days : 0;
  return [
    `本回合不是一步普通行动，而是时间跳跃：从【时与地】给出的此刻起，过去${label}（约${days}天）。玩家对这段时间的打算：「${planText}」。`,
    '写法：',
    '1. 先用 3~6 段按时间顺序概写这段时间，段首可点明季节或月份；主角按玩家的打算行事，得到与其能力、处境相符的结果，有代价、有挫折也有收获，不要一路顺风。',
    '2. 再用 2~4 段落到跳跃结束时一个具体的时刻：主角在哪、在做什么、眼前出现了什么新情况；结尾留一个钩子，不要出选择题。',
    '3. 只写玩家打算之内的事和世界自然的变化；不要替玩家做重大、不可逆的决定（拜师、成亲、背叛、杀人、远走他乡等），除非玩家的打算里写了。',
    '4. 已认识的人物在这段时间里按各自的性格、处境和动机过日子，有的变化明显，有的几乎没变；只写主角能看见、听到的部分，私密动机只能通过可见的举动体现，不能直接说破。每个在正文里写到变化的人物，都在 npc_updates 里记下，证据必须出自本回合正文。',
    '5. 进行中的事件与未解线索在这段时间里应当有结果或进展，正文里要交代清楚。',
    `6. 数值：state_diff 反映这段时间的积累（单项最多 +${diffMax}，正向合计最多 +${totalMax}）；可以增减物品；可以 move_to 到新地点（正文必须写明怎么到的）；new_facts 记 1~2 条这段时间确立的重要事实。`,
    '   专属状态：这段时间里它们落地后的增减也用 stats_diff 写清楚（系统不会自动结算这段时间的自然变化，单回合上限放宽）。',
    '7. 输出 JSON 里额外给 "landing_period"：跳跃结束时的时段，只能是 清晨 / 午后 / 黄昏 / 深夜 之一。time_passes 本回合不起作用。',
    '8. 本段优先于输出格式里关于 time_passes 和『叙事与【时与地】一致』的通用要求：叙事从【时与地】的此刻出发，结尾落在跳跃结束之后的新时刻。',
  ].join('\n');
}

// 回合：返回 OpenAI chat/completions 的 messages 数组。
// opts.adult：本回合是否使用「成人模式开」档提示词（由编排层按主人总开关 + 该玩家开关计算）。
function buildTurnMessages(state, plan, action, opts) {
  const p = plan || {};
  const timeSkip = p.timeSkip || (opts && opts.timeSkip) || null;
  const adult = !!(opts && opts.adult);
  const nextTurn = p.nextTurn || (state.turn || 0) + 1;
  // 叙事写法：默认读配置（编排层把 cfg.NARRATIVE_STYLE 经 opts.narrativeStyle 传入，
  // 未传时取 DEFAULTS 的 v1）；opts.style 优先级最高，供对比脚本逐次覆盖。
  // 允许 v1 / v2 / v2-3p：v2 与 v2-3p 共用小说化规则，后者改用第三人称（用主角名字）。
  const cfgStyle = (opts && opts.style) || (opts && opts.narrativeStyle) || env.DEFAULTS.NARRATIVE_STYLE;
  const isV2 = cfgStyle === 'v2' || cfgStyle === 'v2-3p';
  const is3p = cfgStyle === 'v2-3p';

  const sys = [];
  sys.push(CONSTITUTION);
  sys.push(section('锁定的世界设定（只读，不得改写）', worldBibleText(state.bible) +
    '\n这些规则真实成立，但正文没写过之前读者并不知道；第一次出现时要正面交代主角是怎么得知的。'));
  sys.push(section('叙事与状态规则', isV2 ? V2_TURN_RULES : TURN_RULES));
  // 题材文风：v2 / v2-3p 在「写作手法」段之后追加选中文风段；v1 与 general 不追加。
  if (isV2) {
    const genreStyle = GENRE_STYLES[normalizeGenre(state && state.genre)] || '';
    if (genreStyle) sys.push(genreStyle);
  }
  sys.push(section('亲密关系', INTIMACY_COMMON + '\n' + (adult ? INTIMACY_ADULT_ON : INTIMACY_ADULT_OFF)));
  // 安静模式：玩家的私人时间，禁止任何外部事件 / 来电 / 来人 / 公告插入。
  if (p.quiet) {
    sys.push(section('当前是玩家的私人时间',
      '当前是玩家的私人时间：不要插入任何外部事件、来电、来人或公告；世界的动静最多作为一句远处背景出现，玩家可以不理。'));
  }
  // 第一幕：只保留「衔接序章此刻」这一独有职责。首次出场交代 / 续写承接已上移到【叙事与状态规则】
  // 通用条款（覆盖所有回合、所有写法），这里不再重复注入同义要求，避免开局出现两段雷同指令。
  if (state.turn === 0) {
    sys.push(section('第一幕（开场衔接）',
      '这是第一幕：从序章「此刻」给出的处境自然接上展开，不要丢开序章已经给玩家的处境。'));
  }
  if (timeSkip) {
    sys.push(section('时光推进（本回合特殊）', timeSkipSectionText(timeSkip)));
  } else {
    sys.push(section('时与地（叙事一致性）',
      '叙事里的所处地点、白昼/黑夜、所在日子必须与【时与地】一致，不要凭空跳到别处或别的时段；' +
      '时间只随回合缓慢推进，不可一夜之间改换季节。'));
  }

  // 已确立的事实：把全部 facts 列为叙事必须遵守、不得改写的客观真理（动态列表，最多 40 条）。
  const factTexts = (state && Array.isArray(state.facts))
    ? state.facts.map((f) => (f && typeof f.text === 'string' ? f.text : ''))
    : [];
  if (factTexts.length) {
    sys.push(section('已确立的事实（叙事必须遵守，不得改写）',
      bulletList(factTexts) +
      '\n以上均为本世界已经确立的客观事实，叙事必须与之保持一致：不得矛盾、不得改写、不得重新解释、' +
      '也不得把它们当作新发现重新宣布一遍。本回合新确立的事实才用 new_facts 记录。'));
  }

  // 身上的印记：必须持续产生后果；越界行为要留下新印记。
  const markTexts = (state && state.character && Array.isArray(state.character.marks))
    ? state.character.marks
    : [];
  if (markTexts.length) {
    sys.push(section('身上的印记（持续生效，不得无视）',
      bulletList(markTexts) +
      '\n这些是已经落在角色身上的持久处境，本回合及之后的叙事里必须持续产生可见后果，不能写过一次就当没发生；' +
      '玩家本回合若越界（宣称不存在的神力/宝物、动粗、强闯、冒犯势力），必须用 marks_add 留下一枚新印记；' +
      '印记已了结时用 marks_remove 移除（文本须与上面某条完全一致）。'));
  }

  // 专属状态（世界专属面板）：state.stats 非空时列出当前值与生效警戒 / 阶梯，
  // 要求本回合直接造成的变化写进 stats_diff、自然变化不重复扣。老存档无该字段整段省略。
  const statsBody = statsSectionText(state);
  if (statsBody) {
    sys.push(section('专属状态（随剧情和时间变化）', statsBody + '\n' + STATS_TURN_NOTES));
  }

  // 未解之谜：活跃线索要推进/收束，已淡去/已解开的不要重新提起。
  const threadTexts = (state && Array.isArray(state.threads)) ? state.threads : [];
  const fadedTexts = (state && Array.isArray(state.fadedThreads)) ? state.fadedThreads : [];
  if (threadTexts.length || fadedTexts.length) {
    let body = '';
    if (threadTexts.length) {
      body += '仍悬而未决、需要后续收束的线索：\n' + bulletList(threadTexts) + '\n';
    }
    if (fadedTexts.length) {
      body += '已淡去/已解开的线索（不要再重新提起、不要重新埋设）：\n' + bulletList(fadedTexts) + '\n';
    }
    body += '玩家主动接触相关人物或地点时再推进或解开：给出新信息、让线索指向具体的人或地点、或用 threads_resolve 收束它；' +
      '玩家不理会时，线索可以作为背景传闻出现一次，不要每回合重复，主线等玩家。' +
      '不能只埋不收，也不要让同一条线索反复原地打转。新埋线索用 threads_add（每条 ≤20 字），' +
      '解开用 threads_resolve（文本须与上面某条完全一致）。';
    sys.push(section('未解之谜', body));
  }

  // 隐晦提示：apex.hint，只要求通过传闻 / 机会 / NPC 态度暗示，绝不点破。
  const hint = state.apex && state.apex.hint;
  if (hint) {
    sys.push(section('隐晦线索（绝不点破）',
      `有一条隐藏线索：「${hint}」。只通过传闻、偶发的机会、NPC 微妙的态度去暗示它，` +
      '禁止直接说明、命名或解释它代表什么，也不要把它写成任务或目标。'));
  }

  // 高光期：写法提示，但不说破原因。
  if (state.highlightUntilTurn > 0 && nextTurn <= state.highlightUntilTurn) {
    sys.push(section('写法提示',
      '本回合值得写一段克制的高光时刻：气氛更浓、留白更多，但不要说破原因，也不要宣布达成任何目标。'));
  }

  // 风声预兆：距下次事件 1~2 回合时，叙事里埋不祥征兆。主题只交给模型，
  // 明确禁止命名 / 点破，玩家侧只会看到一个「风声渐紧」的布尔标记。
  if (p.omen && p.omenTheme) {
    sys.push(section('风声预兆（只写征兆，绝不点破）',
      `一件与「${p.omenTheme}」有关的大事正在逼近。请在叙事里埋下与之呼应的不祥征兆：` +
      '反常的天色、欲言又止的路人、骤然收紧的市井气氛、断了线的旧消息……' +
      '只写气氛与征兆，不要写出主题词、不要宣布将发生什么、也不要把它写成任务或目标。'));
  }

  // 事件中：开启事件 / 结算事件说明。
  if (p.opening) {
    sys.push(section('本回合要求：开启事件',
      `引擎已排定开启一个世界性事件，主题是「${p.theme}」。请在输出里给出 event:{title,desc}，` +
      '把这桩大事写进叙事，但把应对留给玩家下一回合。'));
  } else if (p.settling && state.activeEvent) {
    const ev = state.activeEvent;
    sys.push(section('本回合要求：结算事件',
      `进行中的事件：「${ev.title}」（${ev.theme}）— ${ev.desc}。` +
      '玩家本回合的行动将用于结算，请输出 event_check:{attr,response_quality}，据实评价玩家应对（0~3）。' +
      '事件回合玩家不可回避。' +
      (p.quiet ? '这次结算请写成背景里发生的事，不打断玩家当前正在做的事，玩家仍可继续原来在做的事。' : '')));
  }

  // 导演机制：引擎判定本回合必须出现明显转折。转折词只给模型，不写进公开状态。
  // 安静模式（planTurn 已把 twist 置空）再兜一层，绝不注入转折去打断玩家。
  if (p.twist && !p.quiet) {
    sys.push(section('本回合要求：明显转折',
      `本回合必须出现明显转折：${p.twist}，要符合世界设定和当前局面。` +
      '把它写成叙事里真实发生、看得见的变化（人物、事件或局势的转折），不要只写气氛，' +
      '不要点破这是被安排的转折，也不要因此宣布达成任何目标或结局。'));
  }

  // 濒死可感知：体魄 ≤ 2 时，要求叙事明确写出伤势严重（只进 prompt，不进公开状态的内部词）。
  const bodyAttr = state && state.character && state.character.attrs
    ? Number(state.character.attrs['体魄']) : NaN;
  if (Number.isFinite(bodyAttr) && bodyAttr <= DANGER_BODY) {
    sys.push(section('伤势沉重（叙事必须明确写出）',
      `角色体魄仅剩 ${bodyAttr}（≤${DANGER_BODY}），已濒临死亡。本回合叙事必须明确写出伤势的严重程度：` +
      '哪里在流血、哪处骨头或筋络出了问题、视线发黑 / 站立不稳 / 抬手困难等具体可感的细节，' +
      '并让旁人或环境对这副将死之躯有可见反应；不要用「略感疲惫」「有些不适」轻轻带过，' +
      '也不要把伤写成已经痊愈。若玩家仍不设法自救，要让局面明显更险，并让 NPC 态度、机会随之流失。'));
  }

  // NPC 语言指纹：把每个 NPC 的 voice 带入，要求台词严格符合各自的口吻且彼此不同。
  const npcs = (state && state.bible && Array.isArray(state.bible.npcs)) ? state.bible.npcs : [];
  const voiceLines = npcs
    .filter((n) => n && typeof n.name === 'string' && n.name.trim())
    .map((n) => `- ${n.name}：${(typeof n.voice === 'string' && n.voice.trim())
      ? n.voice.trim() : '（未标注，须当场确立一种与他人明显不同的说话方式）'}`);
  if (voiceLines.length) {
    sys.push(section('NPC 语言指纹（台词必须严格符合）',
      voiceLines.join('\n') +
      '\n每个 NPC 开口说话都必须严格符合上面各自的 voice：句式长短、用词习惯、语气、是否解释、是否带隐喻都要照着来；' +
      '彼此之间必须明显不同，不能两三个人都用「温和地逼问」「压低声音」「你自己去看」同一套腔调，' +
      '也不要把不同 NPC 写成同一个信息出口。同一 NPC 前后回合要始终沿用这一口吻，别写着写着变回通用旁白。' +
      '未标注 voice 的 NPC，要当场确立一种与其他人不同的说法并沿用下去。' +
      'voice 描述的是说话的风格（句子长短、语气、用词、是否解释），不是要逐字照搬的标签。绝不能在台词末尾机械地附加『问？』『说：』『答：』『笑。』这类字或固定口头禅；习惯反问的人，要把话写成真正自然的问句（如「……是不是？」「你说呢？」），而且不必句句都是问句。'));
  }

  // 相关人物档案（内部连续性参考）：npcPromptContext 按行动点名 / 最近相关度只选少量 NPC
  // （默认 ≤4 人 = NPC_PROMPT_MAX_NPCS、整体 ≤2000 字 = NPC_PROMPT_MAX_CHARS、
  // 每人 ≤360 字 = NPC_PROMPT_PER_NPC_CHARS）。每人按字段分配独立预算（PROMPT_FIELD_CAPS），
  // 超预算的低优先字段跳过、长字段由 clipExcerpt 注明「摘录」，而非把一人 360 字整块截断。
  // 正常 prompt 只摘与当前行动相关的信息，绝不把全角色全集 / 全量历史每回合塞进 prompt；
  // state.npcProfiles 与 events.jsonl 履历里的原文永不裁剪。关系 / 旧经历带时间 / 当时主角
  // 姓名来源，前世交情不自动当本世已相识；未来「推进一年」本轮尚未实现。常量以 src/npcs.js 为准。
  // 片段含 [内部档案] / [内部状态] 等私有资料，只给叙事模型参考，不进任何公开响应。
  const npcCtx = npcModule.npcPromptContext(state, action);
  if (npcCtx) {
    sys.push(section('相关人物档案（仅内部连续性参考）',
      npcCtx +
      '\n以上只用于保持已认识人物的身份、原形象、旧交与承诺连续，原始设定与后来的变化并存、' +
      '不因后来的变化改写过去。只为当前行动 / 叙事确实相关的人物取用，' +
      '绝不为凑字把不在场 / 无关的人写进本回合、不插入外人打断玩家、不替玩家做决定；' +
      '玩家意图优先，私下 / 安静模式照旧不引入外部来人。隐藏动机 / 秘密只作内部参考，' +
      '不得当成玩家已知事实写进叙事，也不得据此凭空改变 NPC 的公开身份 / 形象 / 音色。'));
  }

  // 越界升级：带累计次数与阶梯，避免每次复用同一套惩罚。
  sys.push(section('越界升级（护栏，按累计次数升级）', overstepDirective(state && state.oversteps)));

  // 安全选项有代价：退让 / 观望 / 回避也必须失去点什么，不能零成本，且不复用同一套避险动作。
  sys.push(section('安全选项的代价（不得零成本）',
    '玩家本回合若表现为退让、观望、回避、沉默、退三步、摊开空手、把决定推给他人等避险动作，' +
    '叙事里必须真的发生一次损失或错失，不能平安无事：相关 NPC 的信任下降（npc_attitude 给负值）、' +
    '机会被旁人抢先、线索被别人取走、被记下「怯懦 / 不可靠」的印记（marks_add）、或干脆错过某一时限；' +
    '把这些代价写成看得见的事，并同步进对应的状态字段，不要只写「你退到一旁，无人理会」就结束。' +
    '同一套避险动作（退步、垂手、摊空掌心、让对方自己看）不要连续复用，避险也要换新的写法与新的代价。' +
    '此规则不适用于玩家主动选择的私密、社交、休息、亲密场景；那些场景里玩家安心停留不是避险，不要硬塞代价或打断。'));

  // 当前物品列表放在输出格式说明旁边，并明确物品栏必须与叙事同步。
  const curItems = (state && state.character && Array.isArray(state.character.items))
    ? state.character.items : [];
  sys.push(section('当前随身物品（物品栏必须与叙事同步）',
    `角色当前拥有的物品：${curItems.length ? curItems.join('、') : '（无）'}。\n` +
    '叙事里交出、丢失、用掉、被收走的物品，必须同时写进 items_remove；只有真正得到新物品才写 items_add。' +
    '物品栏必须与叙事一致：已交出/失去的物品不能再出现在角色身上，也不能在后续叙述里被重新使用。'));

  sys.push(section('输出格式', isV2 ? V2_TURN_OUTPUT_FORMAT : TURN_OUTPUT_FORMAT));

  const firstActEnv = firstActEnvironment(state);
  const user = [
    section('当前状态', characterText(state)),
    section('时与地', timePlaceText(state) +
      '\n（本回合叙事须与此一致；若要转场，请在 move_to 写出新地点）'),
    section('物品与性格约束',
      '上面「物品」一行是角色当前拥有的全部物品。玩家声称使用其中没有的物品时，叙事要写出「你摸遍全身也没有」之类的失败，' +
      '不可凭空给、也不可写进 items_add。persona_tags 只能取 冒险/审慎/共情/权谋/坚韧/秩序 这 6 个词，不要自造。'),
    section('最近两章编年史', chronicleText(state)),
    section('最近六回合', recentText(state)),
    section('玩家本回合的行动', String(action == null ? '' : action) || '（未填写，自由行动）'),
    // 第一幕：把当前地点尚未读过的环境背景放到临近行动 / 输出处，仅作场景落位。
    ...(firstActEnv
      ? [section('当前地点的环境背景（玩家尚未读过）',
          `${firstActEnv.name}：${firstActEnv.desc}\n${FIRST_ACT_ENV_INSTRUCTION}`)]
      : []),
    // 临近落笔处再给一条简短提醒，避免核心约束埋在约 1 万字符的 system 里被忽略。
    section('落笔前·场景连贯提醒', SCENE_COHERENCE_REMINDER),
    // 落笔指令所在行（user 末行）再简短重复一次补档逐字段核对；正文第一、先写完正文再补档、不回改正文。
    '请据此写出本回合叙事与提议，只输出 JSON。' +
    '（补档再逐字段核对 npc_updates：value 是 narration 连续子串、标签为已有键 / 中性词，' +
    '真正新资料按原文登记、无变化 []，不得编剧情填档案；正文第一、先写完正文再补档、不回改正文。）',
  ].join('\n\n');

  let systemContent = sys.join('\n\n');
  if (is3p) {
    // 与 v2 同一套规则，只把叙事人称从第二人称改成第三人称：用主角名字，而非「你」。
    const c3 = (state && state.character) || {};
    const hero = (c3.name && String(c3.name).trim()) ||
      (c3.gender === '女' ? '她' : c3.gender === '男' ? '他' : '少年');
    systemContent = systemContent
      .split('第二人称').join('第三人称（用主角名字）')
      .split('「你').join(`「${hero}`);
  }
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: user },
  ];
}

// 老世界补序章：据世界设定 + 角色当前状态，另写四段「序章」（world/me/goal/now）。
// now 写「此刻」真正的处境而不是开局，供已推进过的老世界玩家重新找到方向。
function buildPrologueMessages(state) {
  const c = (state && state.character) || {};
  const attrs = Object.entries(c.attrs || {}).map(([k, v]) => `${k}:${v}`).join(' ');
  const recent = ((state && state.recent) || []).slice(-2)
    .map((r) => `#${r.turn} 行动：${r.action} / 叙事：${r.narration}`).join('\n') || '（尚无近期记录）';
  const loc = (state && state.location) ||
    ((state && state.bible && state.bible.start && state.bible.start.place) || '未知之地');
  const system = [
    '你是「无限世界」的序章执笔人，只输出一个 JSON 对象，不要解释文字。',
    '为一位对世界与自身处境感到茫然的玩家写一段「序章」，补上开局缺失的引导。',
    '输出 JSON：{"world":...,"me":...,"goal":...,"now":...}',
    'world = 这个世界是什么样的（3~4 句：时代、势力格局、力量体系、氛围）；',
    'me = 你是谁（姓名或称呼 / 身份、出身、现在的处境、有什么本事或短板，2~3 句，用第二人称「你」）；',
    'goal = 你想要什么、长期目标（1~2 句）；',
    'now = 眼下的处境和该做什么（1~2 句，要写「此刻」真正的处境而不是开局，自然引出下一幕）。',
    '用通俗的话，不要堆专有名词；首次提到的地名、人名要带一句交代（是谁、什么地方）。',
  ].join('\n');
  const user = [
    section('世界设定', worldBibleText(state && state.bible)),
    section('角色当前状态', [
      `姓名：${c.name || '（无名）'}`,
      `属性：${attrs || '无'}`,
      `物品：${(c.items || []).join('、') || '无'}`,
      `所在地：${loc}`,
      `当前回合数：${(state && state.turn) || 0}`,
    ].join('\n')),
    section('最近 2 条叙事', recent),
    '请据此写出序章四段，只输出 JSON。',
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 老世界补设计专属状态：system 与建世界共用同一份 STATS_DESIGN_RULES，只输出 {"stats":[...]}；
// user 据标题 / 基调 / 题材 / 主角 / 此刻 / 最近 2 回合给「眼下处境」，让 start 填得合理。
// 刻意不用 worldBibleText（它会把 npcs[].want 的隐藏动机带进提示词）。
function buildStatsMessages(state) {
  const s = state || {};
  const b = s.bible || {};
  const recent = (Array.isArray(s.recent) ? s.recent : []).slice(-2);
  let happened;
  if (recent.length) {
    happened = recent.map((r) => {
      const narr = String((r && r.narration) || '').slice(-900);
      return `#${(r && r.turn) != null ? r.turn : ''} 行动：${(r && r.action) || ''} / 叙事：${narr}`;
    }).join('\n');
  } else {
    happened = (b.start && b.start.situation) || '';
  }
  const system = [
    '你是「无限世界」的专属状态设计师，只输出一个 JSON 对象，不要解释文字。',
    '为这个已经开局的旧世界补设计 2~4 个主角专属状态。',
    ...STATS_DESIGN_RULES,
    '输出 JSON：{"stats":[...]}，只含 stats 一个字段，不要输出其他字段。',
    'start 填「按眼下剧情处境合理的当前值」（例如刚饿了两天就低一些），不要一律照搬开局默认值。',
  ].join('\n');
  const user = [
    section('世界', `标题：${b.title || ''}\n基调：${b.tone || ''}\n题材：${s.genre || ''}`),
    section('主角', characterText(s)),
    section('此刻', timePlaceText(s)),
    section('最近 2 回合', happened),
    '请据此补设计这 2~4 个专属状态，只输出 {"stats":[...]}。',
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 老物品补介绍：回合模型一次批量给若干物品写介绍，输出 {物品名:{desc,type}}。
function buildItemsInfoMessages(state, names) {
  const list = (Array.isArray(names) ? names : [])
    .filter((n) => typeof n === 'string' && n.trim())
    .map((n) => n.trim());
  const system = [
    '你是「无限世界」的物品考据官，只输出一个 JSON 对象，不要解释文字。',
    '为下列随身物品各写一段简短介绍与一个类型。',
    '输出 JSON：{"物品名":{"desc":"…","type":"…"}}，键必须是给出的物品名，不要增删、不要改字。',
    'desc：1~2 句，说清它是什么、有什么用或特别之处、来历，≤60 字。',
    'type：可选的类型词（如 法器/丹药/兵器/杂物/信物/文书），≤6 字；没有合适的就省略该键。',
  ].join('\n');
  const user = [
    section('世界设定', worldBibleText(state && state.bible)),
    section('需要介绍的物品', list.join('、')),
    '请据此逐个给出介绍，只输出 JSON。',
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 建世界：输入玩家一句话，输出 bible + apex。
function buildWorldMessages(seed, input) {
  const i = input || {};
  const system = [
    '你是「无限世界」的开局架构师，只输出一个 JSON 对象（bible + apex），不要任何解释文字。',
    CONSTITUTION,
    WORLD_OUTPUT_FORMAT,
  ].join('\n\n');
  const user = [
    `玩家的一句话世界观：${String(seed == null ? '' : seed)}`,
    `主角姓名：${i.name || '（玩家没写，请在 hero.name 里起一个）'}；形象：${i.appearance || '（玩家没写）'}`,
    `你是谁（玩家写的身份，可能为空）：${i.identity || '（没写，三个出身自由设计）'}`,
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 编年史压缩：把若干回合压成 ≤300 字一章，输出 {summary}。
function buildChapterMessages(state, events) {
  const system = [
    '你是「无限世界」的编年史官，只输出一个 JSON 对象：{"summary":"不超过 300 字的一章摘要"}。',
    '把给定的若干回合压缩成一段连贯的中文编年史，保留关键转折与人物，不要编造未发生之事，不要输出解释文字。',
  ].join('\n');
  const lines = (events || [])
    .map((e) => `#${e.turn}（第${e.life}世）行动：${e.action} / ${e.narration || ''}`)
    .join('\n');
  const user = `以下是需要压缩的回合记录：\n${lines || '（无）'}\n\n请输出 {"summary":"..."}。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 新顶点：玩家不可见，输出一个新的 apex（不含 achievedAt / generation，由引擎补齐）。
function buildApexMessages(state) {
  const system = [
    '你是「无限世界」的隐藏目标设计师，只输出一个 JSON 对象，不要解释文字。',
    '为这个世界设计一个新的、玩家不可见的长期隐藏目标（apex）。',
    '输出：{"title":...,"hint":...,"condition":{"attrs":{"声望":N}}}，可加 "npc":{"name":...,"minAttitude":M}。',
    'condition.attrs 的键只能是 体魄/心智/魅力/气运/声望/资源；阈值应高于当前属性、可达但需长期经营。',
    'hint 是一句可借传闻 / 机会 / NPC 态度暗示的线索，不要直接写出条件本身。',
  ].join('\n');
  const user = [
    section('世界设定', worldBibleText(state.bible)),
    section('当前属性', characterText(state)),
    section('上一代隐藏目标（仅作避免重复之参考，勿复述给玩家）',
      `title：${(state.apex && state.apex.title) || ''}；generation：${(state.apex && state.apex.generation) || 1}`),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 前世墓志铭：角色死亡时额外调用一次（回合模型），据本世经历写 ≤80 字墓志铭。
// 只输出 {epitaph}；不含 apex / Key 等内部信息。
function buildEpitaphMessages(state, info) {
  const i = info || {};
  const system = [
    '你是「无限世界」的墓志铭执笔人，只输出一个 JSON 对象：{"epitaph":"不超过 80 字的一段墓志铭"}。',
    '用克制、苍凉的笔调，为刚结束的这一世写一段墓志铭：点出此人的名字、走过的地方或做过的事、以及结局，',
    '像刻在石上的短文，不要解释、不要评价玩法、不要点破任何隐藏目标、不要输出多余字段。',
  ].join('\n');
  const user = [
    section('本世', `第${i.life}世 · ${i.name || '无名旅人'}；走过 ${i.turns} 个回合；终于「${i.cause || '力竭'}」。`),
    section('此世行迹', recentText(state)),
    section('编年史', chronicleText(state)),
    section('角色', characterText(state)),
    '请据本世经历写一段 ≤80 字的墓志铭，只输出 {"epitaph":"..."}。',
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 新一世开场：重生时额外调用一次（回合模型），据世界设定 / 上一世墓志铭 / facts / npcAttitude
// 写 150~300 字的「新一世开场」。只输出 {opening}；不含 apex / Key 等内部信息。
function buildRebirthOpeningMessages(state, info) {
  const i = info || {};
  const s = state || {};
  const factTexts = (Array.isArray(s.facts) ? s.facts : [])
    .map((f) => (f && typeof f.text === 'string' ? f.text : ''))
    .filter(Boolean);
  const npcLines = Object.entries((s.npcAttitude && typeof s.npcAttitude === 'object') ? s.npcAttitude : {})
    .map(([k, v]) => `${k}:${v}`)
    .join(' ') || '（无人还记得）';
  const system = [
    '你是「无限世界」的新一世开场执笔人，只输出一个 JSON 对象：{"opening":"150~300 字的一段开场叙事"}。',
    '用第二人称「你」，写这一世如何重新出现在同一个世界里，笔调克制、苍凉，像一个世界在延续而非重开。',
    '必须写清四件事，缺一不可：',
    '  ① 新身份（新的名字与形象）以什么方式、在什么地方出现在这个世界；',
    '  ② 距上一世过去了多久——由你自行决定，几天、几月或几年都可以，但要写明，并与世界的时间尺度相符；',
    '  ③ 世界因上一世发生了什么可见变化（某项规矩更紧、某处多了或少了一样东西、某人的处境被改写），不得与已确立的事实矛盾；',
    '  ④ 有没有人隐约记得你：用某个 NPC 一瞬的迟疑、一句说了一半的话或一点微妙态度暗示，不要明说「记得上一世」，也不要让任何人叫破重生。',
    '铁律：',
    '- 不改写、不否定锁定的世界设定与【已确立的事实】；叙事必须与【时与地】一致。',
    '- 不点破、不命名、不解释任何隐藏目标，不要出现「游戏」「玩家」「重生机制」等出戏字眼；',
    '- 不要写「终章」「完结」，也不要写成任务或目标；',
    '- 只输出 {"opening":"..."}，不要解释、不要多余字段、不要 Markdown。',
  ].join('\n');
  const user = [
    section('世界设定', worldBibleText(s.bible)),
    section('时与地', timePlaceText(s)),
    section('已确立的事实（叙事必须遵守，不得改写）',
      factTexts.length ? bulletList(factTexts) : '（尚无）'),
    section('人们对你的态度（npcAttitude）', npcLines),
    section('上一世',
      `第${i.prevLife || Math.max(1, (s.life || 2) - 1)}世 · ${i.prevName || '无名旅人'}；终于「${i.cause || '力竭'}」。`),
    section('上一世墓志铭', i.epitaph || '（无）'),
    section('新一世的身份',
      `第${s.life || i.life || 2}世；名字：${i.name || (s.character && s.character.name) || '无名旅人'}；` +
      `形象：${i.appearance || (s.character && s.character.appearance) || ''}`),
    '请据此写一段 150~300 字的「新一世开场」，只输出 {"opening":"..."}。',
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 玩家点「灵感」：只据玩家此刻已看到的局面给下一步行动建议，绝不掺入 NPC 私密档案 /
// 规则 / apex / 事件计划等内部信息。纯函数，单独导出便于单测。
// 后台总结玩家画像：只根据玩家亲手写的行动归纳，system 固定、user 给既有总结 / 六维 / 最近行动。
function buildProfileMessages(profile) {
  const p = profile && typeof profile === 'object' && !Array.isArray(profile) ? profile : {};
  const view = profiles.publicProfile(p);
  const system = [
    '你在为一位文字冒险游戏的玩家画像。根据他最近亲手写下的行动，总结他是什么样的玩家。只输出 JSON：',
    '{"summary":"≤120 字，用第二人称『你』描述行事风格、偏好和习惯",',
    '"traits":["≤6 个玩法标签，每个 ≤8 字，如『先观察后动手』『爱结交人』『喜欢感情线』"],',
    '"wants":"≤60 字，他通常想要什么样的剧情"}。',
    '只根据给出的行动归纳，不要编造；不要写露骨内容。',
  ].join('');
  const prevSummary = typeof p.summary === 'string' && p.summary.trim() ? p.summary : '无';
  const prevTraits = Array.isArray(p.traits) && p.traits.length ? p.traits.join('、') : '无';
  const dims = Object.keys(view.dims)
    .map((d) => `${d}${view.dims[d]}`)
    .join('、');
  const actions = (Array.isArray(p.recentActions) ? p.recentActions : [])
    .slice(-30)
    .map((a) => {
      const genre = a && typeof a.genre === 'string' ? a.genre : '';
      const title = a && typeof a.title === 'string' ? a.title : '';
      const text = a && typeof a.text === 'string' ? a.text : '';
      return `[${genre}·${title}] ${text}`;
    })
    .join('\n');
  const user = [
    section('之前的总结和标签', `总结：${prevSummary}\n标签：${prevTraits}`),
    section('六维倾向', dims),
    section('最近亲手写下的行动', actions || '无'),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 给「这位玩家的习惯」那段用的文字：总结 + 标签 + 六维里最高的两项。
function profileHabitsText(profile) {
  const parts = [];
  if (typeof profile.summary === 'string' && profile.summary.trim()) parts.push(profile.summary);
  if (Array.isArray(profile.traits) && profile.traits.length) parts.push(profile.traits.join('、'));
  const dims = profile.dims && typeof profile.dims === 'object' ? profile.dims : {};
  const top2 = Object.keys(dims)
    .map((k) => [k, Number(dims[k]) || 0])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k, v]) => `${k}${v}`);
  if (top2.length) parts.push(`倾向最高：${top2.join('、')}`);
  return parts.join('\n');
}

function buildSuggestMessages(state, opts) {
  const s = state || {};
  const b = s.bible || {};
  const avoid = Array.isArray(opts && opts.avoid) ? opts.avoid : [];
  const profile = opts && opts.profile;
  // 只有画像 ready 才加内容；否则 system / user 与不带画像时逐字一致。
  const useProfile = !!(profile && profile.ready);
  const systemLines = [
    '你是这个故事的旁观参谋。根据下面玩家此刻看到的局面，给主角 3 条下一步可以做的具体行动建议。要求：',
    '· 每条是一句以主角视角写的行动（不要以「你」或「我」开头，直接写动作，例如「顺着声音迎上去，看看巷里追过来的是什么人」），12~36 个汉字；',
    '· 三条方向明显不同：一条大胆冒险、一条谨慎稳妥、一条借人/用计（拉拢、交易、设局）；',
    '· 必须贴合当前地点、时间、在场的人和物、刚发生的事，不要泛泛的「环顾四周」；',
    '· 只能根据下面给出的已发生内容推测，不要编造玩家还不知道的秘密或未来剧情；',
    '· 不要写露骨的性内容，不要写选择题或解释；',
    '· 不要和【已经给过的建议】重复或换个说法重复；',
    '· 只输出一个 JSON 对象：{"suggestions":["…","…","…"]}。',
  ];
  const suggestNote = genreNote(SUGGEST_NOTES, s);
  if (suggestNote) systemLines.splice(systemLines.length - 1, 0, '· ' + suggestNote);
  if (useProfile) {
    systemLines.splice(
      systemLines.length - 1,
      0,
      '· 第一条建议写这位玩家最可能想做的事（贴合他的习惯和刚发生的事），另外两条给不同方向的选择',
    );
  }
  const system = systemLines.join('\n');
  const recent = Array.isArray(s.recent) ? s.recent.slice(-2) : [];
  let happened;
  if (recent.length) {
    happened = recent.map((r) => {
      const narr = String((r && r.narration) || '').slice(-900);
      return `行动：${(r && r.action) || ''} / 叙事：${narr}`;
    }).join('\n');
  } else {
    happened = (b.start && b.start.situation) || '';
  }
  const userSections = [
    section('世界', `标题：${b.title || ''}\n基调：${b.tone || ''}`),
    section('主角', characterText(s)),
    section('此刻', timePlaceText(s)),
    section('刚发生的事', happened),
    section('已经给过的建议', avoid.length ? avoid.map((x) => String(x)).join('\n') : '无'),
  ];
  if (useProfile) userSections.push(section('这位玩家的习惯', profileHabitsText(profile)));
  const user = userSections.join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}


// ---- 修仙：主角的金手指（state.edge，私有作者笔记，绝不公开） ----
// 金手指的进度（私有）：shown = 正文里已经露过面；learned = 主角已经摸清的规律序号（edge.rules 的下标）。由记账写入。
function edgeProgress(state) {
  const edge = edgeOf(state);
  const rules = edge && Array.isArray(edge.rules) ? edge.rules.filter((r) => typeof r === 'string' && r.trim()).map((r) => r.trim()) : [];
  const p = state && state.edgeProgress && typeof state.edgeProgress === 'object' ? state.edgeProgress : {};
  const learned = Array.isArray(p.learned) ? p.learned.filter((i) => Number.isSafeInteger(i) && i >= 0 && i < rules.length) : [];
  return { rules, learned, shown: !!p.shown };
}

// 金手指目前只有修仙题材用（建世界只在修仙时生成）；改了题材的老世界不再带它。
function edgeOf(state) {
  if (normalizeGenre(state && state.genre) !== 'xuanhuan') return null;
  const e = state && state.edge;
  if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.name !== 'string' || !e.name.trim()) return null;
  return e;
}

function edgeNotesText(edge) {
  const rules = Array.isArray(edge.rules) ? edge.rules.filter((r) => typeof r === 'string' && r.trim()) : [];
  return [
    `${edge.name}：最初看上去是${edge.look || '（未写）'}`,
    rules.length ? `隐藏规律（由浅到深）：${rules.join('；')}` : '',
    edge.cost ? `代价或限制：${edge.cost}` : '',
    edge.secret ? `不能让人知道的原因：${edge.secret}` : '',
  ].filter(Boolean).join('\n');
}

function genreNote(map, state) {
  const g = normalizeGenre(state && state.genre);
  return (map && typeof map[g] === 'string') ? map[g] : '';
}

// ---- 叙事 v3：隐藏大纲（作者自用，绝不给玩家看） ----
// 互动连载：玩家扮演主角、每回合决定主角做什么，所以大纲只写每章的戏剧目标和要揭开的东西，
// 不写死主角的行动；章卡只写读者能感知的信号，不写作者的内部真相。措辞为本项目自写。
const OUTLINE_RULES = [
  '你在为一部互动连载小说做作者自用的隐藏大纲。读者扮演主角，每回合决定主角做什么，作者接着写正文；这部书写完会整理成小说给别人读。',
  '所以大纲要写清每一章的戏剧目标、阻力和要揭开的东西，但不要写死主角的具体行动——读者走到哪，作者就从那里接着写。',
  '先定一卷的节拍：开卷让读者期待什么（promise）→ 一件不可逆的起因事件（catalyst）→ 三次一次比一次狠的危机（crises）→ 中段反转（midpoint）→ 卷末最低谷（low）→ 卷末兑现（payoff）和留给下一卷的钩子（hook）。',
  '再给前 3 章各一张章卡：title（≤10 字）、goal（本章戏剧目标）、start（起点情形）、beats（2~4 个可能的推进节点）、end（可能的终点）、question（章末留给读者的问题）、avoid（本章不要做的事，≤3 条）。一章大约写 4~6 回合。',
  '章卡只写读者能感知到的信号（如「老者举动反常」），不写作者知道的内部真相（如「老者是隐藏高手」）；真相只写进 core_truth。节点是建议不是必须。',
  '主线冲突要清楚，悬念要能一步步回收，主角要有变化；第一章就要有具体的事情发生，不要用整章铺垫设定。',
  '只输出 JSON：{"premise":"一句话主线","core_truth":"贯穿全书的核心谜底","hero_arc":"主角的成长线","volume":{"title","promise","catalyst","crises":["…","…","…"],"midpoint","low","payoff","hook"},"chapters":[{"title","goal","start","beats":["…"],"end","question","avoid":["…"]}]}',
].join('\n');

function buildOutlineMessages(state, opts) {
  const s = state || {};
  const b = s.bible || {};
  const c = s.character || {};
  const pro = b.prologue || {};
  const npcLines = (Array.isArray(b.npcs) ? b.npcs : [])
    .filter((n) => n && n.name)
    .map((n) => `${n.name}（${n.role || ''}）：${n.desc || ''}${n.want ? `；想要：${n.want}` : ''}${n.voice ? `；说话：${n.voice}` : ''}`)
    .join('\n');
  const history = opts && opts.history && typeof opts.history.text === 'string' ? opts.history.text : '';
  const user = [
    section('设定（作者笔记）', [
      `书名：${b.title || ''}；基调：${b.tone || ''}；题材：${s.genre || ''}`,
      `世界规则：${(b.rules || []).join('；')}`,
      `地点：${(b.places || []).map((p) => `${p.name}（${p.desc || ''}）`).join('；')}`,
      `势力：${(b.factions || []).map((f) => `${f.name}（${f.desc || ''}；${f.stance || ''}）`).join('；')}`,
    ].join('\n')),
    section('人物（含隐秘想法，作者笔记）', npcLines || '（暂无）'),
    section('主角', `${c.name || '无名旅人'}（${c.appearance || ''}）。${pro.me || ''} ${pro.goal || ''}`.trim()),
    section('开场', (b.start && b.start.situation) || ''),
  ];
  const edge = edgeOf(s);
  if (edge) user.push(section('主角的金手指（作者笔记）', edgeNotesText(edge)));
  if (history) {
    user.push(section('已经发生的故事（读者都读过）', history));
    user.push('这是一个已经开始的故事：大纲要从眼下接着规划，第 1 张章卡就是正在进行的这一章，不要推翻已经发生的事。');
  }
  const note = genreNote(OUTLINE_NOTES, s);
  return [
    { role: 'system', content: note ? OUTLINE_RULES + '\n' + note : OUTLINE_RULES },
    { role: 'user', content: user.join('\n\n') },
  ];
}

// ---- 叙事 v3：读者读过 / 没读过的事实 ----
// 保守判定：事实里被「」『』“”包住的片段原样出现在可见正文里就算读过；否则看汉字/数字的二字组
// （bigram）有多少出现在可见正文里，至少四成才算读过（用真实存档校准）。抽不出 3 个二字组时要求整句原样出现。
function factBigrams(text) {
  const chars = String(text == null ? '' : text).replace(/[^\u4e00-\u9fff0-9０-９A-Za-z]/g, '');
  const grams = new Set();
  for (let i = 0; i + 2 <= chars.length; i++) grams.add(chars.slice(i, i + 2));
  return { chars, grams: Array.from(grams) };
}

function factSeen(text, visibleText) {
  const v = String(visibleText == null ? '' : visibleText);
  const t = String(text == null ? '' : text).trim();
  if (!v || !t) return false;
  const quoted = (t.match(/[「『“]([^」』”]{2,})[」』”]/g) || []).map((q) => q.slice(1, -1));
  if (quoted.some((q) => v.includes(q))) return true;
  const { chars, grams } = factBigrams(t);
  if (grams.length < 3) return chars.length > 0 && v.includes(chars);
  let hits = 0;
  for (const g of grams) if (v.includes(g)) hits++;
  return hits / grams.length >= 0.4;
}

function splitFacts(facts, visibleText) {
  const seen = [];
  const unseen = [];
  for (const f of Array.isArray(facts) ? facts : []) {
    const t = f && typeof f === 'object' ? f.text : f;
    if (typeof t !== 'string' || !t.trim()) continue;
    (factSeen(t, visibleText) ? seen : unseen).push(t.trim());
  }
  return { seen, unseen };
}

// ---- 叙事 v3：写正文（五段任务书）与记账（从正文里抽字段） ----
// 写正文的模型只看作者身份 + 写作准则（system）和一份大白话任务书（user），只输出纯正文；
// 数值、物品、线索、档案这些能由程序校验的东西，交给写完之后的记账调用。措辞为本项目自写。
const WRITER_RULES = [
  '1. 用第二人称「你」写主角。每节一般 800~1200 字，最长不超过 1400 字（题材文风对篇幅另有要求时按文风）；写成连贯的场景：有动作、有对话、有主角的心思和判断。',
  '2. 读者这回合的行动，这一节就写出结果，并把主角做了什么写进正文里——不看读者的输入也能读懂。世界和人物按各自的情理和意愿回应；不顺利只能是因为情理，不能故意刁难。不替主角做读者没说的重大决定。',
  '3. 一节只推进一件主要的事。优先推进、回收已经出现过的伏笔；新的悬念每节最多一个。',
  '4. 信息只能通过主角的眼睛、耳朵和推理得到（任务书明确允许的章末「另一边」除外）。作者笔记（大纲、设定、人物的隐秘想法）读者看不到，第一次写进正文时要让主角当场经历或得知；「刚才」「那条」「你记得」这类回指只能指前文真写过的东西。',
  '5. 时间、地点、天气和前文连贯；这一节过了多久，要在正文里交代。',
  '6. 每个人物说话有自己的腔调（见【三、相关的人】），台词像真人说话：有停顿、打岔、答非所问，不像辩论。',
  '7. 去掉 AI 腔：段尾不补感悟或总结；少用「缓缓、淡淡、微微、不禁、仿佛」这类副词和比喻；不同人物的反应要不同，别都「瞳孔一缩、心中一凛」；情绪用动作和细节表现，不贴标签；写完一个画面不再补一句解释它的意思；环境描写为情节服务，别每节都写雨、烟、霓虹。',
  '8. 节奏有快有慢：有的段落一句话，有的段落十几句；紧张时句子短，平静时可以舒展。段落之间空一行。',
  '9. 结尾停在一个自然的、需要主角拿主意或让人想往下读的时刻；不出选择题，不做总结，不把冲突全部解决。',
  '10. 只输出正文：不要标题、不要「第几节」、不要说明文字、不要 JSON；也不要写「本章完」「这章收在这里」这类话——收章就是正文自然停住。',
].join('\n');

const FOCUS_TIPS = {
  social: '这一节以人物来往为主：多写对话和对方的反应，让每个人的立场和算盘从话里透出来。',
  private: '这是主角的私人时间：放慢节奏，写感受和细节，不要引入外人打断。',
  rest: '这是休息的时刻：放慢节奏，写身体和心境的变化，不要引入外人打断。',
  intimate: '这是亲密的时刻：按【亲密关系】的规则写，不要引入外人打断。',
  action: '这一节以行动为主：动作和空间关系写清楚，节奏快一些。',
  explore: '这一节以探索为主：写主角看见、听见、摸到的东西，一步一步发现。',
  travel: '这一节在路上：交代怎么去、路上见闻，到了就停在新的场景里。',
};

function npcVoiceLines(state, names) {
  const npcs = (state && state.bible && Array.isArray(state.bible.npcs)) ? state.bible.npcs : [];
  const att = (state && state.npcAttitude) || {};
  return npcs
    .filter((n) => n && n.name && (!names || names.includes(n.name)))
    .map((n) => '- ' + n.name + '：' + (typeof n.rank === 'string' && n.rank.trim() ? '修为' + n.rank.trim() + '；' : '') + '说话' + (n.voice || '（当场确立一种和别人不同的腔调）') +
      (Object.prototype.hasOwnProperty.call(att, n.name) ? '；对主角的态度 ' + att[n.name] : ''));
}

function presentNpcNames(state, action, history) {
  const npcs = (state && state.bible && Array.isArray(state.bible.npcs)) ? state.bible.npcs : [];
  const recentText = String((history && history.text) || '').slice(-3000) + String(action || '');
  return npcs.map((n) => n && n.name).filter((name) => name && recentText.includes(name));
}

function protagonistHints(state) {
  const hints = [];
  const c = (state && state.character) || {};
  const body = c.attrs && Number(c.attrs['体魄']);
  if (Number.isFinite(body) && body <= 2) hints.push('主角伤势沉重（体魄 ' + body + '），行动吃力，正文里要写出来。');
  for (const st of Array.isArray(state && state.stats) ? state.stats : []) {
    if (!st || st.kind === 'rank') continue;
    const warns = Array.isArray(st.warn) ? st.warn : [];
    const v = Number(st.value);
    for (const w of warns) {
      const on = (typeof w.below === 'number' && v <= w.below) || (typeof w.above === 'number' && v >= w.above);
      if (on) hints.push('主角此刻' + w.label + '（' + st.name + ' ' + v + '/' + (st.max || 100) + '）：' + (w.effect || '') + '，正文里要体现。');
    }
  }
  const marks = Array.isArray(c.marks) ? c.marks : [];
  if (marks.length) hints.push('主角身上的处境还在起作用：' + marks.join('；') + '。');
  return hints;
}

// ctx = { action, history, card, outline, chapterTurn, adult, timeSkip, plan, dueThreads }
function buildWriterMessages(state, ctx) {
  const s = state || {};
  const c = ctx || {};
  const b = s.bible || {};
  const hero = (s.character && s.character.name) || '主角';
  const title = b.title || '无题';
  const genre = normalizeGenre(s.genre);
  const xianxia = genre === 'xuanhuan';
  const genreStyle = STORY_STYLES[genre] || '';
  const system = [
    '你是连载小说《' + title + '》的作者。一位读者扮演主角' + hero + '，每回合告诉你主角想做什么，你接着写下一节正文。这部书写完会整理成一本小说给别人读，所以每一节都要经得起当小说读。',
    '【写作准则】',
    WRITER_RULES,
    '【亲密关系】',
    INTIMACY_COMMON + '\n' + (c.adult ? INTIMACY_ADULT_ON : INTIMACY_ADULT_OFF),
    genreStyle ? String(genreStyle).slice(0, 1200) : '',
  ].filter(Boolean).join('\n');

  const card = c.card || null;
  const chapterTurn = Number.isSafeInteger(c.chapterTurn) && c.chapterTurn >= 1 ? c.chapterTurn : 1;
  const action = String(c.action == null ? '' : c.action) || '（读者没有写，顺着眼下的局面自然往下写）';
  const where = timePlaceText(s);

  // 一、这一节要写什么
  const one = [];
  one.push('书名《' + title + '》。' + (card ? '现在写第 ' + card.index + ' 章《' + (card.title || '') + '》的第 ' + chapterTurn + ' 节。' : ''));
  if (card && card.goal) one.push('本章目标：' + card.goal);
  one.push('读者这回合的行动：' + action);
  one.push(xianxia
    ? '这一节就要写出这个行动的结果。篇幅按分量：过场、重复的劳作 300~600 字，一笔带过就跳到下一个有事的时刻；冲突、突破、斗法、金手指的试探 1000~1400 字。写到一个合适的停顿就收住。'
    : '这一节就要写出这个行动的结果。篇幅 800~1200 字，写到一个合适的停顿就收住，不要越写越长。');
  if (c.timeSkip) one.push('这一节是时间跳跃：从此刻起过去' + (c.timeSkip.label || '一段时间') + '，读者对这段时间的打算是「' + (c.timeSkip.plan || '按眼下的日子过下去') + '」。先按时间顺序概写这段日子（有代价、有挫折也有收获），再落到跳跃结束时一个具体的时刻。');
  if (c.timeSkip && xianxia) one.push('读者想借这段时间修炼或突破的，结果必须看得见：要么破了一层（写清从哪一层到哪一层、身体和本事具体变了什么、和同门比现在站在哪），要么卡在瓶颈——但要弄清卡在哪、下一步还缺什么（丹药、功法、机缘或金手指的某条规律）。不要写成「三个月过去，什么都没变」。');

  // 二、故事到这里
  const two = [];
  if (card) {
    const route = [];
    if (card.start) route.push('起点：' + card.start);
    if (card.beats && card.beats.length) route.push('可能的推进：' + card.beats.join('；'));
    if (card.end) route.push('可能的终点：' + card.end);
    if (card.question) route.push('章末留给读者的问题：' + card.question);
    if (card.avoid && card.avoid.length) route.push('本章不要：' + card.avoid.join('；'));
    two.push('本章可能的走向（建议，不是必须；读者走偏了以读者为准）：\n' + route.join('\n'));
  }
  const due = Array.isArray(c.dueThreads) ? c.dueThreads : [];
  const threads = (Array.isArray(s.threads) ? s.threads : []).filter((t) => !due.includes(t));
  if (due.length) two.push('该在这一章收掉的伏笔：' + due.join('；'));
  if (threads.length) two.push('还没解开的线索：' + threads.join('；'));
  const activeCount = Array.isArray(s.threads) ? s.threads.length : 0;
  two.push(activeCount >= 2
    ? '读者手上已经有 ' + activeCount + ' 条没解开的线索，这一节不要再埋新的悬念，先推进或收掉手上的。'
    : '先推进、收掉手上的线索，再考虑埋新的；读者一次记不住太多事。');
  const visible = String((c.history && c.history.text) || '') + '\n' + Object.values(b.prologue || {}).join('\n');
  const facts = splitFacts(s.facts, visible);
  if (facts.seen.length) two.push('读者已经知道的事：' + facts.seen.join('；'));
  if (facts.unseen.length) two.push('背景设定（读者还不知道，第一次写进正文时要交代主角怎么得知）：' + facts.unseen.join('；'));
  if (Array.isArray(b.rules) && b.rules.length) two.push('世界规则（真实成立，但正文没写过之前读者不知道）：' + b.rules.join('；'));
  const edge = edgeOf(s);
  if (edge) {
    const { rules, learned } = edgeProgress(s);
    const known = rules.filter((r, i) => learned.includes(i) || factSeen(r, visible));
    const unknown = rules.filter((r) => !known.includes(r));
    const lines = ['主角的金手指「' + edge.name + '」（作者笔记，主角最大的秘密）：最初看上去是' + (edge.look || '（未写）') + '。'];
    if (known.length) lines.push('主角已经在正文里摸清的规律：' + known.join('；'));
    if (unknown.length) lines.push('还没摸清的规律（读者不知道；读者拿它试探时，一节最多让主角摸清下一条，要写出试探的过程和换来的好处）：' + unknown.join('；'));
    if (!known.length && !(s.edgeProgress && s.edgeProgress.shown) && !factSeen(edge.name, visible)) lines.push('它还没在正文里露过面：这一章里找个自然的时机让它出现（先让主角感知到它的样子，规律留给后面一条条摸）。');
    if (edge.cost) lines.push('代价或限制：' + edge.cost);
    if (edge.secret) lines.push('为什么不能让人知道：' + edge.secret);
    two.push(lines.join('\n'));
  }

  // 三、相关的人
  const names = presentNpcNames(s, c.action, c.history);
  const three = [];
  const npcCtx = npcModule.npcPromptContext(s, c.action);
  if (npcCtx) three.push(npcCtx);
  const voices = npcVoiceLines(s, names.length ? names : null);
  if (voices.length) three.push('说话的腔调和对主角的态度：\n' + voices.join('\n'));
  const heroVoice = s.character && typeof s.character.voice === 'string' ? s.character.voice.trim() : '';
  if (heroVoice) three.push('主角' + hero + '说话：' + heroVoice + '。读者没写主角说什么时，也可以按这个腔调让主角回应，但不替读者做重大决定。');
  three.push('人物的隐秘想法只供作者把握分寸，不能当成读者已知的事写出来。');

  // 四、怎么写更顺
  const four = ['此刻：' + where];
  // 注意：state.focus 是上一回合的分类，不代表这回合的行动，所以不按它给写法提示；
  // 只有玩家在继续上一回合的同一件事（continuing）时沿用上一回合的节奏。
  const focusTip = s.continuing === true ? FOCUS_TIPS[s.focus] : null;
  if (focusTip) four.push(focusTip);
  for (const h of protagonistHints(s)) four.push(h);
  const plan = c.plan || {};
  if (plan.settling && s.activeEvent) four.push('这件事要在这一节有个结果：' + (s.activeEvent.title || '') + '——' + (s.activeEvent.desc || ''));
  const pressure = s.pressure && Number.isSafeInteger(s.pressure.streak) ? s.pressure.streak : 0;
  if (xianxia && pressure >= 3) four.push('主角已经连着 ' + pressure + ' 节只吃亏、没占到一点便宜了：这一节让主角这回合的努力按情理换来一点实打实的回报（一点收获、一次小胜或让对手吃瘪），但不要替读者做决定。');

  // 五、收在哪里
  let five;
  if (card && card.index === 1 && chapterTurn <= 2) {
    five = '这是故事的开头：重在交代主角、处境和身边的人，让读者站稳脚，不急着抛新的谜团。停在一个自然的、需要主角拿主意的时刻。';
  } else if (card && chapterTurn >= 4) {
    five = '本章已经写到第 ' + chapterTurn + ' 节。如果故事自然走到了本章终点，就把这一章收住，落在这个问题上：' + (card.question || '一个让人想翻下一页的问题') + '；还没走到就继续推进，不要硬收。';
    if (xianxia) five += '\n如果这一节收了章，可以在最后加一段「另一边」：单独一行写「* * *」，下面用第三人称写 3~6 句主角不在场时别处发生的事（谁盯上了主角、谁在打主角的算盘、哪里起了异常），只写读者能感知的威胁和动机，不揭核心谜底。这一章已经写过就不要再写。';
  } else {
    five = '停在一个自然的、需要主角拿主意或让人想往下读的时刻。';
  }

  const user = [
    section('本世前文（读者都读过，按时间顺序）', (c.history && c.history.text) || (b.start && b.start.situation) || '（故事刚开始）'),
    section('二、故事到这里', two.join('\n') || '（没有需要特别交代的）'),
    section('三、相关的人', three.join('\n')),
    section('四、怎么写更顺', four.join('\n')),
    section('五、收在哪里', five),
    section('一、这一节要写什么', one.join('\n')),
  ].join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// 记账：复用回合输出格式里的字段说明，去掉所有关于「怎么写正文」的行（v2 原文一字不改）。
const LEDGER_DROP = [
  /^\{"narration":/,
  /^- narration /,
  /^- 叙事必须与【时与地】/,
  /narration 永远是输出的第一个字段/,
  /narration 仍第一/,
  /正文优先、第一个字段/,
  /narration 里必须写出/,
];
function ledgerFormat() {
  const lines = TURN_OUTPUT_FORMAT.split('\n').filter((line) => !LEDGER_DROP.some((re) => re.test(line)));
  // 第一行原是 {"narration":...,  换成 {，保持 JSON 示例完整。
  return lines.map((line, i) => (i === 1 && !line.startsWith('{') ? '{' + line.trimStart() : line)).join('\n');
}
const LEDGER_EXTRA = [
  '- 叙事 v3：threads_add 每回合最多 1 条，只记正文明确留下、值得追下去的新悬念（同一件事的几个细节算一条，已有线索的进展不算新线索）；每条可以是字符串，也可以是 {"text":"≤20 字","due":1~3}，due 表示预计几章内回收（缺省 2）。',
  '- 叙事 v3：rumor 一律不填（坊间传闻先关掉，玩家记不住太多东西）。',
  '- 叙事 v3：marks_add 只记会一直影响后面剧情的处境（受伤、欠人情、被盯上、被通缉之类），一时的情绪、普通的小事不算印记；大多数回合不该有新印记。',
  '- 叙事 v3：未解之谜同时最多 3 条，已满就不要再填 threads_add；正文里推进或解开了某条线索时，及时用 threads_resolve 收掉。',
  '- 叙事 v3：时间用 "clock_end":{"period":"清晨|午后|黄昏|深夜","days_later":0} 记——正文结尾时是哪个时段，比【时与地】里的那天晚了几天（同一天写 0；过了一夜到第二天写 1）。正文里天黑了、到了夜里、第二天一早这类变化一定要记上；正文没写时间变化就照抄【时与地】的时段、days_later 写 0。有了 clock_end 就不用写 time_passes。',
  '- "chapter":{"beats_done":["本章卡里这一节已经达成的节点原文"],"chapter_end":false}：正文已经把本章收住（落在章末问题上、告一段落）时 chapter_end 写 true。',
].join('\n');

// 修仙题材的记账附加：主角这节是吃亏还是占到便宜（供「压了要扬」的提醒）、境界变化、灵感「稳进险」、章末另一边。
const XIANXIA_LEDGER = [
  '- 修仙：另给 "pressure":"down|up|none"——这一节主角主要是吃亏受压（被欺负、被克扣、受挫、白忙）写 down，占到便宜（有收获、小胜、对手吃瘪、修为或金手指有进展）写 up，两样都有按结尾时的处境定，都没有写 none。',
  '- 修仙：正文明确写到主角破了一层或升了一阶（比如从凡人引气入体到练气一层、从一层到二层），就在 stats_diff 里给「境界」类阶梯 +1；没写明就不动。修炼、施法、吃丹药让灵力这类数值槽明显变多变少的，也写进 stats_diff。',
  '- 修仙：suggestions ' + (SUGGEST_NOTES.xuanhuan || ''),
  '- 修仙：正文里单独一行「* * *」之后是主角不在场的「另一边」，主角不知道这些：不要据此改主角的物品、印记、属性或人物对主角的态度；读者知道了的新威胁可以按规则记成一条线索。',
].join('\n');

function xianxiaEdgeLedgerText(state) {
  const edge = edgeOf(state);
  if (!edge) return '';
  const { rules, learned, shown } = edgeProgress(state);
  const lines = ['「' + edge.name + '」：' + (edge.look || '') + (shown ? '（正文里已经露过面）' : '（正文里还没露过面）')];
  rules.forEach((r, i) => { if (!learned.includes(i)) lines.push((i + 1) + '. ' + r); });
  lines.push('正文第一次让主角感知或用到它，给 "edge_shown":true；正文里主角明确试出、弄懂了上面某条规律，给 "edge_learned":[序号]（只填这里列出的序号，没弄懂就不给）。');
  return lines.join('\n');
}

// ctx = { action, prose, card, chapterTurn, timeSkip, plan }
function buildLedgerMessages(state, ctx) {
  const s = state || {};
  const c = ctx || {};
  const plan = c.plan || {};
  const system = [
    '下面这段正文已经写好、读者已经读到。你的工作是按正文记账：只记录正文里真实发生的事，不发明正文没写的东西，也不修改正文。',
    '说明里提到的 narration、叙事、正文，都指【正文】里这段已经写好的文字。只输出一个 JSON 对象。',
    ledgerFormat(),
    LEDGER_EXTRA,
    normalizeGenre(s.genre) === 'xuanhuan' ? XIANXIA_LEDGER : '',
    plan.opening ? '本回合需要开启事件：按正文给出 event。' : '',
    plan.settling ? '本回合需要结算事件：按正文里主角的应对给出 event_check。' : '',
    c.timeSkip ? '本回合是时间跳跃：给出 landing_period（跳跃结束时的时段：清晨 / 午后 / 黄昏 / 深夜），time_passes 不起作用。' : '',
  ].filter(Boolean).join('\n\n');
  const card = c.card;
  const threads = Array.isArray(s.threads) ? s.threads : [];
  const att = Object.entries(s.npcAttitude || {}).map(([k, v]) => k + ':' + v).join(' ');
  const user = [
    section('主角当前状态', characterText(s)),
    statsSectionText(s) ? section('专属状态', statsSectionText(s)) : '',
    section('身上的印记', ((s.character && s.character.marks) || []).join('；') || '无'),
    section('未解之谜（解开时 threads_resolve 的文本必须与这里完全一致）', threads.join('\n') || '无'),
    section('人物与态度', att || '无'),
    section('时与地（写正文之前）', timePlaceText(s)),
    card ? section('本章卡', '第 ' + card.index + ' 章《' + (card.title || '') + '》，可能的推进：' + (card.beats || []).join('；') + '；可能的终点：' + (card.end || '')) : '',
    xianxiaEdgeLedgerText(s) ? section('主角的金手指（作者笔记，只用来对照正文记账）', xianxiaEdgeLedgerText(s)) : '',
    section('读者这回合的行动', String(c.action || '（未填写）')),
    section('正文', String(c.prose || '')),
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// ---- 叙事 v3：章节收尾 ----
function chapterRecordsText(records) {
  return (Array.isArray(records) ? records : [])
    .map((e) => '第 ' + e.turn + ' 回合　你：' + (e.action || '（未填写）') + '\n' + (e.narration || ''))
    .join('\n\n');
}

// 一章写完：章摘要会给玩家看（章节回顾、导出成书的目录），所以只依据正文。
function buildChapterCloseMessages(state, records, card) {
  const s = state || {};
  const b = s.bible || {};
  const idx = s.chapter && s.chapter.index ? s.chapter.index : 1;
  const system = [
    '你是连载小说的编辑。下面是刚写完的一章正文，读者都读过。请为这一章做收尾记录，只依据正文，不写正文里没有的东西，不剧透作者的设定。',
    '只输出 JSON：{"title":"≤10 字的章名（可以沿用原章名，也可以按实际内容改得更贴切）","summary":"150~300 字，按发生顺序写清本章发生了什么、人物关系和局面有什么变化","bridge":"≤30 字的承接点：下一章从什么状态接着写"}',
  ].join('\n');
  const user = [
    section('书', '《' + (b.title || '') + '》第 ' + idx + ' 章' + (card && card.title ? '（原章名《' + card.title + '》）' : '')),
    section('本章正文', chapterRecordsText(records) || '（无）'),
  ].join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// 规划下一章：从承接点接着写；读者实际走出来的方向优先，不强行拉回原计划。
function buildNextChapterMessages(state, ctx) {
  const s = state || {};
  const c = ctx || {};
  const o = s.outline || {};
  const v = o.volume || {};
  const nextIndex = (s.chapter && s.chapter.index ? s.chapter.index : 1) + 1;
  const system = [
    '你是这部互动连载小说的作者，正在规划下一章。读者扮演主角，每回合决定主角做什么。',
    '规则：从上一章的承接点接着写；读者实际走出来的方向是真的，不要强行拉回原来的计划，原计划里的后续章卡只作参考；',
    '卷节拍表里已经发生的拍就往下推进；该收的伏笔安排在这一章收掉；章卡只写读者能感知的信号，不写作者的内部真相；节点是建议不是必须；一章大约 4~6 回合。',
    '只输出一张章卡 JSON：{"title":"≤10 字","goal":"本章戏剧目标","start":"起点情形","beats":["2~4 个可能的推进节点"],"end":"可能的终点","question":"章末留给读者的问题","avoid":["本章不要做的事，≤3 条"]}',
    genreNote(OUTLINE_NOTES, s),
  ].filter(Boolean).join('\n');
  const chapters = (Array.isArray(s.chapters) ? s.chapters : [])
    .map((ch) => '第 ' + ch.index + ' 章《' + (ch.title || '') + '》：' + (ch.summary || '') + (ch.bridge ? '（承接：' + ch.bridge + '）' : ''))
    .join('\n');
  const later = (Array.isArray(o.chapters) ? o.chapters : []).filter((card) => card.index >= nextIndex)
    .map((card) => '第 ' + card.index + ' 章《' + card.title + '》：' + card.goal + '；' + (card.beats || []).join('；'))
    .join('\n');
  const user = [
    section('作者笔记', ['主线：' + (o.premise || ''), '核心谜底：' + (o.core_truth || ''), '主角成长：' + (o.hero_arc || ''),
      '卷节拍：承诺 ' + (v.promise || '') + '；起因 ' + (v.catalyst || '') + '；危机 ' + (v.crises || []).join(' / ') + '；中段反转 ' + (v.midpoint || '') + '；最低谷 ' + (v.low || '') + '；兑现 ' + (v.payoff || '') + '；钩子 ' + (v.hook || '')].join('\n')),
    section('已经写完的章', chapters || '（无）'),
    section('最近的正文', chapterRecordsText(c.recentRecords) || '（无）'),
    section('还没解开的线索', (Array.isArray(s.threads) ? s.threads : []).join('；') || '无'),
    edgeOf(s) ? section('主角的金手指（作者笔记）', edgeNotesText(edgeOf(s))) : '',
    (c.dueThreads && c.dueThreads.length) ? section('该在下一章收掉的伏笔', c.dueThreads.join('；')) : '',
    later ? section('原计划里的后续章卡（参考）', later) : '',
    '请规划第 ' + nextIndex + ' 章。',
  ].filter(Boolean).join('\n\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// 解析：去掉 ```json 包裹、截取第一个 { 到最后一个 }；失败返回 null。
function parseJson(text) {
  if (typeof text !== 'string') return null;
  let s = text.trim();
  s = s.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (_) {
    return null;
  }
}

module.exports = {
  edgeOf,
  edgeProgress,
  buildTurnMessages,
  buildWriterMessages,
  buildLedgerMessages,
  buildChapterCloseMessages,
  buildNextChapterMessages,
  WRITER_RULES,
  buildOutlineMessages,
  OUTLINE_RULES,
  factSeen,
  splitFacts,
  buildPrologueMessages,
  buildStatsMessages,
  statsSectionText,
  buildSuggestMessages,
  buildProfileMessages,
  buildItemsInfoMessages,
  buildWorldMessages,
  buildChapterMessages,
  buildApexMessages,
  buildEpitaphMessages,
  buildRebirthOpeningMessages,
  overstepDirective,
  OVERSTEP_FORMS,
  parseJson,
};
