# V1 实施计划

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
