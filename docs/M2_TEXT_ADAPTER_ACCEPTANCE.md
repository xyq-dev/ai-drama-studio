# M2-D 文本 Adapter 验收记录

- 范围：Scene/Shot 三集结构化文本生成，不含真实厂商、媒体、UI 或新业务 API。
- 契约：可序列化的冻结来源请求、严格 Scene/Shot 批次输出、可执行的规范化错误协议，以及仅允许 `REPLAY_SAFE_SYNC` 的 Adapter 接口。
- 默认实现：确定性 `MockTextAdapter`，文案与原 Mock 行为兼容。
- 保存：数据库仅校验来源身份、批次完整性、ordinal 和字段上限，并沿用既有 Job 成功原子事务保存；无部分落库。
- 错误：`AUTH`/`VALIDATION` 等终态错误进入既有失败路径；retryable 错误沿用 Attempt 上限，等待时间取确定性退避与 Provider `retryAfterMs` 的较大值，并同步保存至 Job 和 Outbox；返回或抛出的 `UNKNOWN`（不论 retryable 值）均保持非终态；`CANCELED` 统一进入既有取消确认路径。
- 重试回归：返回和抛出的限流/配额错误均保留冷却时间；冷却结束前不可获取新 Attempt，不写业务结果；未提供或较短的等待提示不缩短既有退避，超过退避上限的提示仍受尊重。
- 恢复：集成测试从 `MockJobConsumer` 保存原 Mock request id，在 Adapter 已生成输出、成功事务尚未开始时注入崩溃，再由新的 `RuntimeReconciler`/Adapter 实例重建完整冻结内容；原 request id 和审计不改写，并断言 request/context、首次输出、最终来源与实际文案一致，只保存一批，二次 reconcile 不重复。独立远程 `UNKNOWN` 用例保持同一 request id、不调用文本 Adapter、不写业务表。
- 可替换性证据：Worker HTTP/BullMQ 集成测试注入独立 `DistinctTextAdapter`，公开 Scene/Shot 历史 GET 返回其不同文案。
- 数据库：无 Schema 或 Migration 变化。
- 未覆盖：非确定性、无可靠幂等保证或远程异步文本 Provider；当前接口在装配/调用边界拒绝非 `REPLAY_SAFE_SYNC` Adapter，不伪造这些能力。
