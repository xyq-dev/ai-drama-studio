# V1 当前启用与真实验收清单

更新：2026-11-02。核查代码为 `main@120cf8b6138547c85615e312519eee7d0ea8057f`（PR [#100](https://github.com/xyq-dev/ai-drama-studio/pull/100)）。代码和合并后 CI 已完成，真实供应商质量、业务库启用与服务器运行状态仍待核实，见[接续记录](REAL_PRODUCTION_COMPLETION_PROGRESS.md)。本文件替换原 2026-10-06 操作清单；旧交付事实保留在 [V1 台账](V1_DELIVERY_MATRIX.md)，不能再按退役配置执行。

## 首选下一步

先交付**同场景、双角色、4–8 句中文真实短片**，复用当前声音版本、逐句制作、选用、中文字幕、混音、人工审核和导出。先确认完整对白、两个角色音色与成片来源，不直接扩大到三集、60 集或系列媒体。真实验收必须记录输入版本、Job/Attempt/Asset、实测时长、审核/导出结果、请求次数及费用已知/未知；协议替身、静音或正弦波素材不能替代。

## 授权与外部条件

| 事项 | 已有范围 | 还需落实 |
| --- | --- | --- |
| 普通代码与 Git | 按 [ENGINEERING_WORKFLOW.md](ENGINEERING_WORKFLOW.md) 持续授权：必要验证后提交、普通推送、PR；当前提交 CI/Review 通过后正常 merge | 保留已有改动，不 force push，不绕过质量门 |
| 指定测试站点代码部署 | `https://drama.playhubs.cn` 已有持续授权 | 当前会话没有可用服务器执行入口；需记录部署前/后精确 SHA、回退版本及页面/health 实测。不能把 GitHub Release 当成部署 |
| 新 SQL、Migration 与业务数据写入 | 普通 Git/部署授权不包含这些操作；隔离新空库 CI 已通过 | 明确目标库、前置结构、最终审查 SHA、影响/锁表、备份与恢复方案及专项执行授权。包括 ProviderConfiguration provisioning 写入 |
| 真实付费调用 | 代码具备报价与单次授权，不等于已获外部消费授权 | 核对账号、模型/地域、当前单价、配额与许可；冻结本次操作范围、请求数、币种及费用上限。密钥仅由服务端安全注入 |
| 真实质量与成本 | 技术合成/数据库/HTTP 已有 CI 证据 | 人实际看画面、听完整对白、核对中文字幕与选声；云账单与估算分开，未知金额不能补 ACTUAL 0 |

不在聊天、Git 或公开日志中提供密码、API key、数据库连接串、签名 URL 或私有收据。配置可用性报告只记录是否就绪和非敏感版本标识，不输出值。

## 数据库依赖

当前普通 migration 目录为 `packages/database/prisma/migrations/`。新能力仍依赖独立 `packages/database/prisma/drafts/`；以下文件不是可直接对业务库执行的命令清单：

| 能力 | 草案文件 | 前置与边界 |
| --- | --- | --- |
| 角色声音、逐句计划与选用 | `20261101000100_character_voice.sql` | 依赖现有文本链、媒体资产与资产依赖等普通迁移 |
| 真实媒体报价/授权/提交收据 | `20261101000200_real_media.sql` | 沿用既有 Job/Attempt/Asset；启用仍需认证、媒体配置与显式 provisioning |
| 预算内整集声音补齐 | `20261101000300_speech_batch.sql` | 依赖 character-voice 的逐句结构；实际 TTS 另需 real-media 结构和准入 |
| ViMax 一次规划 | `20261101000100_vimax_planning_request.sql` | 依赖 `20261031000100_vimax_storyboard_candidate.sql`，candidate 又依赖既有 script-breakdown 普通迁移；还需有效标题写作配置与批准输入 |

普通 `migrate`、启动和 GET 不会安装这些 drafts。专用空库验收只证明对应结构和工程规则；不授权在现有开发库、测试站点库或生产库执行。业务启用前须对精确文件/数据库另行制定并审查执行计划；若转正式 migration，使用新文件，经 Review/CI，不改写已应用文件或默认自动启用。代码回退保留历史记录，不顺带下迁移或删除数据。

角色参考图的旧独立草案及 `M3_CHARACTER_REFERENCE_GATE` 见 [CHARACTER_REFERENCE_IMAGES.md](CHARACTER_REFERENCE_IMAGES.md)。当前固定真实视频 profile 不能证明严格角色参考来源，strict 模式应拒绝；不得为跑通短片而临时放宽已有严格门或把 Mock 图当真实参考图。

## 当前配置入口

精确变量、API、密钥轮换和隔离验收命令统一以 [REAL_MEDIA_RUNBOOK.md](REAL_MEDIA_RUNBOOK.md) 为准，不在此复制另一套参数：

- 文本模型通过 `/admin/models` 配置，当前支持 OpenAI、Anthropic 与 DeepSeek。**千问文本已退役**，不再按旧 `QWEN_*` 网页调用或旧千问 SQL 清单启用。
- 平台媒体使用独立 `DASHSCOPE_MEDIA_*`；固定图片/视频/TTS profile 为百炼北京 `qwen-image-3.0`、`wan2.6-i2v-flash`、`qwen3-tts-flash`，音乐为 ElevenLabs `music_v2`。这是代码选择，不是账号资格或当前报价证明。可选图片 `gpt-image-2.5-sunburst` 只有 `REAL_MEDIA_IMAGE_PROVIDER=openai-media` 才出现，配置与“尚未实付费”的边界见 [OPENAI_IMAGE_SUNBURST.md](OPENAI_IMAGE_SUNBURST.md)。
- API/Worker 需一致的有效站点认证、workspace、价格/凭据/收据版本与 S3；声音合成另需 FFmpeg、受控绝对目录及实际 Noto Sans CJK SC 字体。默认开关关闭，production 另需进程级准入；开关不构成付费授权。
- 当前 `real-media:provision` 默认 **plan** 不创建数据库连接、不写库、不调用供应商；它需要受控配置，但不是连接/账号/S3 就绪验证。带 `--execute` 才写 ProviderConfiguration，必须另有目标库写入授权；不会执行 migration。

独立 [REAL_MEDIA_PILOT.md](REAL_MEDIA_PILOT.md) 工具仍只用于仓库外试接，使用自己的历史配置与价格快照；它不注册业务 Asset，不能替代平台真实验收，也不应把它的旧密钥变量复制到平台。

## 执行顺序与交付证据

1. 先只读核实站点运行 SHA、数据库标识/已安装结构、认证/S3/字体与配置就绪状态。当前未完成，不把仓库默认值当服务器事实。
2. 需要业务结构变更时，先明确精确 SQL/目标库及专项授权，再审查和实施；provision 写入与代码部署分别记录。保留默认关闭状态，直到对应准入完整。
3. 形成这次 4–8 句真实试验的逐项报价与预算，取得范围明确的付费授权后执行。源码或 UI 里的默认金额不是本次预算。
4. 每句沿原报价、幂等键和 Job 恢复；无远端 ID 的 UNKNOWN 不自动重发，有 ID 只查询原任务。存储恢复不重新生成。取消只阻未创建 Job，已有任务独立处理。
5. 试听并选用完整对白、合成中文字幕、人工审核与导出，记录运行 SHA、输入/素材版本、MP4/来源清单、实测时长、调用数、已知/未知费用和人工结论。通过后再决定扩大真实样片规模。

本次只完成 GitHub 状态核查和交接文档更正：**供应商调用 0、业务 SQL 0、服务器部署 0**。尚未提供服务器执行入口、目标库专项授权和本次真实试验的已确认价格/预算，不能记为已启动真实验收。
