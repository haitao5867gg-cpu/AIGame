'use strict';

const env = require('./env.js');
const { GENRE_STYLES, normalizeGenre } = require('./genres.js');

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
  ' "adult":false}',
  '说明：',
  '- suggestions 固定给 3 条方向明显不同的行动：一条大胆冒险、一条谨慎稳妥、一条借人/用计（拉拢、交易、设局）；',
  '  不要三条都在打听同一件事。',
  '- new_facts 记录本回合新确立的客观事实（≤30 字，0~2 条）：如「城门每日戌时落锁」「顾秋白是76号的人」；',
  '  已确立的事实见【已确立的事实】段落，叙事必须遵守、不得改写；没有新事实就省略该字段，不要复述旧事实。',
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
].join('\n');

// v2 的输出格式：narration 仍为 JSON 第一个字段，正文优先；只改这两行，其余说明原样保留。
const V2_NARRATION_EXAMPLE = '{"narration":"第二人称叙事：段落短、段数多，一段只写一个动作、一个念头或一句对白，通常 20~70 字；关键场景 8~20 段、600~1200 字，过场 3~6 段、150~300 字，段间用空行分隔",';
const V2_NARRATION_NOTES = '- narration 是输出的第一个字段，先把 narration 写完整，再写其他字段：段落短、段数多，一段只写一个动作、一个念头或一句对白，通常 20~70 字；关键场景 8~20 段、600~1200 字，过场 3~6 段、150~300 字，对白单独成段。';
const V2_TURN_OUTPUT_FORMAT = TURN_OUTPUT_FORMAT.split(NL).flatMap((line) => {
  if (line.startsWith('{"narration":')) return [V2_NARRATION_EXAMPLE];
  if (line.startsWith('- narration 必须分成 2~4 个短段落')) return [V2_NARRATION_NOTES];
  return [line];
}).join(NL);

const WORLD_OUTPUT_FORMAT = [
  '输出 JSON：',
  '{"genre":"xuanhuan|urban|game|horror|cozy|general",',
  ' "bible":{"title":...,"tone":...,"rules":[str],"places":[{name,desc}],',
  ' "factions":[{name,desc,stance}],"npcs":[{name,role,desc,want,voice}],',
  ' "start":{"place","situation","items":[str x2~3],"items_info":{"物品名":{"desc","type"}},"facts":[str x2~3]},',
  ' "prologue":{"world":"…","me":"…","goal":"…","now":"…"},"eventThemes":[str x6]},',
  ' "apex":{"title":...,"hint":...,"condition":{"attrs":{"声望":30}}}}',
  'genre 按玩家那句话世界观和 bible 的题材判断，只取 xuanhuan / urban / game / horror / cozy / general 之一；',
  '要求：名词具体、有张力、起点明确；eventThemes 给 6 个符合世界观的大事类型；',
  'bible.prologue 是给玩家看的「序章」，四段都要用通俗的话、不堆专有名词；首次提到的地名、人名顺带一句交代（是谁、什么地方）：',
  '  world = 这个世界是什么样的（3~4 句：时代、势力格局、力量体系、氛围）；',
  '  me = 你是谁（姓名或称呼 / 身份、出身、现在的处境、有什么本事或短板，2~3 句，用第二人称「你」）；',
  '  goal = 你想要什么、长期目标（1~2 句）；',
  '  now = 眼下的处境和该做什么（1~2 句，自然引出第一幕，与 start.situation 一致）；',
  'npcs[].want 写清「这个人想要什么」（能驱使他的欲望/立场），每个 NPC 各不相同，用于让反应有差异；',
  'npcs[].voice 写「这个人的说话方式」，≤20 字（如「短句铁令，从不解释」「哄劝式隐喻，句句带笑」「记账式冷语，只报数目」），' +
  '  voice 只描述风格（句式长短、语气、用词习惯），不要写成『句尾加某个字』『每句都以…结尾』这类机械规则；' +
  '  每个 NPC 必须明显不同：句式长短、用词、语气、是否解释、是否带隐喻都要拉开差异，作为台词的语言指纹；',
  'start.items 给 2~3 个符合世界观的起始物品（角色开局随身携带，名称 ≤12 字，如「一封无字信」「旧铜灯」）；',
  'start.items_info 给 start.items 里每个物品 1~2 句介绍和类型，键与物品名一致：',
  '  desc ≤60 字（是什么、有什么用或特别之处、来历），type ≤6 字（法器/丹药/兵器/杂物/信物/文书…，可选）；',
  'start.facts 给 2~3 条关键时间/规则事实（每条 ≤30 字，如「满月在三日后」「城门每日戌时落锁」「报出真名会被登记」），',
  '  用来锁定开局时间线与世界规则（例如满月究竟是哪天）；这些会被写入世界事实账本，之后的叙事必须遵守、不得改写或前后矛盾；',
  'apex 是玩家不可见的隐藏长期目标，condition.attrs 用 体魄/心智/魅力/气运/声望/资源 中的键与可达阈值。',
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

// 回合：返回 OpenAI chat/completions 的 messages 数组。
// opts.adult：本回合是否使用「成人模式开」档提示词（由编排层按主人总开关 + 该玩家开关计算）。
function buildTurnMessages(state, plan, action, opts) {
  const p = plan || {};
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
  sys.push(section('锁定的世界设定（只读，不得改写）', worldBibleText(state.bible)));
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
  sys.push(section('时与地（叙事一致性）',
    '叙事里的所处地点、白昼/黑夜、所在日子必须与【时与地】一致，不要凭空跳到别处或别的时段；' +
    '时间只随回合缓慢推进，不可一夜之间改换季节。'));

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
    '请据此写出本回合叙事与提议，只输出 JSON。',
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
    `主角姓名：${i.name || '（由玩家稍后决定）'}；形象：${i.appearance || ''}`,
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
  buildTurnMessages,
  buildPrologueMessages,
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
