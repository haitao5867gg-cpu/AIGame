# 无限世界（AIGame）架构文档

> 面向接手的新主脑。**接手先读根目录 `HANDOFF.md`**（背景、角色分工、部署、用户规则、进度）；`docs/SPEC.md` 是早期规格，部分已过时，一切以当前代码为准。本文只描述当前代码结构，不含任何密钥、密码、口令、Token 的值。
> 零第三方依赖，Node 原生 `http`；运行期数据全部落在 `DATA_DIR`（默认 `./data`，git 忽略）。前端是 `public/` 下的原生 JS。

## 1. 目录结构

### 顶层
- `server.js` — HTTP 入口：启动、路由、访问控制、静态托管 `public/`、公开状态过滤（剔除 apex / Key）。
- `HANDOFF.md` — 交接文档：项目背景、角色分工、部署流程、用户定下的规则与进度。
- `README.md` — 简短入口，指向 HANDOFF / 本文 / SPEC。
- `.env.example` — 配置变量模板（只有变量名与说明，无真实值）；`.env` 由用户自行维护、不进仓库。
- `.gitignore` — 忽略运行期数据与日志等产物。
- `start.cmd` / `run-server.cmd` — Windows 启动入口（计划任务运行 `run-server.cmd`）。
- `docs/SPEC.md` — 早期规格文档，部分过时，仅作背景。
- `logs/` — 服务端运行日志。
- `.logs/` — 本地任务派发 / 实验脚本日志。
- `reports/` — 本地实验、样图与私密交接说明（不进仓库）。
- `.codebuddy/` — Hy4（CodeBuddy CLI）的任务设置与命令权限。
- `public/` `src/` `scripts/` `test/` — 见下。

### src/
- `access.js` — 访问控制：识别主人 / 登录来客、签名 cookie、访问密码与主人口令、世界归属（`owners.json`）。
- `context.js` — 请求级 AsyncLocalStorage 上下文（`playerId`），让异步调用记用量时能取到当前玩家。
- `engine.js` — 引擎门面：汇总导出 `src/engine/*` 的常量与纯函数。
- `env.js` — 读取 `.env` / 进程环境，提供 `DEFAULTS`、`resolveDataDir` 等配置解析。
- `game.js` — 编排层 `createGame`：建世界、回合、重生、撤回、日志、序章 / 物品介绍 / 章节，串联 prompts / llm / engine / store / images。
- `genres.js` — 题材 → 文风预设（`GENRE_STYLES` 等），供提示词追加文风段。
- `images.js` — 出图：物品 / NPC 头像 / 主角 / 场景（含多参考图）、提供方回退链、画风与图片缓存、静态服务。
- `imgsupervisor.js` — 本地 GPU 画图服务（`imgserver.py`）的进程守护，仅 `local` 出图时启用。
- `llm.js` — 对话模型客户端：OpenAI 兼容 `/chat/completions`、流式 SSE、narration 增量解码、用量统计、mock。
- `prefs.js` — 每玩家偏好（`prefs.json`）：成人开关、朗读参数；主人总开关。
- `prompts.js` — 全部提示词组装：回合、建世界、序章、物品介绍、章节 / 顶点 / 墓志 / 重生开场，及 v1/v2 规则常量。
- `store.js` — 持久化：原子写 `state.json`、追加 `events.jsonl` / `usage.jsonl`、撤回快照、世界列表与回收站。
- `tts.js` — 朗读：Azure SSML 组装、音色 / 情绪、音频缓存与配额。
- `tunnel.js` — 自动启动 Cloudflare 临时隧道（有访问密码且非 mock 时才启动）。

### src/engine/（纯函数规则引擎，不调 LLM、不读写文件、不联网）
- `constants.js` — 常量：属性 / 性格维度、上下限、转折、通用事件主题、各类文本长度上限等。
- `events.js` — 事件排程：`planTurn`（开 / 结算事件、安静模式、转折）、`settleEvent`、`applyRawEffect`。
- `life.js` — 顶点与死亡判定：`apexConditionMet`、`applyDeath`。
- `proposal.js` — `validateProposal`：把模型提议消毒成实际可应用的 diff。
- `turn.js` — `resolveTurn`：单回合主流程（裁定、状态推进、输出）。
- `util.js` — 纯函数工具：`clamp` / `cloneState` / 各类 `normalize*` / 消毒 / 时钟推进。
- `view.js` — `toPublicState`：对外视图，剔除 apex、内部主题与 Key 等敏感字段。
- `world.js` — 建世界 / 属性点分配、初始状态构造。

### public/
- `index.html` — 单页应用骨架（首页 / 新建 / 游戏视图、面板容器）。
- `login.html` — 公网来客登录页（访问密码 / 主人口令）。
- `app.css` — 全部样式（手机 + 桌面响应式）。
- `js/` — 前端原生 JS 模块，见下。

### public/js/
- `core.js` — 公共常量（属性 / 性格 / 预设世界观）、DOM 与请求辅助。
- `game.js` — 主游戏界面：回合输入、叙事渲染、状态、导出世界、朗读提示接线（最大前端模块）。
- `home.js` — 视图路由与首页 / 新建 / 游戏视图切换。
- `images.js` — 物品卡片 / NPC 头像 / 主角 / 场景图的请求、轮询与占位。
- `items.js` — 随身物品介绍卡片（缺介绍时请求 `/items` 补齐）。
- `main.js` — 入口：事件绑定与 `boot()` 启动。
- `panels.js` — 侧栏面板：用量统计、设置（偏好 / 成人 / 题材）、成员与世界收回。
- `prologue.js` — 序章卡片（首次进入 / 重看）。
- `tts.js` — 朗读前端：整回合分段排队播放、播放条、段落高亮、Azure / 浏览器回退与开关。

### scripts/
- `autoplay.js` — 零依赖「AI 玩家」自动试玩 + 跑后评审（只经 HTTP 调接口）。
- `deploy.sh` — Mac 部署：push main → ssh Windows 跑 `restart.ps1` → 健康检查（部署前须用户确认）。
- `hy4-run.sh` — 把单个编码任务派给 Hy4（CodeBuddy CLI）并等待，日志写 `.logs/`。
- `imgserver.py` — 本地 GPU 出图服务（SDXL，OpenAI 风格 `/v1/images/generations` + `/health`）。
- `restart.ps1` — Windows 端拉代码、杀旧 node / cloudflared、重启计划任务。
- `testsum.js` — 测试汇总运行器：`node --test` 跑全部或指定文件，只打印汇总与失败项。

### test/（按主题，均为 `node:test` + `assert/strict`）
访问控制 / 登录 / 归属
- `access.test.js` — 访问判定、密码与 cookie。
- `api-access.test.js` — 接口层访问控制。
- `api-owners.test.js` — 世界归属与收回。
- `host-login.test.js` — 主人登录与口令。
API 核心 / 流式
- `api-core.test.js` — 主要接口的请求 / 响应。
- `stream.test.js` — 流式回合 SSE。
- `scene-api.test.js` — 场景图接口。
引擎 / 规则
- `engine-events.test.js` — 事件排程。
- `engine-ledger.test.js` — 数值台账。
- `engine-legacy.test.js` — 旧规则 / 转折兼容。
- `engine-life.test.js` — 顶点与死亡。
- `engine-proposal.test.js` — 提议消毒。
- `engine-world.test.js` — 建世界。
- `game.test.js` — 编排层回合 / 建世界 / 撤回 / 日志。
提示词 / 叙事 / 文风 / 玩家意图
- `prompts.test.js` — 提示词组装与输出格式。
- `narrative-style.test.js` — 叙事写法版本。
- `genres.test.js` — 题材文风段。
- `player-intent.test.js` — 玩家意图优先与安静模式。
- `dialogue-tics.test.js` — 对白习惯消毒。
- `prologue.test.js` — 序章生成。
出图 / 场景图 / 物品介绍
- `images-core.test.js` — 出图核心与索引。
- `images-providers.test.js` — 各提供方与回退链。
- `images-style.test.js` — 画风生成与缓存。
- `cf-budget.test.js` — Cloudflare 额度与冷却。
- `imgsupervisor.test.js` — 本地画图服务守护。
- `items-info.test.js` — 物品介绍。
- `scene.test.js` — 场景字段消毒。
- `scene-images.test.js` — 场景出图。
- `scene-refs.test.js` — 多参考图收集。
- `scene-wiring.test.js` — 场景接线。
朗读 / TTS
- `tts.test.js` — 朗读主流程。
- `tts-natural.test.js` — SSML 自然度 / 音色情绪。
- `tts-quota.test.js` — 朗读配额。
- `frontend-tts.test.js` — 前端朗读基础。
- `frontend-tts-turn.test.js` — 整回合朗读。
- `frontend-tts-ui.test.js` — 朗读 UI。
前端（public/js 行为）
- `frontend.test.js` — 前端整体。
- `frontend-desktop.test.js` — 桌面视口。
- `frontend-mobile.test.js` — 手机视口。
- `frontend-genre.test.js` — 题材选择 UI。
- `frontend-prologue.test.js` — 序章卡片 UI。
- `frontend-scenes.test.js` — 场景图 UI。
- `frontend-scroll.test.js` — 滚动行为。
配置 / 存储 / 客户端 / 隧道 / 自动试玩
- `env.test.js` — 配置解析。
- `store.test.js` — 持久化与撤回。
- `llm.test.js` — LLM 客户端与增量解码。
- `tunnel.test.js` — 隧道启停。
- `autoplay.test.js` — 自动试玩脚本。

### test/helpers/
- `api-helpers.js` — 起随机端口本地 mock 服务、设临时 `DATA_DIR` / `LLM_MOCK`、请求封装。
- `engine-helpers.js` — 引擎测试夹具：可注入的确定性 rng（LCG）等。
- `images-helpers.js` — 出图测试夹具：临时目录、mock provider、索引读写辅助。

## 2. 主要 HTTP 接口

`route()`（`server.js:259`）先解析 `method` / `pathname`；除下列公开项外，全部要求玩家身份（未登录 `/api/*` 返回 401、页面 GET 302 到 `/login.html`）。带 `:id` 的接口再经 `requireOwner`（`server.js:56`，查 `owners.json`）校验归属。

| 方法 | 路径 | 作用 | 权限 |
|---|---|---|---|
| GET | `/login.html` | 登录页 | 公开 |
| POST | `/api/login` | 登录（访问密码 / 主人口令），成功发签名 cookie | 公开 |
| POST | `/api/logout` | 清除登录 cookie | 公开 |
| GET | `/api/me` | 当前玩家 id / 名字 / 是否主人 / 偏好 | 需登录 |
| POST | `/api/prefs` | 写个人偏好（朗读参数、成人开关）；`adultAllowed` 仅主人可改 | 需登录（总开关仅主人） |
| POST | `/api/tts` | 合成一段朗读音频（成人段落拒绝，回退浏览器朗读） | 需登录 |
| GET | `/api/tts/voices` | 可用音色 / 情绪、是否配置、月度用量 | 需登录 |
| GET | `/api/health` | 健康检查（模型、是否 mock） | 需登录 |
| GET | `/api/usage` | 全局用量 | 需登录 |
| GET | `/api/usage/today` | 今日用量；主人额外得到全局与玩家明细、访问信息、隧道地址 | 需登录（明细仅主人） |
| POST | `/api/admin/claim-worlds` | 把某来客名下世界收回主人 | 仅主人 |
| GET | `/api/worlds` | 列出当前玩家名下世界（按 `ownerOf` 过滤） | 需登录 |
| POST | `/api/worlds` | 建世界并登记归属 | 需登录 |
| POST | `/api/worlds/:id/turn/stream` | 流式回合（`text/event-stream`：`delta` → `result` / `error`） | 需登录 + 归属 |
| POST | `/api/worlds/:id/turn` | 非流式回合 | 需登录 + 归属 |
| GET | `/api/worlds/:id/export` | 导出 `state` + `events` 的 JSON 附件 | 归属 |
| GET | `/api/worlds/:id/prologue` | 给老世界补生成序章 | 归属 |
| GET | `/api/worlds/:id/items` | 补齐并返回物品介绍 | 归属 |
| POST | `/api/worlds/:id/genre` | 手选题材覆盖 | 归属 |
| GET | `/api/worlds/:id/images` | 当前物品 / NPC 图片状态 + 场景图状态 | 归属 |
| GET | `/api/images/:file` | 取图片文件（严格文件名校验、长缓存） | 需登录 |
| GET | `/api/worlds/:id` | 读世界公开状态 | 归属 |
| DELETE | `/api/worlds/:id` | 删除世界（移入回收站）并移除归属 | 归属 |
| GET | `/api/worlds/:id/log` | 回合日志（可带 `limit`） | 归属 |
| POST | `/api/worlds/:id/rebirth` | 重生 | 归属 |
| POST | `/api/worlds/:id/undo` | 撤回上一回合 | 归属 |
| GET / HEAD | 其余路径 | 静态托管 `public/`（`serveStatic`） | 需登录 |
| OPTIONS | 任意 | 预检，返回 204 | 公开 |

## 3. DATA_DIR 下的数据文件与目录

路径均相对 `DATA_DIR`（默认 `./data`）。`store.js` 负责读写，世界 id 经 `assertWorldId` 校验。

- `worlds/<id>/state.json` — 该世界完整存档（角色、属性、物品、事件进度、时钟等），每回合原子覆盖写。
- `worlds/<id>/state.prev.json` — 回合执行前的 `.prev` 快照，供 `undo` 撤回一步（`backupForUndo` / `restoreUndoBackup`）。
- `worlds/<id>/events.jsonl` — 只追加的回合 / 事件日志（含撤销、重生等记录），导出接口会一并打包。
- `images/index.json` — 全局共享图片索引：按 `kind-key` 记录状态、文件名、画风、提示词等，原子写。
- `images/styles.json` — 每个世界统一的画风设定缓存（带版本号），缺画风时由对话模型据 bible 生成一次。
- `images/item-*.jpg` 等 — 实际图片文件（`item` / `npc` / `hero` / `scene`），由 `/api/images/:file` 提供。
- `tts/` — 朗读音频缓存（mp3），按 `TTS_CACHE_MAX_MB` 上限删最旧文件。
- `usage.jsonl` — 全局只追加用量日志：token、出图、朗读、Cloudflare Neurons，按玩家 id 区分（供每日 / 每月限额统计）。
- `access.json` — 访问密码、主人口令、HMAC 密钥与已登记来客；未配置密码时首次启动自动生成并复用。
- `owners.json` — 世界归属表（世界 id → 玩家 id）；无记录的世界默认归主人。
- `prefs.json` — 每玩家偏好与 `_global` 下的主人总开关（成人内容开关、朗读参数）。
- `_trash/` — 删除的世界移入此处（不真删），同名自动加后缀避免覆盖。
- `../backups/<时间戳>/` — 启动前对 `worlds/` 的整目录快照备份（位于 `DATA_DIR` 同级）。

## 4. 回合流程

1. **请求进入**：`server.js` 的 `route()` 解析方法 / 路径，用 `access.playerOf` 从来源 IP 或签名 cookie 得到 `player`，再用 `context.run({ playerId })` 包住整个请求（异步出图 / 用量记账都能取到玩家）。
2. **访问控制 / 归属校验**：公开项之外必须已登录；带 `:id` 的接口经 `requireOwner` 查 `owners.json`，越权返回 404 JSON（流式接口在开流前先校验）。
3. **planTurn**：`engine/events.js` 的 `planTurn(state, {rng})` 决定本回合是否开新事件 / 结算旧事件 / 压编年史 / 注入转折。上回合 `focus ∈ {intimate, private, social, rest}` 或 `continuing` 时进入「安静模式」：不开事件、不注入转折，结算最多顺延 3 回合。
4. **提示词组装**：`prompts.js` 的 `buildTurnMessages(state, plan, action, opts)` 拼 system/user：按 `NARRATIVE_STYLE` 选 v1 / v2（v2 追加【写作手法】与小说化输出格式，v2-3p 改第三人称）；v2 在写作手法段后追加 `genres.js` 的题材文风段；成人模式按 `prefs.adultModeOn`（主人总开关 ∧ 该玩家开关）选 `INTIMACY_ADULT_ON/OFF`；`TURN_RULES` 的「玩家意图优先」要求本回合必须执行玩家行动；`plan.opening` 时追加「第一幕（开场衔接）」段；并拼入 bible、角色、时间地点、近况、编年史、当前物品栏与输出格式（含 `scene` 字段）。建世界 / 序章 / 物品介绍分别由 `buildWorldMessages` / `buildPrologueMessages` / `buildItemsInfoMessages` 组装。
5. **对话模型**：`llm.js` 的 `createClient` 调 OpenAI 兼容 `/chat/completions`；流式走 `completeStream` + `httpChatStream`（SSE），`createNarrationDecoder` 边收边解出 `narration` 增量，由 `server.js` 以 `event: delta` 推给前端，最后 `event: result` / `error`；非流式走 `complete`。`PURPOSES` 区分用途；`LLM_MOCK=1` 时用 `mockFor` 返回固定结构、不联网；用量写 `usage.jsonl`。
6. **引擎裁定**：`engine/turn.js` 的 `resolveTurn` 先用 `proposal.js` 的 `validateProposal` 把模型输出的 JSON 提议消毒成可应用 diff（属性、物品、NPC 态度、场景、`voice_hints`、`focus`、`adult` 等全部 clamp / 白名单校验），再推进状态、结算事件、判定顶点 / 死亡、生成编年史。引擎是纯函数，不调 LLM、不读写文件。
7. **存档与事件日志**：`store.js` 回合前 `backupForUndo` 复制 `state.prev.json`，`saveWorld` 原子覆盖 `state.json`，`appendEvent` 追加 `events.jsonl`，`appendUsage` 追加 `usage.jsonl`；删除移入 `_trash`，撤回用 `.prev` 还原。
8. **出图**：`server.js` 在写库后、锁外 `triggerImages` / `triggerScene` 异步排队。`images.js` 的 `listForState` 汇总主角 + 当前物品 + NPC，`imageKey` 生成共享缓存键，`createImages` 按 `IMAGE_PROVIDER` 回退链逐家尝试（失败冷却后排到最后）；提示词由 `gatewayPrompt` / `localPrompt` / `scenePromptZh` / `scenePromptEn` 生成并译英文，画风缓存 `styles.json`、结果缓存 `index.json`；场景图由 `collectRefs` 收集 ≤4 张已就绪参考图（主角、≤2 NPC、≤1 物品）走多参考图模型，失败落回文生图。Cloudflare 当日 Neurons 达 `CLOUDFLARE_RESERVE_FROM` 后，物品 / 头像 / 主角让给回退链下一家、把额度留给场景图；收到 `daily free allocation` 429 冷却到下一个 UTC 零点。
9. **朗读**：前端 `public/js/tts.js` 按 `voice_hints` 把整回合分段排队；服务端 `tts.js` 的 `buildSsml` / `buildSegmentsSsml` / `segmentInner` 把参数与文本拼成 Azure SSML（`prosody` + `express-as` + `voice`），`/api/tts` 返回 mp3，音频缓存在 `tts/`。每人每日字符上限、Azure 月度额度达停用阈值后回退浏览器 `speechSynthesis`；成人段落只走浏览器朗读。

**近期正文完整保留与旧存档兼容**：`state.recent` 恒为最近 6 条，每条保留引擎已接纳的完整正文，上限 `RECENT_NARRATION_MAX = NARRATION_MAX = 1200`（`engine/constants.js` 中两处上限绑定，避免漂移）；`engine/turn.js` 的 `resolveTurn` 与 `engine/life.js` 的 `applyRebirthOpening` 共用该边界。`events.jsonl` 一直记录完整正文，因此旧存档（正文被截成 300 字）可在编排层补回：`game.js` 的 `restoreRecentNarration(state, events)` 是纯函数，以 `turn + action + rebirthOpening` 匹配、复用 `visibleEventRecords` 的撤回语义（只认当前可见记录、不复活撤回正文）、仅当完整正文以现有前缀开头才替换，并维持 `6×1200` 硬上限、不引入 `raw / proposal / apex / usage` 等内部字段。文件 IO 放在 `maybeRestoreRecent`，仅在 `takeTurn` 拼提示词前、且检测到 300 字疑似截断条目时读一次本世界日志；恢复只读不写盘，完整 `recent` 随本回合正常落库自然沿用。普通读（`getWorld` / `/log` / `export`）不触发扫描；缺日志 / 无匹配 / 异常均沿用原记录、不阻断流程。

## 5. 「提示词在哪改」速查

| 想改什么 | 文件 | 函数 / 常量 |
|---|---|---|
| 叙事 v2（小说化写法） | `src/prompts.js` | `V2_DECISION_LINES`、`V2_SEGMENT_LINES`、`V2_TURN_RULES`、`V2_NARRATION_NOTES`、`V2_NARRATION_EXAMPLE`、`V2_TURN_OUTPUT_FORMAT`；`buildTurnMessages` 内 `isV2` / `is3p` 分支；开关 `env.js` `DEFAULTS.NARRATIVE_STYLE` 与 `.env` `NARRATIVE_STYLE` |
| 文风段 | `src/genres.js` | `GENRE_STYLES`、`XUANHUAN` / `URBAN` / `GAME` / `HORROR` / `COZY`、`normalizeGenre`；注入点 `prompts.js` `buildTurnMessages`（`【写作手法】` 之后） |
| 成人模式 | `src/prompts.js` | `INTIMACY_COMMON`、`INTIMACY_ADULT_OFF`、`INTIMACY_ADULT_ON`；`buildTurnMessages` 的 `opts.adult`；开关 `prefs.js` `adultModeOn` / `setGlobalAdultAllowed`、接口 `POST /api/prefs` |
| 玩家意图优先 | `src/prompts.js` | `TURN_RULES` 的「玩家意图优先」行、`CONSTITUTION`、`overstepDirective` / `OVERSTEP_FORMS`；引擎侧 `engine/turn.js` 的 `focus` / `adult` 消毒、`engine/events.js` `planTurn` 的 `QUIET_FOCUS` 安静模式 |
| 第一幕衔接 | `src/prompts.js` | `buildTurnMessages` 里 `section('第一幕（开场衔接）', …)`（`plan.opening` 时追加） |
| 建世界 / 序章 | `src/prompts.js` | `buildWorldMessages` + `WORLD_OUTPUT_FORMAT`（含 `prologue` / `start.items_info`）、`buildPrologueMessages`（老世界补序章）、`buildRebirthOpeningMessages`、`buildChapterMessages` / `buildApexMessages` / `buildEpitaphMessages` |
| 物品介绍 | `src/prompts.js` | `buildItemsInfoMessages`（批量补介绍）、`TURN_OUTPUT_FORMAT` 的 `items_info` 规则；引擎消毒 `engine/util.js` `cleanItemInfo`；接口 `GET /api/worlds/:id/items` |
| 出图提示词 | `src/images.js` | `gatewayPrompt`、`localPrompt`、`scenePromptZh`、`scenePromptEn`、`STYLE_RULES`、`DEFAULT_STYLE`、`inferStyle` / `ruleArt` / `styleFromArt`、`cleanEnglish`、`collectRefs`、`FILE_NAME_RE`；模型输出侧 `src/prompts.js` `TURN_OUTPUT_FORMAT` 的 `scene` 字段（`draw` / `cast` / `items` / `action`） |
| 朗读 SSML | `src/tts.js` | `buildSsml`、`buildSegmentsSsml`、`segmentInner`、`prosodyFor`、`SPEAK_OPEN`、`VOICES` / `MOODS` / `DEFAULT_VOICE`；前端 `public/js/tts.js`（分段排队、音色与情绪） |

## 6. 测试

- 运行器：`node scripts/testsum.js`（跑 `test/*.test.js`，只打印汇总与失败项，省上下文）；单文件 `node scripts/testsum.js test/xxx.test.js`。
- 本地模拟服务（不调真实模型、不启动隧道）：`LLM_MOCK=1 TUNNEL=off DATA_DIR=./data-mock node server.js`。主人本机直连免密；用于手机 / 桌面视口下的界面检查。
- 框架：`node:test` + `assert/strict`，零第三方依赖；helpers 用临时 `DATA_DIR` + `LLM_MOCK=1` 起随机端口服务，并对引擎注入确定性 rng。
- 主题分组见第 1 节 `test/`：① 访问控制 / 登录 / 归属；② API 核心 / 流式；③ 引擎 / 规则；④ 提示词 / 叙事 / 文风 / 玩家意图；⑤ 出图 / 场景图 / 物品介绍；⑥ 朗读 / TTS；⑦ 前端；⑧ 配置 / 存储 / 客户端 / 隧道 / 自动试玩。

## 7. .env 变量分组

只列变量名与用途，**绝不写值**。完整清单见 `.env.example` 与 `src/env.js` 的 `DEFAULTS`；密钥类变量一律留空由用户自行填写。

| 分组 | 变量 | 用途 |
|---|---|---|
| 对话模型 | `LLM_BASE` | OpenAI 兼容网关地址 |
| 对话模型 | `LLM_API_KEY` | 对话模型密钥 |
| 对话模型 | `LLM_MODEL` | 回合叙事所用模型 |
| 对话模型 | `LLM_MODEL_WORLD` | 建世界 / 重型生成所用模型 |
| 对话模型 | `LLM_BASE_URL` | 网关地址别名，出图网关默认复用 |
| 对话模型 | `LLM_MOCK` | 本地模拟模式开关（不调真实模型） |
| 对话模型 | `LLM_TIMEOUT_MS` | 单次请求超时 |
| 对话模型 | `LLM_EXTRA_BODY` | 合并进请求体的额外参数（JSON 字符串） |
| 叙事 | `NARRATIVE_STYLE` | 叙事写法版本选择（旧写法 / 小说化写法，见第 5 节） |
| 访问与多人 | `PORT` | HTTP 监听端口 |
| 访问与多人 | `HOST` | HTTP 监听地址 |
| 访问与多人 | `DATA_DIR` | 运行期数据根目录（相对路径按项目目录解析） |
| 访问与多人 | `ACCESS_PASSWORD` | 公网来客访问密码（留空则自动生成并存 `access.json`） |
| 访问与多人 | `HOST_PASSWORD` | 主人口令（留空则自动生成） |
| 隧道 | `TUNNEL` | 是否自动启动 Cloudflare 临时隧道 |
| 隧道 | `CLOUDFLARED_PATH` | cloudflared 可执行文件路径（留空则自动查找） |
| 出图 | `IMAGE_PROVIDER` | 出图提供方回退链（逗号分隔，前一家失败换下一家） |
| 出图 | `IMAGE_BASE_URL` | 出图网关地址（留空按提供方默认值） |
| 出图 | `IMAGE_MODEL` | 出图网关所用模型 |
| 出图 | `IMAGE_SIZE` | 出图尺寸 |
| 出图 | `IMAGE_CONCURRENCY` | 出图并发数 |
| 出图 | `IMAGE_SCENE_REF_MODEL` | 场景多参考图模型（置空表示停用参考图） |
| 出图 | `SILICONFLOW_API_KEY` | 硅基流动出图密钥 |
| 出图 | `IMAGE_SILICONFLOW_MODEL` | 硅基流动所用模型 |
| 出图 | `ZHIPU_API_KEY` | 智谱出图密钥 |
| 出图 | `IMAGE_ZHIPU_MODEL` | 智谱所用模型 |
| 出图 | `MODELSCOPE_API_KEY` | 魔搭出图密钥 |
| 出图 | `IMAGE_MODELSCOPE_MODEL` | 魔搭所用模型 |
| 出图 | `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户标识 |
| 出图 | `CLOUDFLARE_API_TOKEN` | Cloudflare API 令牌 |
| 出图 | `IMAGE_CLOUDFLARE_MODEL` | Cloudflare 文生图模型 |
| 出图 | `IMAGE_LOCAL_PYTHON` | 本地出图所用 Python 解释器路径 |
| 出图 | `IMAGE_HF_HOME` | 本地模型缓存目录 |
| 出图 | `IMAGE_LORA` | 本地 LoRA 路径 |
| 出图 | `IMAGE_LOCAL_MIN_FREE_MB` | 空闲内存低于此值不启动本地画图服务 |
| 朗读 | `AZURE_SPEECH_KEY` | Azure 语音服务订阅密钥（留空则朗读接口返回未配置） |
| 朗读 | `AZURE_SPEECH_REGION` | Azure 语音服务区域 |
| 限额 | `LLM_DAILY_TOKEN_LIMIT` | 全局每日 token 上限 |
| 限额 | `LLM_PLAYER_DAILY_TOKEN_LIMIT` | 每位玩家每日 token 上限（可设为不限） |
| 限额 | `IMAGE_SCENE_DAILY_PER_PLAYER` | 每位来客每日场景插图上限（可设为不限） |
| 限额 | `IMAGE_MAX_PER_WORLD` | 单世界出图数量上限（仅网关提供方生效） |
| 限额 | `CLOUDFLARE_DAILY_NEURONS` | Cloudflare Workers AI 每日免费额度 |
| 限额 | `CLOUDFLARE_RESERVE_FROM` | 当日用量达此值后把剩余额度留给场景图 |
| 限额 | `TTS_PLAYER_DAILY_CHARS` | 每位来客每日朗读字符上限（可设为不限） |
| 限额 | `TTS_CACHE_MAX_MB` | 朗读音频缓存总大小上限（MB） |
| 限额 | `TTS_MONTHLY_CHARS` | Azure 免费档每月字符额度 |
| 限额 | `TTS_MONTHLY_STOP_AT` | 本月用量达此值即停用 Azure 朗读、回退浏览器 |
