# 无限世界 · 设计规格 v0.1

网页版文字 RPG。玩家一句话定世界观 → AI 生成世界 → 每轮自由输入行动 → AI 写叙事并**提议**状态变化 → 后端确定性引擎校验并写入状态。没有主线、没有结局，世界永不结束。

## 0. 硬性约束
- Node >= 18，**零第三方 npm 依赖**（只用 node 内置模块：http、fs、path、crypto、node:test）。
- 跨平台：要在 Windows 上运行（路径一律 `path.join`，不要写死 `/`，不用 shell 命令）。
- **铁律：AI 只提议，引擎写状态。** 所有规则、数值、事件调度、死亡判定都在后端；前端只提交行动、只渲染状态。
- API Key 只在后端 `.env`，任何接口都不得返回 Key。
- 数据只追加不删除：删除世界 = 移动到 `data/_trash/`。
- 离线不演化：没有定时器、后台任务，世界只在玩家提交行动时前进。

## 1. 目录结构
```
server.js              入口：读 .env、启动 http、路由
src/env.js             解析 .env（KEY=VALUE，# 注释，不依赖 dotenv）
src/llm.js             调用 OpenAI 兼容 /chat/completions；mock 模式；用量记录
src/store.js           文件存储：原子写（tmp+rename）、jsonl 追加、每个世界一把互斥锁
src/engine.js          纯函数规则引擎：校验提议、应用 diff、事件调度、结算、死亡、顶点
src/prompts.js         所有 prompt 模板
src/game.js            编排：建世界、执行一回合（组装 prompt → llm → 解析 → engine → 存储）
public/index.html      前端单页（块 2 再做）
test/*.test.js         node --test
scripts/autoplay.js    用真模型自动跑 N 轮并输出报告（块 3 再做）
start.cmd              Windows 启动脚本：node server.js
.env.example
```

## 2. 配置（.env）
`LLM_BASE`（如 https://aigw.telecomjs.com/v1）、`LLM_API_KEY`、`LLM_MODEL`（回合用，默认 deepseek-v4.1-flash）、`LLM_MODEL_WORLD`（建世界/写编年史用，默认与 LLM_MODEL 相同）、`LLM_MOCK`（=1 时不联网，返回确定性假数据，测试用）、`LLM_TIMEOUT_MS`（默认 90000）、`LLM_DAILY_TOKEN_LIMIT`（默认 2000000，超过当天拒绝调用并返回明确错误）、`PORT`（默认 8787）、`HOST`（默认 0.0.0.0）、`DATA_DIR`（默认 ./data）。

## 3. 数据模型
`data/worlds/<worldId>/state.json`（每回合原子覆盖写）：
```js
{
  id, createdAt, seed,            // seed = 玩家那一句世界观
  bible: {                        // 开局生成，之后只读
    title, tone, rules:[str], places:[{name,desc}], factions:[{name,desc,stance}],
    npcs:[{name,role,desc}], start:{place, situation},
    eventThemes:[str x6],         // 符合世界观的大事类型，如「魔族入侵」「宫廷政变」
  },
  apex: { title, hint, condition:{ attrs:{声望:30,...}, npc?:{name,minAttitude} }, achievedAt:null, generation:1 },  // 玩家不可见
  life: 1,                        // 第几世
  turn: 0,                        // 全局回合数（跨世累计）
  character: { name, appearance, attrs:{体魄,心智,魅力,气运,声望,资源}, items:[str], alive:true, bornTurn },
  npcAttitude: { [npcName]: -10..10 },
  persona: { 冒险,审慎,共情,权谋,坚韧,秩序 },   // 0..100，初始 50
  nextEventTurn: 8,               // 引擎排程，7~12 随机
  activeEvent: null | { theme, title, desc, startedTurn },
  chronicle: [ { chapter, fromTurn, toTurn, summary } ],   // 每 20 回合压一章
  recent: [ { turn, action, narration } ],                 // 只保留最近 6 条（narration 截 300 字）
  highlightUntilTurn: 0,
}
```
`data/worlds/<id>/events.jsonl`：每回合追加一行完整记录 `{turn, life, action, raw, proposal, applied, rejected:[reasons], narration, event?, death?, apex?, usage, ts}`，永不删除。
`data/usage.jsonl`：每次 LLM 调用一行 `{ts, model, purpose, prompt_tokens, completion_tokens, ms, ok}`。

## 4. 规则引擎（src/engine.js，全部纯函数，必须有单元测试）
- 属性白名单：体魄 心智 魅力 气运 声望 资源。初始各 5；建角时玩家可额外分配 6 点（每项最多 +3），不传则平均。
- `validateProposal(state, p)` → `{applied, rejected}`：
  - `state_diff` 只接受白名单字段，非整数取整；单项夹在 [-2, +1]（正向最多 +1）；**普通回合正向**变化总和 ≤ 2（超出时按顺序截断）；负向不限总和但单项仍 ≤ 2（事件结算不受此限）。
  - 收益递减：普通回合每个正向 +1 以概率 `p=clamp((30-当前值)/25, 0.1, 1)` 生效（用注入的 rng），未生效的静默丢弃并记入 rejected（内部原因，不进公开结果）；事件结算不受此限。
  - 属性下限 0、上限 40；到顶的增长直接丢弃（叙事照常）。
  - `items_add` 每回合最多 2 个，每个 ≤ 12 字；`items_remove` 只能移除已拥有的。
  - `npc_attitude` 只能针对 bible.npcs 里存在或叙事里新出现的人名，单人每回合 ±2，夹在 [-10, 10]；新 NPC 自动加入 npcAttitude。
  - `persona_tags` 只接受 6 个维度名，每个命中 +1，其他未命中维度向 50 回归 0.2，夹在 [0,100]。
  - 叙事长度 10~1200 字，超出截断，过短判为无效回合（不推进 turn，返回错误让前端重试）。
- 世界性事件：bible.eventThemes 少于 4 个时（建世界）用通用主题「天灾、瘟疫、战乱、权力更迭、神秘来客、资源枯竭」补齐；引擎开启事件时主题为空也用它们兜底。`turn >= nextEventTurn` 且无 activeEvent 时，**本回合开始前**由引擎从主题里随机选一个开启 activeEvent（标题/描述由该回合的 LLM 输出生成）。事件持续本回合，下一回合玩家的行动用于结算。结算：`score = min(相关属性,20)*0.5 + LLM 给的 response_quality(0~3)*4 + 随机 0~8 整数`（相关属性由 event_check.attr 指定 1 个白名单属性）；`>=24 蜕变`（该属性 +3、声望 +2），`>=16 险胜`（+1），`>=9 代价`（体魄 -2、资源 -2），`<9 殒命`。结算后 nextEventTurn = turn + 随机 7~12。事件回合玩家不能选择「什么都不做」：动作为空或明显回避（LLM 判 response_quality=0）仍按公式结算。
- 死亡：体魄降到 0 或事件殒命 → 本世结束。`life+1`，新角色继承上一世声望的 20%（取整），其他属性重置为 5，物品清空，npcAttitude 保留（NPC 记得你），chronicle 追加一条「第 N 世终」。重生需要玩家提交新的名字/形象（接口见下）。
- 隐晦顶点：每回合结束后检查 apex.condition；满足 → 记 achievedAt，highlightUntilTurn = turn+3（prompt 里告诉模型写高光但**不说破**），3 回合后用 LLM_MODEL_WORLD 生成新 apex（generation+1），不通知玩家。apex 绝不出现在任何接口返回里。
- 编年史：turn % 20 == 0 时用 LLM_MODEL_WORLD 把这 20 回合的 events.jsonl 压成 ≤300 字一章。

## 5. Prompt（src/prompts.js）
- 回合 system prompt：宪法（你是叙事引擎、只输出 JSON、第二人称、不替玩家做决定、不说破隐藏目标、不改写世界设定）+ 锁定 bible + 当前角色/物品/NPC 态度 + 最近 2 章编年史 + 最近 6 回合 + （事件中时）事件说明 + （高光期）高光提示 + 隐晦提示（apex.hint，要求只通过传闻/机会/NPC 态度暗示）。总量控制在约 3K token，回合越多不增长。
- 回合输出 JSON 格式（请求时带 `response_format:{type:"json_object"}`）：
```json
{"narration":"...","state_diff":{"心智":1},"items_add":[],"items_remove":[],
 "npc_attitude":{"某人":1},"persona_tags":["冒险"],"suggestions":["...","...","..."],
 "event":{"title":"...","desc":"..."},          // 仅当引擎要求开启事件时
 "event_check":{"attr":"体魄","response_quality":2}}  // 仅当结算事件时
```
- 建世界 prompt：输入玩家一句话，输出 bible + apex JSON。要求名词具体、有张力、起点明确；bible.npcs 每个带 `want`（此人想要什么 / 立场），回合 prompt 里一并带上。
- 回合 system prompt 另含「叙事与状态规则」：大多数回合不改属性（只有实质成长/损失才给 state_diff）、越界要有具体世界内后果（NPC 态度下降 / 声望 -1 / 被盯上 / 被驱逐等）、同一场景或对话最多 3 回合且每回合至少一处变化、每个 NPC 按自身欲望与立场差异化反应。
- 解析：去掉 ```json 包裹、截取第一个 { 到最后一个 }；失败重试 1 次；再失败返回错误，不推进回合。

## 6. HTTP 接口（JSON）
- `GET  /api/health` → `{ok, model, mock}`
- `GET  /api/worlds` → 世界列表 `[{id,title,turn,life,alive,updatedAt}]`
- `POST /api/worlds` `{seed, name, appearance, alloc?}` → 新世界的公开状态
- `GET  /api/worlds/:id` → 公开状态（去掉 apex、去掉 bible 里没必要的内部字段可保留）
- `POST /api/worlds/:id/turn` `{action}` → `{narration, applied, rejected, suggestions, event?, settlement?, death?, state}`
- `POST /api/worlds/:id/rebirth` `{name, appearance}` → 新一世
- `DELETE /api/worlds/:id` → 移入 `_trash`
- `GET  /api/usage` → 今日/累计 token
- 其余路径静态托管 `public/`。同一世界的 turn 请求串行（互斥锁），并发第二个直接排队。
- 错误统一 `{error: "中文说明"}` + 合适状态码。

## 7. 测试要求
`node --test` 全绿，覆盖：env 解析、validateProposal 各边界、事件排程与四档结算、死亡与重生继承、顶点检测与不泄露、mock 模式下完整跑 30 回合（含至少 2 次事件）、接口层（起服务到随机端口，测建世界/回合/删除/公开状态不含 apex 与 key）。

## 8. 前端（public/index.html，单文件，原生 JS，无框架无 CDN）
风格：深色「夜读」主题，宣纸米白字（#e8e2d0）配墨黑背景（#14130f），强调色朱砂红（#c0392b）；正文用衬线字体栈（"Songti SC","Noto Serif SC",serif），UI 用无衬线。手机优先，宽屏时右侧显示角色面板，窄屏时面板折叠成顶部一行属性条 + 可展开抽屉。
页面（同一 HTML 内切换视图，hash 路由 #/、#/new、#/w/<id>）：
1. **首页**：标题「无限世界」+ 一句副标「一句话，开一个永不结束的世界」；已有世界卡片列表（标题、第几世、回合数、最后游玩时间、删除按钮二次确认）；「开新世界」按钮。
2. **新世界**：世界观输入框（多行，placeholder 举例）+ 6 个预设一键填入（如：蒸汽朋克长安 / 末日尸潮下的江南水乡 / 修仙宗门外门杂役 / 深海殖民站 / 民国上海滩谍影 / 被诅咒的中世纪王国）；角色名、形象描述；6 点属性分配（每项 +/− 按钮，最多 +3，显示剩余点数，可「随机」）；「创世」按钮，生成中显示动画文字「世界正在成形…」（建世界约 10~20 秒）。
3. **游戏页**：
   - 顶部：世界标题、第 N 世、第 N 回合。
   - 主区：叙事流（玩家行动用小号灰色「› 你：…」，AI 叙事用正文段落，逐字打出效果约 30 字/帧，可点击跳过）。开局第一段显示 bible.start 的情境。
   - 属性变化以小徽章显示在该段叙事下方（如「心智 +1」绿、「体魄 −2」红）；获得/失去物品、NPC 态度变化同样显示。被拒绝的提议不显示给玩家。
   - 世界性事件：红色横幅置顶「⚠ 事件标题」+ 描述，事件进行时横幅常驻且不可关闭；结算后显示结果档位（蜕变/险胜/代价/殒命）的醒目卡片。
   - 死亡：全屏暗色遮罩「第 N 世 · 终」+ 本世摘要，下面是重生表单（新名字、新形象），提交调用 /rebirth。
   - 底部输入区：多行输入框（Enter 发送，Shift+Enter 换行）+ 发送按钮；输入框上方 3 个「建议行动」小按钮，点击只把文字填进输入框，不直接发送。请求中禁用发送并显示「世界在回应…」。
   - 侧面板/抽屉：6 项属性（数值 + 进度条，上限 40）、物品列表、认识的人（NPC 名 + 态度用 ♥/♡ 或颜色条表示，不显示数字）、性格画像 6 维小条形图、编年史章节（可折叠）、世界设定（地点/势力，可折叠）。
   - 错误（网络失败/模型超时/今日额度用完）以顶部 toast 显示中文说明，输入内容不丢。
- 只调用自家 /api/*；不得出现任何 Key；所有渲染用 textContent 防注入。
- 进入游戏页时 GET /api/worlds/:id 恢复完整叙事：后端需提供 `GET /api/worlds/:id/log?limit=50` 返回最近 N 条 {turn, action, narration, badges, event, settlement}（从 events.jsonl 读取，按需在 server.js 补上该接口）。
