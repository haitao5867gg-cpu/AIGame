# AIGame（无限世界）

网页版无终点 AI 角色扮演游戏：一句话定世界观，模型写叙事、引擎裁定数值，配有出图与朗读。

**接手请先读 [HANDOFF.md](HANDOFF.md)**（背景、规则、部署、进度）。

- 架构与代码结构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 最新交接状态：[docs/CLAUDE_HANDOFF.md](docs/CLAUDE_HANDOFF.md)
- 人物长期档案：[docs/NPC_MEMORY.md](docs/NPC_MEMORY.md)
- 背景与配乐：[docs/ATMOSPHERE.md](docs/ATMOSPHERE.md)
- 早期规格：[docs/SPEC.md](docs/SPEC.md)（早期规格，部分已过时，以代码为准）

本地两条命令：

```
node scripts/testsum.js
LLM_MOCK=1 TUNNEL=off DATA_DIR=./data-mock node server.js
```

第一条跑测试（只打印汇总与失败项）；第二条起本地模拟服务（不调真实模型、不启动隧道），主人本机直连免密。
