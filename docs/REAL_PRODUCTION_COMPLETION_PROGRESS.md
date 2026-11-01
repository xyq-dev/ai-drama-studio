# 真实生产功能补齐与接续记录

更新：2026-11-01。用户要求补齐现有开发文档中尚未实现的功能。本轮基线 `main@0291795029149abcedf7c41bef14c09392ef11bd`；工作分支 `feat/real-production-completion`。本文件记录实际进度，不把代码、替身验收、真实调用和线上启用混为一项。

## 目标与分工

| 工作项 | 本轮目标 | 当前状态 |
| --- | --- | --- |
| 真实媒体底座 | 既有 Job/Attempt/Asset 的一次提交收据、预算预约、UNKNOWN 恢复、对象存储与费用未知展示 | 代码已实现；默认关闭 |
| 图片、视频、配音 Adapter | 百炼北京冻结模型/地域；一次 POST；图片/视频按原 task ID 查询，TTS 恢复原加密收据 | 代码已实现；未真实调用 |
| 背景音乐 | ElevenLabs `music_v2` 纯伴奏、明确时长；私有二进制收据、MP3→WAV、S3 | 代码已实现；未真实调用 |
| 角色声音与逐句制作 | 声音版本、原文/段落保真、逐句报价/生成/试听/选用、实测 VTT 与 typed 依赖 | 代码已实现；真实人声质量未验收 |
| V1-D 整集声音补齐 | 固定逐句报价/币种总额、永久操作键、部分完成、独立取消/显式恢复，沿用原 Job | 代码已实现；batch 新增 PostgreSQL 用例待最终 HEAD CI |
| 合成与导出 | S3 成功来源 receipt、新声音 profile 超时拒绝、中文字体 guard、旧 v1 保留、原审核/整集导出 | 代码已实现；synthetic 技术测试与真实短片验收分开 |
| ViMax 剩余平台集成 | 单场景一次文本授权、共享日额/并发、永久幂等、租约和 UNKNOWN、页面候选回传 | 代码已实现；默认关闭，真实规划未验收 |
| 工作台与配置接线 | 服务端引用、explicit provisioning、默认关闭、页面确认/恢复、API/Worker 注入 | 已接线；实际业务库/服务器未启用 |
| 验证、Review、Git | 定向回归、三个独立空库 suite、交叉审查、当前 HEAD CI 后正常集成 | 定向测试/审查持续收尾；最终 PR/CI/merge 以实际记录为准 |

## 不变量

- PostgreSQL 仍是业务任务真相，沿用 GenerationJob、JobAttempt、ProviderEvent、Asset、CostLedger 和 Outbox；不另造第二套任务数据库。
- Mock 路由及其零成本、固定素材与生产禁用校验保留。真实媒体使用独立提交与计费路径，不把真实素材改名冒充 Mock。
- 外部请求前持久提交意图；可能已发出但未获 ID 的结果为 UNKNOWN，不自动重发、不自动换供应商。已获任务 ID 的恢复只查询原任务。
- 存储失败只恢复原输出，不重复生成；临时签名 URL 与内部输出收据加密私有保存，不回传浏览器。
- 每次真实调用有独立且有上限的显式授权。usage 是用量事实，不能凭用量写 ACTUAL；未知金额保持 unknown。
- 角色 AUDIO 通过选用关系确认，不修改既有 SQL 使 AUDIO 被标成 APPROVED。新声音 profile 不裁掉对白尾部；旧 v1 历史快照不回写。
- 复用原有人工审核、工作区隔离、来源版本与 STALE 传播。系列 1–60 集仍只交付文本，不顺带开放系列媒体生产。

## 权限与实际执行

常规代码、测试、选择性 commit、push、PR 和通过当前提交 CI/Review 后的正常 merge，按 `ENGINEERING_WORKFLOW.md` 持续授权推进。

本轮不执行真实付费模型调用、业务库 SQL 或服务器部署。新数据库结构先放独立 `prisma/drafts`，不加入默认迁移发现目录，不在启动或读取时自动执行。审查通过后仅可在有名称与空库保护的一次性隔离验收中验证；业务执行和实际付费验收需有相应明确授权及可用连接。

当前实际：**真实模型调用 0；业务库 SQL 0；部署未执行。** 尚未取得的验收不标通过，替身/合成素材只证明协议及工程链路。

## 实现检查点

主体模块、API 服务注册、Worker 分发、启动参数与工作台入口已落入分支。运行开关、密钥轮换、显式 provision plan/execute 与独立验收入口已统一到 [`REAL_MEDIA_RUNBOOK.md`](REAL_MEDIA_RUNBOOK.md)。新 schema 仍未安装到业务库；没有因此运行真实模型或部署服务器。

供应商协议、配置、领域、API、Worker、Web 的定向测试与类型检查已有通过记录；计数交叉，不相加伪作最终总数。Python 实际技术素材验证完整句尾、停顿、ducking、mute 和 MP4；中文字幕实渲染需真实 Noto 字体，缺字体 skip 不记通过。新套件支持保存带字体 SHA 的截图证据，但不证明 AI 人声质量或人工审阅通过。新增四份 SQL 草案及三个独立空库验收 suite 已编写，speech suite 已纳入 batch；业务 SQL 与付费模型为零。最终完整测试、空库实际执行、Review 和集成以当前提交记录为准。

### 首轮独立数据库与中文渲染 CI（仅对应 `b1980f1`）

提交 `b1980f138b78261d567210f5c72ae2e45da1f861` 的 [Run 41292829594](https://github.com/xyq-dev/ai-drama-studio/actions/runs/41292829594) 四个 job 全部 success，产生四个可查 artifact：

| 独立验收 | 实际结果 | 边界 |
| --- | --- | --- |
| speech | 9 项通过 | 专用新空 PostgreSQL 库，测试合成素材；非业务库、非真实 TTS |
| ViMax planning | 9 项通过 | 专用新空 PostgreSQL 库；没有模型发送 |
| real-media | 5 项通过 | 专用新空 PostgreSQL 库，synthetic 收据/产物；没有供应商调用 |
| 中文声音渲染 | 10 项通过，0 skip | 真实 Noto Sans CJK SC + FFmpeg 技术素材与字体/截图证据；不是 AI 人声质量验收 |

另有 118 项纯 guard 测试，不与 PostgreSQL 项数相加。最新本地 Web 983 项通过，1280/390 的真实 React/Chromium fixture client 流程通过；它不是真实 API/数据库端到端验收。**后续音乐 fade（Python 套件增至 11 项）、portable speech provenance、V1-D batch 等变化必须由新的当前 HEAD CI 重新验证，不能沿用 `b1980f1` 的 success。** 本轮模型/业务 SQL/部署仍为 0。

自动编剧复核：1–6 集短剧与 1–60 集系列是两个现有模式。系列核心规划/正文批次/台账/总检/人工复核/交付包均已有代码，没有新增一套待实现的文本流水线；保留 JSON 编辑、无模型定向重写已完成批次等既知限制。真实 60 集输出质量未验收，系列媒体仍明确关闭。角色声音 V1-D 已接入短剧剧本页及 SpeechController，新增 batch draft 保持独立；domain/API 纯单元及 store/UI 替身覆盖与最终 PostgreSQL 验收分开记录。取消仅停止后续创建 Job，已有 queued/运行 Job 在原任务面板独立取消；`dispatched` 不代表供应商发送或收费。克隆/口型/重叠对白和自托管 GPU 不在已完成声明中。

页面证据：`scripts/real-production-ui-check.mjs` 使用真实 React 与 Chromium 的 fixture client，覆盖 1280/390 下单次确认、UNKNOWN 和刷新只查询；它不是实际 API/数据库或真实模型验收。最终截图 artifact 与当前提交 CI 关联，不能替代业务库/CJK/人声质量验证。

## 接续方法

先读取本文件及分支关联 PR，核验远端 HEAD、当前工作区和未提交改动。保留其他执行者的文件；不使用 force push、reset 或 clean。按尚未完成的工作项接续，优先消除真实失败，不重复实现已完成模块。每个检查点应记录提交、测试证据和剩余接线。
