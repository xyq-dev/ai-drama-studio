# 架构决策记录（ADR）

## ADR-001：模块化单体而非微服务

**状态：已接受。** V1 采用 NestJS 模块化单体，按 Projects、Story、Script、Characters、Shots、Assets、Workflows、Providers、Exports 分模块并以领域契约隔离。三集单操作者 V1 需要强事务、低运维复杂度和快速迭代；独立部署边界仅保留 Worker、Python 媒体服务和 ComfyUI。禁止在 V1 引入微服务网关、Kafka、Temporal 或 Kubernetes。

## ADR-002：Core API 使用 NestJS

**状态：已接受。** NestJS/TypeScript 与 Next.js 共享语言和 DTO/验证习惯，适合模块化 API、鉴权、事务编排、回调入口和 SSE。Core 负责业务规则，不负责 GPU 推理或 FFmpeg 长任务。

## ADR-003：媒体服务使用 Python

**状态：已接受。** Python 适合包装 FFmpeg、媒体探测和 AI/ComfyUI 周边生态。它以受控内部 API 接受已授权的时间线/对象引用，不能直接写领域数据库或替代 Core 的状态机。

## ADR-004：使用 BullMQ

**状态：已接受。** Redis + BullMQ 足以承担 V1 可延迟、重试的调度；数据库任务和 outbox 保证它不是业务真相。禁止以队列记录替代 Job/Attempt、或以 Redis 作为最终状态来源。

## ADR-005：ComfyUI 独立部署

**状态：已接受。** ComfyUI 是可替换的本地执行器，隔离在 GPU/网络边界后经 Provider Adapter 访问。这限制 GPL、节点、模型和运行时不稳定性的影响，并避免它依赖 Core 代码/数据库。

## ADR-006：版本和 STALE 是强制机制

**状态：已接受。** 生成资产必须可审计、可比较并避免基于旧输入导出。修订追加、来源边和事务性 STALE 传播使局部重生成为可能，不允许覆盖历史或静默复用不匹配资产。

## ADR-007：V1 使用人工审核点

**状态：已接受。** V1 只有三个审核阶段：剧本门槛；视频生成前门槛（角色设定及选定参考图、以及 ShotRevision 分镜均已批准）；成片导出门槛。角色参考图和分镜预览可在最终相应审核前生成，但视频生成和导出不能绕过门槛；此约束控制成本、内容质量和错误扩散，不能由“任务成功”替代。

## ADR-008：先采用 Mock Provider

**状态：已接受。** Mock Provider 允许在未安装模型、未配置密钥、未确认许可或配额前验证状态机、幂等、回调和 UI。它是测试替身，不声称有真实媒体质量、成本或 Provider 行为的完整覆盖。

## ADR-009：事务 Outbox 是唯一队列一致性方案

**状态：已接受。** Core 每次令 GenerationJob 进入 `QUEUED` 时，在同一 PostgreSQL 事务递增 `dispatch_seq`、写入领域变化、DomainEvent 和新的 DispatchOutbox。唯一键为 `(job_id, dispatch_seq)`；dispatcher 使用 `{jobId}:{dispatchSeq}` 幂等投递 BullMQ，成功后才标记已投递，并扫描补投。dispatcher 不决定业务状态。Worker 仅在 Job 仍为 `QUEUED` 且消息 sequence 等于当前 sequence 时通过条件更新和租约取得执行权，旧消息退出。这个方案处理投递失败、事务回滚、重复消息、Redis 丢失与 Worker 重启；不得并列采用“直接投递后补偿”方案。

## ADR-010：版本指针与依赖边是唯一事实来源

**状态：已接受。** 父稳定实体的 `current_*_revision_id` 是当前版本的唯一权威，版本表不保存 `is_current`。不可变 `ArtifactDependency` 表达所有派生来源，`ShotCharacterReference` 固化镜头对 CharacterRevision 的引用。STALE 由这些边在同一事务中传播；JSONB 仅存参数快照与扩展元数据，不承载核心关系。

## ADR-011：重试使用 Attempt，手动 retry 创建新 Job

**状态：已接受。** 一个 JobAttempt 对应一次 Provider submit 或本地执行器正式执行；query、poll、callback 只创建 ProviderEvent。自动可重试故障令同一非终态 GenerationJob 回到 QUEUED、产生下一个 dispatch sequence/outbox 并创建下一个 Attempt。终态 Job 永不重开；手动 retry 仅对可重试 FAILED/CANCELED Job 创建新的局部 WorkflowRun 和新的 GenerationJob。ProviderEvent 的 `(provider_configuration_id, provider_request_id, normalized_event_key)` 唯一键吸收 callback/poll 重复，所有状态更新使用乐观并发控制与租约。

## ADR-012：DomainEvent 与 API 幂等是独立持久化事实

**状态：已接受。** 每个用户可见状态变化在其业务事务内追加 DomainEvent；SSE 只读取 DomainEvent，按可排序 id 重放，并在保留期外返回 `EVENT_CURSOR_EXPIRED`。DomainEvent 不是任务队列，不执行工作。所有要求 Idempotency-Key 的 API 写入使用 IdempotencyRecord；相同 key 与请求返回原结果，不同请求返回 `IDEMPOTENCY_KEY_REUSED`。GenerationJob inputHash 只用于生成输入复用，不能替代 API 幂等。
