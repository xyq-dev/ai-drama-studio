# 工作流与任务状态机

## GenerationJob 状态

```mermaid
stateDiagram-v2
  [*] --> PENDING
  PENDING --> QUEUED: transaction writes next dispatchSeq and outbox
  PENDING --> CANCELED: cancel before dispatch
  QUEUED --> RUNNING: worker acquires lease
  QUEUED --> CANCELED: cancel
  RUNNING --> WAITING_EXTERNAL: provider accepted async request
  RUNNING --> SUCCEEDED: synchronous result persisted
  RUNNING --> QUEUED: retryable failure / retry due
  RUNNING --> FAILED: terminal failure
  RUNNING --> CANCELED: cooperative cancel
  WAITING_EXTERNAL --> RUNNING: callback or poll result
  WAITING_EXTERNAL --> QUEUED: timeout / retry due
  WAITING_EXTERNAL --> CANCELED: cancel requested and provider cancel resolved
  WAITING_EXTERNAL --> SUCCEEDED: callback result persisted
  WAITING_EXTERNAL --> FAILED: terminal provider failure
  SUCCEEDED --> [*]
  FAILED --> [*]
  CANCELED --> [*]
```

合法转换仅限上图。终态 `SUCCEEDED`、`FAILED`、`CANCELED` 不可重新打开；每次进入 `QUEUED` 都在同一事务递增 `dispatch_seq`、创建新的 DispatchOutbox 和 DomainEvent。Dispatcher 不变更业务状态，只投递 `{jobId}:{dispatchSeq}`。API 对非法转换返回 `JOB_INVALID_TRANSITION`。

## 重试、超时与取消

- 默认最多 3 次实际 Provider 尝试（首次 + 最多 2 次重试）；Provider 配置可把上限调低，不能由客户端调高。只重试网络中断、429、5xx、可证实的临时 Provider 错误和租约丢失；不重试验证、策略、认证、配额耗尽或不兼容输入错误。
- 退避为 `min(15 min, 30 s * 2^(retry_count-1))` 加 0–20% 随机抖动；Provider `Retry-After` 优先。每次尝试和费用独立记录。
- 任务有软超时和硬超时。软超时触发 query/poll；硬超时尝试 `cancel`，保留 `WAITING_EXTERNAL` 直到获得终态或达到回收阈值，随后标记 `FAILED/TIMEOUT`。不因网络超时假设 Provider 未执行。
- 取消是请求而非即时承诺：未领取任务直接 `CANCELED`；运行中写 `cancel_requested_at`，Worker 先调用 Provider cancel，安全点前停止媒体工作。若结果已持久化，则返回成功事实，取消不回滚资产或成本。

## 幂等与恢复

所有幂等 API 写入使用 IdempotencyRecord，而不是 GenerationJob inputHash：同一工作区、操作者、方法、route 与 key 的相同 request_hash 返回已保存结果，不同 hash 返回 `IDEMPOTENCY_KEY_REUSED`。记录和业务写入使用同事务占位/完成协议。Worker 只在消息 `dispatchSeq` 等于 Job 当前 `dispatch_seq` 且 Job 仍为 `QUEUED` 时，以 `row_version` 条件更新领取租约；旧分发消息安全退出。租约过期的 `RUNNING` job 由 reconciler 查询或重新进入 `QUEUED`，不由旧消息直接接管。提交前持久化 attempt 和 deterministic client request key；Provider request id 到账后立即持久化。

Worker 重启时，reconciler 扫描过期租约、`WAITING_EXTERNAL` 和 outbox 未投递记录：有 provider request id 的任务先 query；没有 request id 的任务让同一 Job 再次进入 `QUEUED` 并产生新的 dispatch sequence/outbox。重复回调/轮询以 `(provider_configuration_id, provider_request_id, normalized_event_key)` 的 ProviderEvent 唯一键吸收；stable event id 可直接作为 key，缺失时由 request id、远程状态版本/更新时间与规范化响应哈希确定性生成，poll 同样如此。孤儿任务（队列无消息、状态可运行且超过调度宽限）以新的 dispatch sequence 重新入队；孤儿 Provider 请求（仅有 attempt）先查询后决定成功、重试或人工介入，绝不盲目重提。所有用户可见状态变化同时追加 DomainEvent，SSE 仅从其重放。

## 短剧生产工作流

```mermaid
flowchart LR
  I[创意] --> S[故事设定]
  S --> SC[生成三集剧本]
  SC --> SA{剧本审核}
  SA -->|批准| CA[角色设定及参考图]
  CA --> CR{角色审核}
  CR -->|批准| SB[场景 镜头 分镜预览图]
  SB --> SR{分镜审核}
  SR -->|批准| IM[镜头图片]
  IM --> VI[镜头视频]
  VI --> AV[配音 字幕 音乐]
  AV --> CO[合成]
  CO --> FA{成片审核}
  FA -->|批准| EX[MP4 导出]
  SA -->|退回| SC
  CR -->|退回| CA
  SR -->|退回| SB
  FA -->|退回| CO
```

每一箭头可创建 `WorkflowRun`，其子 job 以 `GenerationJobDependency` 持久化依赖关系推进。角色参考图生成只验证来源剧本已审核、CharacterRevision 非 `STALE` 且输入有效，不要求角色先审核。图片和分镜预览可在最终分镜审核前生成；视频 job 的创建前必须验证角色及其选定参考图、以及对应 ShotRevision 均已人工批准，否则返回 `REVIEW_REQUIRED`。局部重生从一个 Shot/ShotRevision 开始，只创建该镜头及其直接派生图片、视频、音频/字幕（如内容改变）的新版本；不改变其他镜头，合成资产标记 STALE 等待重新合成。

## 审查后 Job、Attempt 与运行恢复契约（本节优先）

自动重试复用**同一个**非终态 `GenerationJob`：`RUNNING` 或 `WAITING_EXTERNAL` 因可重试结果转到 `QUEUED`，递增 `dispatch_seq` 并创建新的 DispatchOutbox；下次领取创建编号递增的 `JobAttempt`。一次 `JobAttempt` 是一次实际 Provider submit 或本地执行器正式执行，不因 query、poll 或 callback 递增；这些观察都以 ProviderEvent 追加审计。`POST /generation-jobs/:jobId/retry` 仅对可重试的 `FAILED` 或 `CANCELED` job 创建新的局部 WorkflowRun 和新的 GenerationJob，复制不可变输入快照但不修改旧 job。用户对成功 job 的主动重新生成不是 retry，而是相应内容生成端点的 `bypassCache=true` 请求。最大 attempt 数由 ProviderConfiguration 的受限策略配置（默认 3）；客户端不能提高它。

每次转换都使用 `UPDATE ... WHERE id=:id AND state IN (...) AND row_version=:expected`；领取还要求 `state=QUEUED AND dispatch_seq=:messageDispatchSeq`，成功更新递增 `row_version` 并设置 `lease_owner/lease_until`。提交前先写 Attempt 和确定性的 provider client request key；Provider 返回 request id 后立即以条件更新保存。回调/API 处理须先通过验签，然后以 `ProviderEvent(provider_configuration_id, provider_request_id, normalized_event_key)` 唯一键插入；重复 event 无副作用。callback 与 poll 竞争时，只有取得 `WAITING_EXTERNAL → RUNNING` 处理租约者能落终态；另一方重读后退出。`SUCCEEDED` 的重复回调被记录并忽略，已取消任务的迟到成功也被记录：若取消生效在结果落库前，则不激活输出 Asset，job 仍为 `CANCELED`，但已发生成本保留；若成功已先提交，取消返回 `JOB_TERMINAL`。

硬超时不是直接重提：先 query，必要时尽力 cancel，保留远程请求和事件审计；最终远程成功在尚未终态时可被接纳，否则按上述迟到结果规则处理。取消是尽力、协作式保证，不承诺中止已经在 Provider 执行的计费。reconciler 定期扫描过期 `RUNNING`、到期 `WAITING_EXTERNAL`、待投递 outbox 和调度宽限外 `QUEUED`；它先 query 已有请求，再按同一 job 的可重试转换入队。Redis 丢失只会丢调度信号，扫描器会补回。

`WorkflowRun` 的状态与 Job 状态不重复：它汇总其 DAG 子 job 的进度和关键性。所有关键 job 成功为 `SUCCEEDED`；关键 job 终态失败为 `FAILED`；只有非关键 job 失败为 `PARTIAL_FAILED`；取消未开始 job 且没有仍运行 job 后为 `CANCELED`。已成功的子 job、资产和成本从不因 run 取消回滚。
