# GrokBot 原生短剧工具（本地文本到配音计划）

更新：2026-11-03（Asia/Shanghai）。分支：`feat/grokbot-native-drama-tools`（PR #103）。

目标：聊天为入口，**不打开原网站**也能完成：

`create → save-script → approve-script → set-characters → set-storyboard → approve-scene → voice-plan → status`

配套：`scripts/grokbot-native-tools/`、`grokbot-skills/ai-drama-native-tools/SKILL.md`。  
编排总表：`docs/GROKBOT_ORCHESTRATION.md`。真片一次批：`docs/FIRST_REAL_SHORT_ONE_SHOT.md`。

## GrokBot 扩展机制（实测）

| 机制 | 实际能力 | 本迁移用法 |
| --- | --- | --- |
| Skill（`SKILL.md` + `UpdateSkill`） | 可复用步骤菜谱；`/` / `@` 触发；**不是**任意 RPC | 仓库草案；主 Bot `UpdateSkill` 注册 |
| `/home/box/agent-data/workflows` | 空；Routine ≠ 业务库 | 不写项目状态进 workflows |
| Shell + 仓库 CLI | box 可跑 `node` | **主路径** |
| MCP | 仅已安装连接器 | **无** ai-drama MCP；禁止假装 |
| 原站会话 | CSRF + Origin | live 仅 create/list/script/status；APPROVE/配音计划走本地门 |

## 短清单：原功能 → Bot 入口 → 验收证据

| 原功能 | CLI / Skill | 验收 | 状态 |
| --- | --- | --- | --- |
| 创建/列表/继续作品 | `create` `list` `continue` | project id | 已实现 |
| 保存剧本修订 | `save-script` | DRAFT + hash | 已实现 |
| 人工审剧本 | `approve-script --approved-by` | APPROVED + actor | 已实现（本地） |
| 角色设定 | `set-characters` | characters[] | 已实现（本地） |
| 分镜/镜头 | `set-storyboard` | scene + shots | 已实现（本地） |
| 人工审场景 | `approve-scene --approved-by` | scene APPROVED | 已实现（本地） |
| 配音计划（不付费） | `voice-plan` | 整场 1 次 `eleven_v4`，不再按句计 qwen | 已实现（本地） |
| 表演计划 / 占位音色 | `performance-plan` `voice-candidates` `pick-voice` | 原文不改；标签不进字幕 | 已实现（本地，音色为占位） |
| 报价 / 人工授权 / 一次合成 | `tts-quote` `tts-authorize` `tts-generate` | 未授权拒绝；`--mock` 不扣费 | 已实现（真实提交需密钥与 `--execute`） |
| 试听、选用、本地重切、恢复、字幕、导出 | `tts-preview` `tts-select` `tts-redo` `tts-resume` `tts-subtitles` `tts-export` | 父音频血统；对齐不足不编造时间 | 已实现（本地） |
| 查阻塞 | `status` | blockers / stage | 已实现 |
| 真实付费 TTS | `tts-generate --execute` + `ELEVENLABS_TTS_API_KEY` | 本轮未调用 | 待密钥与 Pro 格式 |
| 《末班车暗号》复现 | `fixtures/moban-che-anhao/repro.sh` | stage=voice_plan，1 次外部操作 | 已实现 |

## 《末班车暗号》复现

```sh
ADS_LOCAL_STORE=/path/to/store.json \
  bash scripts/grokbot-native-tools/fixtures/moban-che-anhao/repro.sh
```

期望：`status.stage === "voice_plan"`，2 角色，1 场景 APPROVED，`dialogueLines === 4`，`plannedTtsCalls === 1`（整场一次，不再是 4 次百炼提交），**paidCalls=0**。导演命令、环境变量和 Pro 无损格式见 [ElevenLabs 场景对白](ELEVENLABS_TTS.md)。

## 安装与使用

```sh
node scripts/grokbot-native-tools/cli.test.mjs
node scripts/grokbot-native-tools/elevenlabs-tts.test.mjs
node scripts/grokbot-native-tools/cli.mjs help
```

APPROVE 必须带 `--approved-by user:…`（人工门，Bot 不得伪造）。  
Live 写入仍需受保护 `ADS_*` + `--execute`；`approve-*` / `voice-plan` **不提供** live 伪造路径。

Skill 注册：主 Bot `UpdateSkill` write `ai-drama-native-tools`（正文见 `grokbot-skills/.../SKILL.md`）。本 executor 可能无该工具。
