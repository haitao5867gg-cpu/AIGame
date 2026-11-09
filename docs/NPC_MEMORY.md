# NPC 长期档案（人物记忆）设计与实现

> 面向接手的新主脑。本文描述**当前代码真实实现**的 NPC 长期档案 schema、权限分层、数据流、函数接口、只读回填、分页、导出与真实限制。
> 相关全局架构见 `docs/ARCHITECTURE.md` 第 5 节（速览）；规则引擎契约见 `.logs/npc-dossier-contract-20261108.md`（本轮任务输入，非运行期文件）。
> 零第三方依赖；不含任何密钥 / 口令 / Token 的值。

---

## 0. 一句话与不变量

**完整人物履历只存 `events.jsonl`（原文永不裁剪）；`state.json` 只存按稳定 id 索引的内部档案与迁移版本；每回合模型只看有界的相关人物摘录。**

四条硬不变量：

1. **完整存储 ≠ 每回合全塞 prompt**：全量 canonical 历史留在 `events.jsonl` 与人物详情 / 导出里；`buildTurnMessages` 只注入 `npcPromptContext`：按行动点名 / 最近相关度只选少量人（默认 `NPC_PROMPT_MAX_NPCS=4`）、整体 `NPC_PROMPT_MAX_CHARS=2000`、每人 `NPC_PROMPT_PER_NPC_CHARS=360`，且每人按字段分配独立预算（`PROMPT_FIELD_CAPS`），超预算的低优先字段跳过、长字段 `clipExcerpt` 注明「摘录」，**不是把一人 360 字整块截断**。常量以 `src/npcs.js` 为准。正常 prompt 只摘相关信息，普通 prompt 不随回合数增长；`state.npcProfiles` 与 `events.jsonl` 履历原文永不裁剪。
2. **公开已知 vs 内部设定分层**：内部 profile 含 `original` 原始人设、`want` 隐藏动机、`internal` 私密状态；公开投影是严格白名单。隐藏动机 / 秘密只作模型内部参考，绝不成为玩家已知事实。
3. **旧档只读回填**：从 canonical 可见事件重建档案，不写 `state.json`、不调 LLM、不改磁盘字节、不造历史。
4. **撤回按位置**：`events.jsonl` 是 append-only，撤回分支按位置排除，不靠全局回合号；`undo` / 重走同 turn 不复活旧分支的 NPC 事件。

---

## 1. 数据流图

```
┌───────────────────────────── 回合写入路径 ─────────────────────────────┐

 模型回合输出 out（一个 JSON）
   ├─ narration / applied / scene / voice_hints / npc_attitude ...（既有玩法字段）
   └─ npc_updates（新提示词必输出数组；无新资料 []）── 真实出现人物 + 本回合原文 evidence + 公开 known
          │  src/game.js takeTurn：out.npc_updates → proposal.npc_updates
          ▼
 engine.resolveTurn（src/engine/turn.js）
   └─ npcs.applyNpcMemory(before, after, updates, {action, narration})
        · 校验：新增 / 变化的公开值须是本回合 narration 的连续子串（拒绝私密 / 猜测资料；未变化旧值重复见 2.3）
        · 校验：canonical 原名 + 稳定 id 对应已有档案；字段长度上限
        · 合并：原始人设与后来变化并存；单项 trait 变更不擦除其它特征
        · 返回 { state, changes, rejected }
          ├─ state.npcProfiles[id] 更新（内部档案）
          └─ changes → result.npc_memory（私有，全局仅此一处出现）
          │
          │  src/game.js appendEvent
          ▼
 data/worlds/<id>/events.jsonl  ←── 唯一权威全量履历（含撤回分支、完整正文、私有 npc_memory）
 data/worlds/<id>/state.json    ←── npcProfiles[id] + npcMemoryVersion（内部档案 + 版本）

└────────────────────────────────────────────────────────────────────────┘

┌───────────────────────────── 读取 / 投影路径 ───────────────────────────┐

 src/event-log.js  visibleEventEntries(events) / visibleEventRecords(events)
   （排除撤回分支、保留原始 eventIndex；撤回按位置而非全局 turn 号）
          │
          ├─ hydrateNpcMemory(state, events) ──→ game.loadState 旧档只读回填
          │        · 缓存按 dataDir+worldId 区分、以 store.worldRevision 判失效
          │
          ├─ getNpcHistory(state, events, npcId, {before, limit})
          │        → { profile, history:{entries, nextCursor, hasMore, total} }
          │        → GET /api/worlds/:id/npcs/:npcId（publicNpcProfiles 公开投影）
          │
          ├─ npcPromptContext(state, action) ──→ buildTurnMessages
          │        → 有界【相关人物档案（仅内部连续性参考）】片段（只给模型）
          │
          └─ exportWorld → npcArchive（遍历分页收齐全部公开档案 / 履历）

 state.npcProfiles + bible.npcs
   │  publicNpcProfiles / publicBibleNpcs（严格白名单，滤掉 want 等）
   ▼
 普通响应 / getWorld / 人物详情 / 公开分享导出
   （均无 original / internal / want / apex / npc_memory / npc_updates）

└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 存储 schema

### 2.1 `state.json`（内部，私有）

```
state.npcProfiles = {
  <stableId>: {
    id, name, displayName, aliases[], portraitName,
    original: { name, role, desc, want, voice, internal:{...}, ... },  // 完整原始基线，深拷贝，深拷贝不被 patch 覆盖
    role, description, voice, publicGoal, relationshipSummary,          // 公开标量
    traits: { identity:{}, appearance:{}, personality:{},              // 分类键值（TRAIT_CATEGORIES）
              abilities:{}, circumstances:{}, relationships:{} },
    internal: { <key>: <string> },                                       // 私有 flat map（动机 / 秘密）
    initial, firstRecord, lastRecord, lastInteraction,                  // 记录与时间锚点
    latestExcerpt, relationshipAt, attitude, established
  }, ...
}
state.npcMemoryVersion = 1   // NPC_MEMORY_VERSION；旧档缺此字段或 < 当前版本 ⇒ 需只读回填
```

- `id` 是**稳定 id**（`stableId`），`portraitName` / canonical `name` 保持稳定；资料更新不会换掉原头像 / 音色设置。
- `original` 来自 `bible.npcs` 的完整对象（含 `want` 隐藏动机），只作基线参考，随后变化并存、不改写过去。
- `established` 为 `true` 才进入公开字典 / 提示词（新世界未登场 NPC 为 `false`）。
- **旧格式档**：没有 `npcProfiles` / `npcMemoryVersion`，靠 `events.jsonl` 按需回填；`game.loadState` **不写回 state 文件**，不伪标迁移完成。

### 2.2 `events.jsonl`（唯一权威全量履历）

每条记录可含（公共既有字段照旧）：

```
{ turn, life, action, narration, applied:{...},
  npc_memory: [                                  // 私有：仅引擎校验后的档案增量变化
    { id, name, kind:'interaction|mention|change', evidence, action,
      at:{ turn, life, heroName, clock:{day, period} },
      fields:[ { scope:'public|internal|baseline', field, from, to, ... } ] }
  ] }
```

- 完整 `narration` 原文永不裁剪，是旧档回填 / 人物详情 / 章节摘要的唯一来源。
- `npc_memory` **只存在于此处**：`game.appendEvent` 落库；`toPublicApplied` / `toPublicTurnResult` / `toPublicLogRecord` 的白名单都不含它，绝不进普通 `applied` / 回合 / 日志 / 公开响应。
- 撤回（`type:'undo'`）、重生等记录同样 append；被撤回分支由 `visibleEventEntries` 按位置排除。
- 没有「可变 NPC 历史文件」：撤回文件列表（`UNDO_BACKUP_FILES`）不含任何此类文件。

### 2.3 模型协议 `npc_updates`（`src/prompts.js` `TURN_OUTPUT_FORMAT`）

`narration` **永远是 JSON 第一个字段**（SSE 正文优先，流式边生成边推）。`V2_TURN_OUTPUT_FORMAT` 由 `TURN_OUTPUT_FORMAT` 派生、自动继承，故下列契约对默认 `v1` 与 `v2` 同时生效。

**第 3 轮返工 · 真实模型漏记新资料**：首次真模型正文写出了新外貌资料（伤疤），却把整个 `npc_updates` 省略；原先「可选 / 没有新资料就省略」会被模型误读成「有明显新特征也无需登记」。现把通用输出契约改为：

- 主回合提示要求 `npc_updates` **随完整正文一并输出为数组**，无新资料即 `[]`。运行时兼容缺省与空数组；不能仅靠提示词保证模型没有漏记，实际补档流程见 2.4。
- 先自然写出完整 `narration`，再**做一次资料核对**：正文若确实新披露了新人物 / 新外貌 / 稳定性格·能力·处境 / 已公开目标或承诺关系 / 明确单项变化，把该人的原文短语摘到 `known` 对应字段，并给一段 `narration` 的连续子串作 `evidence`；原有未变项不必复述。新值无需硬凑长摘要，一对简单键值即可（如 `traits.appearance` 下的「疤痕：原文短语」）；情绪 / 一时动作不当永久性格，隐藏设定不公开、不写进 `known`。
- 通用**最终输出检查**明确「有真实新资料就登记、没有则 `[]`，不得反过来编剧情填档案」；没有新变化绝不可为填数组编造变化、强推关系、打断玩家或改变 NPC 意愿，玩家意图 / 私下 / 安静模式与既有 `scene` / `voice_hints` / `suggestions` 规则一律不变；不新增长期无界 prompt、不提前写「一年后」预测。

```
"npc_updates":[
  { "id":"已存在的稳定 id；新人物可省略",
    "name":"canonical 原名",
    "kind":"interaction|mention|change",
    "evidence":"复制本回合叙事里的原文片段（须是 narration 的连续子串）",
    "known":{ "role":"原文公开身份", "description":"原文描述", "voice":"原文口吻线索",
              "publicGoal":"原文已公开目标", "relationshipSummary":"原文关系线索",
              "traits":{ "appearance":{ "衣着":"原文短语" } } },
    "internal":{ "motivation":"只在内部保留的动机/状态" } }
]
```

上块是 `known` / `internal` 的完整可选字段清单。`TURN_OUTPUT_FORMAT` 里的示例已改为**单项外貌变化 + 正确结构**，且刻意用通用「某人」/「新衣短语」，不绑定任何真实人物 / 伤疤 / 测试 marker：

```
"npc_updates":[{"id":"已存在的稳定 id；新人物可省略","name":"某人","kind":"change",
  "evidence":"本回合叙事里写到新衣着的原文短语（narration 连续子串）",
  "known":{"traits":{"appearance":{"衣着":"新衣短语"}}}}]
```

一条 `change` + 一对 `traits.appearance` 键值即是合法登记，不必凑长摘要或补全其它字段；这样模型不会再把「有明显新特征」误当成无需登记。

- 单次最多 `NPC_UPDATES_MAX = 6` 条；文本字段上限 `NPC_FIELD_MAX = 2000` 字，超长整条拒绝（不静默截断）。
- TRAIT_CATEGORIES：`identity / appearance / personality / abilities / circumstances / relationships`；KINDS：`interaction / mention / change`。
- **协议铁律**：`npc_updates` 必随正文输出为数组，没有新资料 / 无需登记即 `[]`（不是省略；运行时仍兼容老模型缺省 / 空数组，引擎不硬校验），不强求每回合增资料 / 关系变化；公共值一律摘自本回合原文（仅指真正新增 / 变化者；未变化、已接纳的旧值重复不挡同条新 patch，详见下方「协议对齐」），不把后台设定 / 隐藏动机 / 模型猜测包装成玩家已知；一时语气 / 情绪不能无缘由当永久性格改变；原始人设与后来变化并存、不篡改过去；人物档案不是在场名单 / 任务清单，不得插外人打断 / 替玩家决策、玩家意图优先、私下 / 安静模式照旧；前世交情 ≠ 新主角已相识；未来「可能 / 一年后」不得写成已发生；**本轮没有时间推进按钮 / API**。
- `displayName` / `aliases` 本轮不接纳更新（不重写改名 / 重名引擎）；`name` 用 canonical 原名；既有 `npc_attitude` / `voice_hints` / `scene.cast` 继续用原名。
- **协议对齐 · 证据规则（第 3 轮已实现，勿回退为「逐值复述」）**：当前「初始设定」是只读
  `public baseline`（见 4.1），来自世界设定的安全可公开部分，不是任何旧回合口述、也无需本回合复述；
  后续 `npc_updates` 只要求**真正新增 / 变化**的公共值有本回合 `narration` 原文 `evidence` 举证；
  `known` 里夹带「已接纳且未变化」的旧值不产生字段变化，也不应挡掉同条里真正变化、已原文举证的新 patch。
  **文档 / 协议不要求任何重复旧值都必须本回合复述**；缺资料不猜、没变化不强求、空数组即可。

- **第 4 轮返工 · 逐值逐字与标签规则（真实模型第 2 次：概括 / 重组 value、自造复合标签）**：
  运行时 `validateKnownInternal`（逐值核对「公共值须是本回合 `narration` 的连续子串」）与
  `isAcceptableLabel`（标签须在 `NEUTRAL_LABELS` 白名单或逐字出现在 `narration` 里）本就正确拒绝了这类输出，
  **本轮不放宽任何运行时证据 / 标签验证**，只把已成事实的约定写进提示词（默认 v1 与 v2 都继承）：
  `known` 里每个「真正新增 / 变化」的公共文本值必须逐字复制 `narration` 的**单个连续子串**——不概括、不换词、
  不删词后重组、不换词序、不把相隔几处拼成一句，可直接引用一整句可见描写、不必压成摘要、不为省字改写；
  `evidence` 是原文并不代表 `known` 其它字符串合法，每个 `value` 单独通过检查。
  特征键优先沿用当前档案已有键，新增键用简单中性标签（`外貌 / 衣着 / 疤痕 / 声音 / 性格 / 专长 / 近况 / 关系` 等），
  不携带新事实、不泄露隐藏身份，正文里不存在的「复合自造标签」不输出。
  提示词给了一组**通用**「原文→JSON 正确示例」（灰袍 / 衣着，不引用具体 NPC / 物件 / marker），
  并明确示例值必须真的出现在当回合正文、不得凭空照抄例子。
  通用「最终输出检查」与 user 行动消息末行都要求**逐字段核对**：value 是连续子串、标签已有 / 中性、
  真正新资料按原文登记、无变化 `[]`、不得编剧情填档案；`narration` 仍第一、正文先自然写完、不为 metadata 回改正文。

---

### 2.4 主回合漏记时的短补档

`src/npc-extraction.js` 在有效回合结算后、存档前执行。若已有通过校验的公共资料增量，直接沿用；否则，仅当正文或行动涉及已建立档案的人物时，额外调用一次回合模型，专门从**已接纳正文**摘录资料。打开人物卡、分页、导出与旧档回填都不触发它。

- 提取器只拿公共档案摘录与正文，不拿 `original / want / internal`；最多4个候选人物，不能扩大名单、生成新剧情或修改属性、物品、场景、时间。
- 输入 UTF-8 字节加512的保守 token 上界最多9000，输出最多1500 token，超时最多12秒（含响应体），**不重试**。无相关人物、成人回合、过大输入均跳过。该调用以 `purpose=npc_memory` 计入既有用量、玩家配额及回合用量聚合，会增加部分人物回合的等待与 token 消耗。
- 主模型和提取器的结果均不直接相信。补档每项字段独立交给原有 `applyNpcMemory` 校验：真正新值仍须逐字是正文子串；不合格的标签和值单独拒绝，不能挡住同条中有原文依据的其它字段。已有同分类公共标签可以复用，不能从 `original / internal` 借用未公开标签。
- 网络、JSON、字段校验失败均不改写或回滚玩家回合；完整已接纳正文始终存入 canonical 日志。不保证模型每次都归纳出全部结构化特征，未来演变必须同时读取完整人设与经历原文，不能只读当前特征摘要。
- `npc_memory_extraction` 仅是内部事件诊断（是否尝试、通过字段数、拒绝数），不进入公开 state、turn、log 或分享导出。

## 3. 函数接口（签名以当前代码为准）

`src/npcs.js` 是纯数据层（只依赖 `crypto` + `event-log.js`），由 `src/engine.js` 门面转发，编排层 / 接口层不重复实现。

| 函数（经 `engine` 门面） | 入参 | 返回 / 作用 |
|---|---|---|
| `initializeNpcMemory(state)` | world | 新世界按 `bible.npcs` 建 `original` 基线、置 `npcMemoryVersion = NPC_MEMORY_VERSION`、未登场 `established=false` |
| `normalizeNpcMemory(state)` | state | 补齐 `npcProfiles={}` / `npcMemoryVersion=0`，保持「待回填」标记；幂等、不改入参 |
| `needsNpcHydration(state)` | state | 版本 < 当前 ⇒ `true`（旧档） |
| `hydrateNpcMemory(state, rawEvents)` | state, 原始 events | 以 canonical 可见事件为唯一来源重建档案；幂等、只读、不写盘、不调 LLM、不造历史 |
| `applyNpcMemory(before, after, updates, ctx)` | 前后 state, `npc_updates`, `{action, narration}` | 校验 + 增量合并 → `{state, changes, rejected}`；`changes` 即内部 `npc_memory`，`rejected` 记内部日志 |
| `publicNpcProfiles(state)` | state | 公开字典：仅 `established===true`，`projectProfile` 严格白名单 |
| `publicBibleNpcs(state)` | state | 公开 `bible.npcs`：保留 `name/displayName/aliases/role/desc/voice/portraitName`，过滤 `want` 等隐藏动机 |
| `getNpcHistory(state, rawEvents, npcId, opts)` | + `{before, limit}` | → `{profile, history:{entries, nextCursor, hasMore, total}}`；不存在 / 未公开 ⇒ `null` |
| `npcPromptContext(state, action, opts)` | + `{maxNpcs, maxChars}` | 有界内部连续性片段 / 空串 `''`；只给模型 |
| `visibleEventRecords(events)` / `visibleEventEntries(events)` | 原始 events | canonical 可见记录 / 带 `eventIndex` 的条目（来自 `src/event-log.js`） |
| `stableId` / 常量 | — | `NPC_MEMORY_VERSION`、`NPC_UPDATES_MAX`、`NPC_FIELD_MAX`、`HISTORY_LIMIT_DEFAULT=20`、`HISTORY_LIMIT_MAX=50`、`TRAIT_CATEGORIES` |

编排 / 接口 / 存储层：

| 位置 | 接口 | 作用 |
|---|---|---|
| `src/game.js` | `loadState(worldId)` | 读 `state.json` → `needsNpcHydration` 时用 `hydrateNpcMemory` 只读回填；`npcHydrationCache` 按 `dataDir+worldId` + `store.worldRevision` 缓存、**有界 LRU（`NPC_HYDRATION_CACHE_MAX`）**、命中返回深拷贝；新格式 / 世界删除 / 读不到 world 清对应缓存项 |
| `src/game.js` | `takeTurn` | `out.npc_updates → proposal.npc_updates`；`result.npc_memory` 只交给 `appendEvent` |
| `src/game.js` | `appendEvent` | 把 `npc_memory` 写入内部 `events.jsonl`（公开 `toPublicLogRecord` 不含它） |
| `src/game.js` | `getNpcDetail(worldId, npcId, opts)` | 转 `engine.getNpcHistory`；只读、不调模型 / 出图 / TTS / 写档 |
| `src/game.js` | `exportWorld(worldId)` | 去私密 `state` + `events` + 全量 `npcArchive` |
| `src/store.js` | `worldRevision(dataDir, worldId)` | `state.json` 与 `events.jsonl` 的 `mtimeMs:size:ino` 指纹 `\|` 拼接；缺文件安全回退 `0:0:0` |
| `server.js` | `GET /api/worlds/:id/npcs/:npcId` | 见第 5 节 |

---

## 4. 公开已知 vs 内部设定分层（权限矩阵）

| 字段 | 内部 `state.json` / `events.jsonl` | 模型 prompt（system） | 普通响应 / getWorld | 人物详情 / 公开导出 |
|---|---|---|---|---|
| `original`（原始人设全文） | ✅ 完整 | ✅ `[内部档案]` 摘录 | ❌ | ❌ |
| `want` / 隐藏动机 | ✅ 完整 | ✅（`worldBibleText` 给模型） | ❌（`publicBibleNpcs` 过滤） | ❌ |
| `internal` / 私密状态 | ✅ 完整 | ✅ `[内部状态]` | ❌ | ❌ |
| `apex` / Key | ✅ | ❌ | ❌（toPublicState 删除） | ❌ |
| `npc_memory` | ✅ 仅 `events.jsonl` | ❌ | ❌ | ❌ |
| `npc_updates`（原始提议） | 不落库（仅经校验后的 `npc_memory`） | ✅ 输出格式协议 | ❌ | ❌ |
| 公开标量 / `traits` / 关系 / 时间锚点 | ✅ | ✅ 有界摘录 | ✅ 白名单投影 | ✅ 白名单投影 |
| `narration` 完整原文 | ✅ 全量 | 最近 6 回合 / 摘录 | 最近记录 | ✅ 分页全量 |

- 隐藏动机 / 秘密在 prompt 里明确标注为「内部参考」，并要求**不得当成玩家已知写进叙事、不得据此凭空改变 NPC 的公开身份 / 形象 / 音色**。
- 初始角色 `want` 在内部 `state.json` 完整保留，但不通过 `bible` 旁路泄露（`publicBibleNpcs` / `publicNpcProfiles` 都不含 `want`）。
- 「提及」不等于「当面见过」；新角色无好感（`npc_attitude`）变化，也能因叙事出现而进入已知档案。

### 4.1 「初始设定」基础公开资料（只读投影，不伪造成旧回合口述）

主脑要求旧人物能通过既有公开设置得到一份可读基础介绍。数据层在角色**确已由公开叙事 / 事件出场**
（`established===true`）后，从该角色已有世界设定 `original` 的 `role` / `desc`（动态 NPC 为
`description`）/ `voice` 里取**安全可公开**的部分，作为「初始设定」基础填进公开投影的
`role` / `description` / `voice` 与 `initial` 快照（`publicBaseline` / `safePublicSetting`）：

- 只填空缺，不覆盖已存在的合法当前资料 / 初始快照；后来有叙事支持的变化只覆盖当前字段，不改写初始快照或完整 `original`。
- `want` / `internal`，以及明显含隐藏身份 / 幕后 / 暗中 / 秘密 / 私密 / 实则 / 其实 / 伪装 / 暗线等私密句段一律**整段省略**（不改写、不另造一份背景），不确定留空 = 未知，不主动展开暗线。
- 这是「初始设定」基础资料，**不是某个旧回合亲口说过的话**；所有共事经历仍只读 canonical 履历原文，绝不伪造成旧回合口述、绝不倒灌整份 `original`。
- 后续 `npc_updates` 新增 / 变化仍须本回合实际叙事 `evidence` 举证公共值（见 2.3）；缺资料不猜、没变化不强求、空数组即可。World 生成提示词据此把 `role` / `desc` / `voice` 写成可公开身份 / 外显形象 / 性格 / 说话风格，把暗线与隐秘目标放进 `want`，避免混进公开介绍（见 `WORLD_OUTPUT_FORMAT`）。

---

## 5. HTTP 接口：人物卡详情

`GET /api/worlds/:id/npcs/:npcId?before=<int>&limit=<int>`（`server.js`）

- **只 GET**（其他方法 405）；复用全局认证 + `requireOwner`（查 `owners.json`）；未登录 `/api/*` 返回 401，登录来客越权返回 404，不泄露世界是否存在。
- 参数：`before` 非负整数、`limit` 正整数，否则 400；`limit` 由引擎夹到 `1..50`（`HISTORY_LIMIT_MAX`），默认 20。
- `before` 是 `events.jsonl` 原始 `eventIndex` 的**排他游标**，按最新→最旧翻页，`nextCursor` 取本页最旧 `eventIndex`（恒 `null` 或非负整数），可翻到全部旧记录；合成开场记录 `eventIndex = -1`（最旧一条）。
- 返回 `{ profile, history:{ entries, nextCursor, hasMore, total } }`；`entries[]` 含 `eventIndex / kind / at / action / excerpt / narration（完整原文）/ changes（仅公开变化）`。
- 不存在 / 未公开 / 跨世界 / 危险 id（如 `__proto__`）⇒ 404；`npcId` 经 `safeIdRef` 校验。
- **没有 `includePrivate` 开关**：该查询被忽略，响应只含公开投影，绝不出现 `original / internal / want / apex / npc_memory / npc_updates`。
- **纯读**：点人物卡不调用模型、不出图、不朗读、不写档；读取前后 `state.json` / `events.jsonl` 磁盘字节不变。

---

## 6. 分页语义

- `collected` 来自 `visibleEventEntries`（已排除撤回分支）+ 一条合成开场记录（`eventIndex=-1`），按 `eventIndex` 降序。
- `before === null` ⇒ 取最新一页；否则 `collected.filter(c => c.eventIndex < before)`（排他）。
- `nextCursor = 本页最旧 eventIndex`（仅当 `hasMore` 且 `>= 0`）；翻到最旧开场时 `nextCursor = null`，游标不会变负。
- `total` 是该人物全部可见公开记录数；配合 `limit` 循环翻页可收齐全部原文（不漏前 20/50 条之后的记录）。

---

## 7. 旧档只读回填与 revision 缓存

```
game.loadState(worldId)
  raw = store.loadWorld(...)  → engine.normalizeState(raw)
  if (!engine.needsNpcHydration(state))  → 清该 key 缓存、直接返回（新格式正常回合不扫全史）
  revision = store.worldRevision(dataDir, worldId)   // state.json + events.jsonl 的 mtimeMs:size:ino
  cacheKey = `${dataDir}\0${worldId}`
  if (cached.revision === revision) → 返回 cloneForRead(cached.hydrated)   // 深拷贝，避免污染
  events = store.readEvents(...)  → engine.hydrateNpcMemory(state, events)   // 只读重建
  npcHydrationCache.set(cacheKey, { revision, hydrated })
  return cloneForRead(hydrated)
```

- **为何用 revision 而非 `world.turn`**：`undo` / 重走同一 turn 时 `world.turn` 不变，但 `events.jsonl` 字节已变；`mtimeMs:size:ino` 指纹能感知 append / 撤回 / state 重写，保证缓存即时失效，撤回分支的 NPC 事件不会复活。
- 缓存按 `dataDir + worldId` 区分，多世界 / 来客严格隔离；缺文件（`0:0:0`）/ 读异常安全回退为空事件集，缺日志 / 旧字段能继续玩、不造历史。
- 缓存是**有界 LRU**（`NPC_HYDRATION_CACHE_MAX`，命中 / 写入移到「最近使用」末尾，超限淘汰最久未用项）：全局 Map 不会随访问过的世界数无限增长。命中仍返回深拷贝，调用方改动不污染缓存；世界删除 / 读不到 world 时清掉对应项，失效世界不残留。
- 回填**不写 `state.json`、不调 LLM、不改磁盘字节**：旧世界 `getWorld → 人物详情 → 分页原文完整`，无需真模型补档。

---

## 8. 撤回 / 重生 / 名字稳定性

- `src/event-log.js` `visibleEventEntries` 把 `type:'undo'` 的记录及其所撤回的前一条（按位置）一起隐藏；**按 append-only 位置而非全局回合号**判定，100+ 回合含 undo / 重走同 turn 时旧分支人物事件不会串进档案。
- 主角死亡回合的 `heroName` / `life` 按原人物记录写入时间锚点；重生不清空 `npcProfiles`。
- 关系 / 旧经历带来源 `at: { turn, life, heroName, clock:{day, period} }`；`provenanceTag` 把前世标成「前世第 N 世 · 当时主角 X」，**前世交情不自动当本世已相识**。
- 资料更新不改 `portraitName` / canonical `name`；`npc_attitude` / `voice_hints` / `scene.cast` 继续用原名，头像 / 音色设置不换人。本轮不重写改名 / 重名引擎。

---

## 9. 公开分享导出 vs 服务器完整备份

| | `GET /api/worlds/:id/export` | 服务器 `state.json` + `events.jsonl` |
|---|---|---|
| 用途 | 发给玩家的**公开分享 / 存档** | 服务端运维 / 迁移 / 灾难恢复 |
| `state` | `toPublicState`（删 `apex` / Key / 内部主题） | 完整（含 `npcProfiles.original/want/internal`、`apex`） |
| `events` | `toPublicLogRecord` 去私密的可见记录 | 完整（含私有 `npc_memory`、撤回分支正文） |
| `npcArchive` | 按稳定 id 的**完整公开档案 / 履历**，遍历 `getNpcHistory` 分页收齐全部（不只前 20/50 条） | — |
| 私密字段 | 均无 `original/internal/want/apex/npc_memory/npc_updates` | 全部保留 |
| 权限模型 | 归属校验后即可分享 | 仅服务端文件系统访问 |

> 两者用途不同、权限不同：**绝不能把服务器完整备份当公开分享文件发出**。

导出的人选与档案以**有效当前 `state`**为准：`loadState` 已处理旧迁移，`exportWorld` 不再先无条件
`hydrateNpcMemory` 再决定人物集合——否则有效 schema1 当前档案里完整的角色 / traits 会因旧日志全缺 /
只剩部分记录被重建抹掉。集合额外并上仅由 canonical 可见叙事建立、`state` 里仍是基线的人物，保证不漏人；
`history` 只由 `getNpcHistory` 从剩余 canonical 日志分页收集，不造记录、不把缺的日志补成完整原文
（缺日志时只有合成开场、`narration` 为空）。

分页安全：页空 / `hasMore` 与 `nextCursor` 不一致 / 游标不前进或倒退循环 / guard 耗尽 / 实收条目数
少于 `total`，一律抛带状态码的安全错误中止导出，绝不返回「`total` 更大却只收了前几页」的伪完整导出；
正常 120+ 条、`before=0` 翻到最旧合成开场仍能读全。

---

## 10. 真实限制 / 本轮不做

- **全量历史不进每回合 prompt**：`npcPromptContext` 按行动点名 / 最近相关度只选 ≤4 人（`NPC_PROMPT_MAX_NPCS=4`）、整体 ≤2000 字（`NPC_PROMPT_MAX_CHARS=2000`）、每人 ≤360 字（`NPC_PROMPT_PER_NPC_CHARS=360`，按 `PROMPT_FIELD_CAPS` 分字段预算，超预算字段跳过而非整块截断，长文 `clipExcerpt` 注明「摘录」）。常量以 `src/npcs.js` 为准。**正常 prompt 只摘相关信息**；`state.npcProfiles` 与 `events.jsonl` 履历全文从不裁剪，完整原文只在存档 / 详情 / 导出里。`state.recent` 也恒定最近 6 回合。
- **前世交情不自动互认**：关系 / 旧经历带来源 `at:{turn,life,heroName,clock}`，`provenanceTag` 把前世标成「前世第 N 世 · 当时主角 X」；需要时间 / 姓名来源，不当作本世已相识，也不凭空让新主角认识旧人（见第 8 节）。
- **未来一年推进本轮未实现**：只保留原始人设 / 当前状态 / 全量历史 / 时间锚点作候选原料，不新增时间推进按钮 / API，不把「可能 / 一年后」写成已发生，不自动更新 NPC 年龄 / 年历（见第 11 节）。
- `npc_updates` 新提示词要求**随正文输出为数组**（无合法新资料 / 无需登记就 `[]`），运行时仍兼容老模型缺省 / 空数组；真实披露的新可见特征必须按本回合原文 `evidence` 登记，每个新增 / 变化的公共 `value` 须逐字是 `narration` 的连续子串、标签沿用已有键或简单中性词、不得概括拼接或自造复合标签（见 2.3 第 4 轮返工，运行时验证未放宽）；模型不得为填卡编造已发生事件、不得把私密背景猜成公开身份、不得反过来编剧情填档案，缺资料不猜、没变化不强求。
- 本轮**没有时间推进按钮 / API**，未来预测不写成已发生、不自动更新 NPC 年龄 / 年历。
- 不新增可变 NPC 历史文件；不改写撤回文件列表；不改 `src/npcs.js` 的改名 / 重名引擎。
- 旧档回填是**只读**的：磁盘字节不变、不写 `state.json`；新格式正常回合保存后不会反复扫全史。

---

## 11. 未来一年演变预留（本轮不执行）

`原始人设(original) + 当前状态(npcProfiles) + 全量 canonical 历史(events.jsonl) + 时间锚点(record.at: turn / life / heroName / clock)` 已完整留存，可作为未来「推进一年后人物会怎样」的**预测候选原料**：

- 原始人设提供不变量基线；当前状态提供已发生的变化；全量历史提供共事经历与关系；时间锚点提供可回忆 / 可推算的时间坐标。
- 未来若实现「一年推进」，应基于这些原料生成**候选预测**，与「已发生事实」在 schema 上明确区分，不写回 `narration` / 不伪装成已发生事件。
- **本轮只保留原料与来源标注，不执行任何未来演变、不新增时间推进接口。**

---

## 12. 测试索引

- `test/npcs.test.js` — 纯数据层：初始化 / 增量合并 / 旧档回填 / 公开投影 / 历史分页 / 有界提示词片段 / 门面导出。
- `test/npc-extraction.test.js` — 短补档：公共输入、调用边界、原文校验、逐字段接受/拒绝、失败不重试、不改剧情、原始人设与画像保留。
- `test/npc-game.test.js` — 编排层：可见事件委托、`worldRevision` 缓存失效、旧档只读回填（磁盘字节不变 / 不调 LLM）、`npc_memory` 落内部事件、`npcArchive` 全量导出、`getNpcDetail` 分页与越界；第 1 轮收尾返工：有效 schema1 当前档案 + 缺 / 部分日志导出不丢角色 traits、完整导出分页安全（小 stub 模拟异常 / 120+ 条 before=0）、回填缓存有界 LRU 与删除清理。
- `test/npc-api.test.js` — 接口层：认证 / 归属 / 参数 400 / `limit` 夹到 50 / 去私密 / 分页 / 纯读不写盘。
- `test/npc-prompts.test.js` — 提示词：`npc_updates` 通用生成契约（必输出数组 / 无变化 `[]` / 正文写完后资料核对 / 单项外貌变化示例 / 最终输出检查 / 增量语义）、第 4 轮逐值连续子串 / 禁止概括拼接 / 中性标签规则 / 通用原文→JSON 示例 / 逐字段核对（v1 与 v2 都继承）、`narration` 第一字段、真实 `npcs.applyNpcMemory` 回归证明运行时证据 / 标签验证未放宽、既有玩家意图 / scene / voice_hints / suggestions 规则不回退、`buildTurnMessages` 有界档案注入与内部分层。
- `test/llm.test.js` — 假数据：第 1 轮收尾返工的 `mockTurn` 各 overstep/event/settlement 分支 `npc_updates` 证据始终是该分支实际 `narration` 的连续子串。
- 运行：`node scripts/testsum.js`（全量）；单跑本主题：`node scripts/testsum.js test/npcs.test.js test/npc-game.test.js test/npc-api.test.js test/npc-prompts.test.js test/llm.test.js test/prompts.test.js`。
