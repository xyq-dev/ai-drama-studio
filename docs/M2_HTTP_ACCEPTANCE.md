# M2 HTTP 发现与并发版本读取验收

本次范围仅关闭公开 HTTP 的实体发现（M2-R01）和 aggregate 版本恢复（M2-R02），不代表真实
Provider 生成链或整个 M2 已完成。

- Character/Location 按 `(createdAt,id)`，Scene/Shot 按当前 revision 的 `(ordinal,id)` 稳定分页；
  默认 20、最大 100。cursor 携带并校验 workspace、project 及完整父 scope。
- `createdAt` cursor 保留 PostgreSQL 的六位微秒精度。Scene/Shot 先列出有当前 revision 的项目，
  再按 entity id 稳定列出无当前 revision 的项目，后者明确返回 `currentRevision: null`。
- 集合仅返回未归档 aggregate，包含 entityId、父 scope、rowVersion、currentRevisionId、
  approvedRevisionId 及当前 revision 的 reviewVersion/reviewStatus/freshnessStatus。
- revision 历史保留 `{items}` 并增加 `aggregate`，从而可在冲突或刷新后重新取得 If-Match 值；
  历史仍可读取已归档 aggregate。
- 集合响应的 `nextCursor` 为 `null` 时分页结束。历史 `aggregate` 只含 entity/父 scope、
  rowVersion 和 current/approved 指针，不伪造 current revision 摘要。
- 查询在 server 确定的 workspace 下执行，并使用只读、可重复读快照；不会取得业务写锁或提升版本。
- Mock 文本 worker 仍是验收用确定性 Provider；生产真实文本 Provider 不在本次范围。
- Mock 图片切片和 Shot asset 查询已实现并仅用于确定性验收；真实媒体 Provider 与真实媒体
  生成流程仍未实现。
