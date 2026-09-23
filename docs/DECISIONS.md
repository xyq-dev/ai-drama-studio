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

**状态：已接受。** 故事/剧本、角色、分镜和成片均需要人类批准。尤其视频生成前必须有分镜审核；此约束控制成本、内容质量和错误扩散，不能由“任务成功”替代。

## ADR-008：先采用 Mock Provider

**状态：已接受。** Mock Provider 允许在未安装模型、未配置密钥、未确认许可或配额前验证状态机、幂等、回调和 UI。它是测试替身，不声称有真实媒体质量、成本或 Provider 行为的完整覆盖。

## ADR-009：事务 Outbox 是唯一队列一致性方案

**状态：已接受。** Core 在同一 PostgreSQL 事务写入 GenerationJob、领域变化和 DispatchOutbox；独立 dispatcher 在提交后以 outbox id 幂等投递 BullMQ，成功后才标记已投递，并扫描补投。Worker 通过数据库条件更新和租约取得执行权。这个方案处理投递失败、事务回滚、重复消息、Redis 丢失与 Worker 重启；不得并列采用“直接投递后补偿”方案。

## ADR-010：版本指针与依赖边是唯一事实来源

**状态：已接受。** 父稳定实体的 `current_*_revision_id` 是当前版本的唯一权威，版本表不保存 `is_current`。不可变 `ArtifactDependency` 表达所有派生来源，`ShotCharacterReference` 固化镜头对 CharacterRevision 的引用。STALE 由这些边在同一事务中传播；JSONB 仅存参数快照与扩展元数据，不承载核心关系。

## ADR-011：重试使用 Attempt，手动 retry 创建新 Job

**状态：已接受。** 一个 JobAttempt 对应一次 Provider submit；自动可重试故障令同一非终态 GenerationJob 回到 QUEUED 并创建下一个 Attempt。终态 Job 永不重开，用户手动 retry 创建新的 GenerationJob。ProviderEvent 的唯一键吸收 callback/poll 重复，所有状态更新使用乐观并发控制与租约。
