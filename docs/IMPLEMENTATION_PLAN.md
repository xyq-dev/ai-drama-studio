# V1 实施计划

## 2026-11-01 当前实现与执行边界

本轮从 `main@0291795029149abcedf7c41bef14c09392ef11bd` 补齐真实媒体收据/预算/恢复/S3、图片/视频/TTS/音乐 Adapter、逐句声音与新混音 profile、ViMax 一次规划治理及页面接线。代码已实现；开关默认关闭，三个新增 SQL 草案不进入默认 migration。运行与验证入口见 [`REAL_MEDIA_RUNBOOK.md`](REAL_MEDIA_RUNBOOK.md)，实际进度见 [`REAL_PRODUCTION_COMPLETION_PROGRESS.md`](REAL_PRODUCTION_COMPLETION_PROGRESS.md)。本轮真实付费调用、业务 SQL、服务器部署均为 0；不能把 synthetic 测试写成真实 AI 验收。

下面 M1–M4 是原里程碑定义与历史准入标准，不因新 Adapter 存在而改写为完整生产验收通过。

## M1：平台骨架

| 项目 | 定义 |
| --- | --- |
| 目标 | 建立可启动的最小骨架：模块化单体、单工作区边界、PostgreSQL、Redis、MinIO、带 dispatch sequence 的事务 outbox、DomainEvent SSE 重放与 Mock Provider。 |
| 工作范围 | 仅 `pnpm + Turborepo`，`apps/web`、`apps/api`、`apps/worker`、`services/media-worker`、`services/comfyui-adapter`（后二者仅空壳/健康检查），及 `packages/contracts`、`packages/database`、`packages/domain`、`packages/providers`；Mock GenerationJob 成功/失败/取消/恢复闭环、IdempotencyRecord、DomainEvent、健康检查和基础测试。 |
| 禁止范围 | 真实 LLM/图片/视频生成、ComfyUI 实际部署、完整创作 UI、三集生产、真实媒体合成、支付、协作、多租户、云部署和自动发布。 |
| 依赖 | PostgreSQL、Redis、MinIO/S3 开发凭据、运行时密钥注入方案。 |
| 数据库变化 | 只实现支撑 Mock 闭环的最小 Workspace/Project、WorkflowRun、GenerationJob（含 `dispatch_seq,row_version,next_run_at,lease_owner,lease_until,is_critical,progress_weight`）、JobAttempt、GenerationJobDependency、DispatchOutbox、DomainEvent、IdempotencyRecord、ProviderConfiguration、ProviderEvent 与成本记录骨架；UploadSession 仅保留后续模型契约，M1 不提供用户上传接口，MinIO 仅健康检查。不得实现故事、剧本、角色、场景或镜头生产数据模型。 |
| API | 健康检查、最小 Projects、Mock jobs/runs 查询和取消、SSE 重放、Mock capabilities；不提供用户上传、真实生成或三集创作 API。 |
| 测试 | 事务约束、通用 API 幂等、重复/旧 dispatch 消息、Worker 崩溃恢复、DomainEvent SSE 重放与 `EVENT_CURSOR_EXPIRED`、工作区过滤。 |
| 验收标准 | 单 Job WorkflowRun 的 Mock job 可到达成功/失败/取消并保留完整审计；Schema/契约已支持后续 Job DAG；自动重试产生新的 Attempt 和 dispatch sequence；SSE 从 DomainEvent 重放；PostgreSQL 是恢复依据。 |
| 风险 | 把队列状态当真相；以 outbox、租约和恢复测试控制。 |
| 进入 M2 条件 | 验收通过，数据模型和错误码冻结为可兼容演进。 |

## M2：文本创作链

| 项目 | 定义 |
| --- | --- |
| 目标 | 从创意到已审核的三集故事、剧本、角色和场景/镜头草稿。 |
| 工作范围 | Story/Script/Character/Scene/Shot 修订、审核门、STALE 传播、文本 Adapter 与 Mock 回归。 |
| 禁止范围 | 图片、视频、配音、合成和自动发布。 |
| 依赖 | M1 修订/工作流/审计、Provider 契约、UI 版本比较。 |
| 数据库变化 | StoryRevision、ScriptRevision、CharacterRevision、Location、Scene、Shot、ShotRevision 与来源边/审核字段。 |
| API | Stories、Episodes、Scripts、Characters、Scenes、Shots。 |
| 测试 | 三集约束、乐观并发、审核阻断、三类 STALE、inputHash 稳定性。 |
| 验收标准 | 可得到三集已审核剧本并局部修改镜头，且不覆盖历史版本。 |
| 风险 | 失效传播过宽或过窄；以显式来源边和金标用例控制。 |
| 进入 M3 条件 | 审核与 STALE 测试稳定，文本 Provider 可替换且 Mock 合约通过。 |

## M3：媒体生成链

| 项目 | 定义 |
| --- | --- |
| 目标 | 为已审核镜头生成图片、视频、配音、字幕和音乐；支持本地/商业 Provider 共存。 |
| 工作范围 | 六类 Adapter、ComfyUI 网络边界、回调/轮询、超时/重试、成本落账、媒体校验和对象存储。 |
| 禁止范围 | 将 ComfyUI/模型逻辑耦合进 Core、批量生产、自动发布。 |
| 依赖 | M1/M2、Provider 凭据、已核验许可、GPU/商业 API 测试配额。 |
| 数据库变化 | Provider 回调去重、媒体 metadata、attempt 原始响应受限引用、成本单位/估算标记。 |
| API | 逐镜图片/视频、Provider callbacks、Asset 查询和 job retry。 |
| 测试 | 同步/异步、回调迟到/重复、超时 query、取消、费用不重复、单镜隔离。 |
| 验收标准 | 同一镜头可经 Mock、ComfyUI（若授权）或商业 Adapter（若授权）执行，且调用可审计。 |
| 风险 | 幂等语义和许可不一致；逐 Adapter 进行能力/合同核验后才启用。 |
| 进入 M4 条件 | 受控集成环境通过恢复、成本、回调和单镜隔离验收。 |

## M4：完整三集闭环

| 项目 | 定义 |
| --- | --- |
| 目标 | 合成、成片审核和 1080x1920 MP4 导出，完成一个三集 V1 验收样本。 |
| 工作范围 | Python Media Service、RenderProvider、时间线验证、字幕/音频混合、成片审核、导出下载和可观测性。 |
| 禁止范围 | 平台发布、收益、支付、多租户、移动端和 30–100 集批处理。 |
| 依赖 | M3 媒体资产、FFmpeg 构建/许可核验、存储生命周期和导出安全策略。 |
| 数据库变化 | 合成/导出 Asset 来源清单和审核记录；不改写历史。 |
| API | compose、exports 与下载授权。 |
| 测试 | 帧尺寸/时长/MP4 可播放检查、STALE 输入拒绝、成片退回、失败恢复、整剧成本汇总。 |
| 验收标准 | 一个创意产出三集 60–90 秒、审核通过、非 STALE 的 1080x1920 MP4，可下载且来源/成本完整。 |
| 风险 | 转码资源和存储成本；以配额、超时、临时对象清理和负载测量控制。 |
| 下一阶段进入条件 | V1 样本、运行手册、许可/SBOM 复核完成；之后另行立项。 |

各项是否达到上表标准，以 [`M4_CLOSEOUT_REPORT.md`](M4_CLOSEOUT_REPORT.md) 的验收矩阵为准。该记录不改写本表，也不把部分通过写成完整 M4。

## 商业创作者界面

面向独立 AI 短剧创作者的第一版界面见 [`COMMERCIAL_PRODUCT_PLAN.md`](COMMERCIAL_PRODUCT_PLAN.md)。这一阶段只调整 Web 的产品入口、创作中心、工作台布局和只读预览。它不改写上面的 M1–M4 验收结论，也不表示产品已经可以公开商业运营。

## 角色配音：当前实现与待验收

设计基线与实施顺序见 [`CHARACTER_VOICE_DESIGN.md`](CHARACTER_VOICE_DESIGN.md)，选型证据见 [`VOICE_OPEN_SOURCE_RESEARCH.md`](VOICE_OPEN_SOURCE_RESEARCH.md)。将固定角色声音、逐句生成试听与选用、真实时长检查、字幕和混音嵌入新手五步流程，沿用现有版本、任务、来源失效和审核边界。

声音版本、精确对白计划、逐句报价/生成/试听/选用、UNKNOWN 收据恢复、实测时长 VTT 与 `local-ffmpeg-voice-v1` 已编码并接入既有 `MEDIA_COMPOSE`、审核和整集导出。TTS 固定百炼北京 `qwen3-tts-flash` 预置音色；只开放目录声明支持的 neutral/固定语速，不提供克隆、发音词典、口型或重叠对白。AUDIO 仍为 DRAFT，通过显式选用关系进入混音，不放宽 APPROVED 约束。

首个真实质量验收仍为同一场景双角色 4–8 句中文短片：必须实际试听完整对白、核对中文字幕与角色声音，不以静音、正弦波或 synthetic MP4 代替。SQL 草案、有限付费试验与部署需分别授权。逐句可明确重做；原设计 V1-D 的预算内整集补齐/批量幂等正在本轮补齐，最终状态以 batch 实现及当前提交 CI 为准，不能预先写成通过。系列 1–60 集仍仅支持文本。

## 分镜规划：ViMax 复用评估（E1、E2-A 与 E2-B）

设计见 [`VIMAX_SCRIPT2VIDEO_EVALUATION.md`](VIMAX_SCRIPT2VIDEO_EVALUATION.md)。保留现有平台，以短剧中已批准剧本的一个场景为范围，评估 Script2Video 文本规划候选向既有拆解与 Scene/Shot 修订的映射。该入口仍会调用模型，不能当作零调用纯函数。

| 阶段 | 交付与准入 | 状态 |
| --- | --- | --- |
| E0 文档 | 固定上游 SHA、核对契约/许可/重试，写明接入边界 | 已完成文档评估，未实现接入 |
| E1 离线原型 | 合成/脱敏单场景、冻结候选、无网络映射与反例，明确无损表达缺口 | 已实现；[使用说明与边界](VIMAX_OFFLINE_EVALUATION.md)，尚无平台/真实模型接入 |
| E2 平台集成 | 单场景作用域、严格候选、一次调用确认、共享写作额度、永久幂等、租约与 UNKNOWN、两段式人工保存 | E2-A/E2-B 与发送治理代码均已实现并接线；默认关闭，草案业务库未启用。替身与独立空库 suite 的结果分开记录，见[接续记录](VIMAX_E2B_PROGRESS.md)与[运行手册](REAL_MEDIA_RUNBOOK.md) |
| E3 真实文本试验 | 独立确认一次单场景的供应商/模型/调用预算，人工评审分镜质量 | 未授权、未执行 |
| E4 媒体扩展 | 参考图、候选评审、视频与声音分别设计、核验并授权 | 不在本项范围 |

不得把上游隐式重试、多候选或缓存恢复放在预算外；不得将机位视觉依赖当作剧情伏笔依赖。系列文本 15 / 19 / 96 次公式与旧授权不包含此功能；系列媒体限制和现有 M1–M4/配音设计的验收结论保持不变。

## 自动编剧 1–60 集复核

当前短剧自动创作仍为 1–6 集；1–60 集走独立系列编剧。全剧规划、每 3 集批次、连续性台账、批次/总检、人工修改/复核、正式分集与交付包链路均已有实现，未发现另一个待实现的核心文本阶段。60 集正常调用仍为规划 15、规划加首批 19、全剧 96，均非含重试的费用授权。保留 [`SERIES_WRITING.md`](SERIES_WRITING.md) 的限制：JSON 编辑、无模型重写已完成批次/定向修改轮次、真实 60 集质量与篇幅稳定性未验收，以及显式关闭的系列媒体；不将这些改写为本轮新增范围。
