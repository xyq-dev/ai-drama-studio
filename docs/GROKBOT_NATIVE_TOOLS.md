# GrokBot 原生短剧工具（首条完整流程）

更新：2026-11-03（Asia/Shanghai）。分支：`feat/grokbot-native-drama-tools`。

目标：聊天为入口，不依赖打开原网站完成**作品创建 / 查询 / 继续 + 保存剧本修订 + 查状态**。  
配套：`scripts/grokbot-native-tools/`、`grokbot-skills/ai-drama-native-tools/SKILL.md`。  
编排总表仍见 `docs/GROKBOT_ORCHESTRATION.md`；真片授权包见 `docs/FIRST_REAL_SHORT_AUTH_PACKET.md`。

## GrokBot 扩展机制（实测）

| 机制 | 实际能力 | 本迁移用法 |
| --- | --- | --- |
| Skill（`SKILL.md` + `UpdateSkill`） | 可复用步骤菜谱；用户 `/` 或 `@` 触发；**不是**任意 RPC | 仓库内草案 + 安装说明；由具备 `UpdateSkill` 的主 Bot 写入用户 Skill |
| `/home/box/agent-data/workflows` | 目录存在，当前为空；例行任务走 Routine，不是放业务 DB | 不把项目状态写进 workflows |
| Shell + 仓库 CLI | 主/子 Bot 可在 box 跑 `node` 脚本 | **本 PR 主路径** |
| MCP | 仅已安装且 `GetMcpServerStatus` 可见的连接器 | **无** ai-drama MCP；禁止假装存在 |
| 原站 Cookie 会话 | 站点强制登录；CSRF + Origin | live 模式从受保护 env 文件读取，不进聊天 |

Skill **能做**：指导 Bot 何时跑哪条 CLI、如何汇报、如何拒绝付费。  
Skill **不能做**：代替 PostgreSQL 任务真相、自动审核、伪造 MCP、持久后台 Worker。

## 短清单：原功能 → Bot 入口 → 验收证据

| 原功能 | Bot 入口（Skill / CLI） | 验收证据 | 本 PR |
| --- | --- | --- | --- |
| 创建作品 | Skill → `cli.mjs create` | store / API 返回 `project.id` + title | **首条（已实现）** |
| 查询作品列表 | `cli.mjs list` | 列表含 id/title/updatedAt | **首条** |
| 继续作品 | `cli.mjs continue` | `currentProjectId` 切换并可再 status | **首条** |
| 保存剧本修订 | `cli.mjs save-script` | 新 revision DRAFT + contentHash | **首条** |
| 查状态/阻塞 | `cli.mjs status` | blockers（如未 APPROVED） | **首条** |
| 进度/费用/媒体能力 | orchestration `progress` dry-run / live health | JSON 映射，默认可 dry-run | 编排 PR |
| 待审核汇总 | orchestration `pending-review` | 只读路径列表 | 编排 PR |
| 报价/授权/生成 | orchestration quote；需用户授权包 | 无默认付费调用 | 后续 |
| 配音/分镜/合成/导出 | 现有 API；Skill 后续扩展 | 真片验收 | 后续 |
| 系列 1–60 文本 | 现有 series writing | 不扩媒体 | 后续单列 |

**首条完整流程（本 PR）**：`create → save-script → status`（可插入 `list` / `continue`），默认本地 store；有凭据才 `--live`。

## 安装与使用

### CLI（开发/测试环境）

```sh
cd /path/to/ai-drama-studio
node scripts/grokbot-native-tools/cli.mjs help
node --test # or:
node scripts/grokbot-native-tools/cli.test.mjs
```

本地持久化：

```sh
export ADS_LOCAL_STORE="$HOME/.local/share/ai-drama-studio/store.json"
node scripts/grokbot-native-tools/cli.mjs create --title "雨夜站台" --premise "……"
node scripts/grokbot-native-tools/cli.mjs save-script --text-file ./sample-script.txt
node scripts/grokbot-native-tools/cli.mjs status
```

Live（站点会话已由受保护渠道配置）：

```sh
cp scripts/grokbot-native-tools/config/ads.env.example ~/.config/ai-drama-studio/ads.env
# 填入 ADS_* 后 chmod 600；不要提交、不要贴进聊天
node scripts/grokbot-native-tools/cli.mjs list --live --env-file ~/.config/ai-drama-studio/ads.env
# 写入需显式：
node scripts/grokbot-native-tools/cli.mjs create --title "…" --live --execute --env-file ~/.config/ai-drama-studio/ads.env
```

### Skill 安装

1. 合并本 PR 后，主 Bot（具备 `UpdateSkill`）读取 `grokbot-skills/ai-drama-native-tools/SKILL.md`。
2. `UpdateSkill` action `write`，name=`ai-drama-native-tools`，body=该文件正文（可去掉仅仓库说明段）。
3. 用户侧用 `/ai-drama-native-tools` 或自然语言触发；链接形态：`[ai-drama-native-tools](sand-workflow:ai-drama-native-tools)`（以实际 id 为准）。

本 executor 子代理**无** `UpdateSkill` / CloudAgent / git push 凭据时，只能交付仓库草案 + 本地验证；由主 Bot / Repo Engineer 完成推送与 Skill 注册。

## 非目标

- 不部署 production、不执行业务库 migration、不 force push。
- 不把 Mock/静音标为真实质量通过。
- 本地 store ≠ GenerationJob 权威库；上线媒体制作仍以服务器 DB 为准。
