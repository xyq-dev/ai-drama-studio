# 角色参考图

本文件说明角色参考图的应用路径。依据是 [`PRODUCT_SCOPE.md`](PRODUCT_SCOPE.md) 的审查后基线：角色参考图生成只要求来源剧本已审核、CharacterRevision 非 `STALE` 且输入有效，不要求角色预先审核；视频生成前要求角色及其选定参考图、以及分镜均已审核。

## 状态

应用代码已经写好，但它依赖未执行的草案 [`packages/database/prisma/drafts/20261005000200_character_reference_image.sql`](../packages/database/prisma/drafts/20261005000200_character_reference_image.sql)：`asset.reference_role`、`asset.source_character_revision_id`、放宽到「角色参考图 IMAGE」的审核约束，以及 `character_reference_selection`。

在任何未执行草案的数据库上，所有参考图操作都返回 `503 CHARACTER_REFERENCE_STORAGE_UNAVAILABLE`，不会把普通 IMAGE 当成可审核资产，也不会退回旧门槛。真实数据库上的验收等草案授权后执行（见下文）。

## 规则

| 动作 | 条件 |
| --- | --- |
| 生成 | 修订是该角色的当前修订、`CURRENT`；它消费的每条剧本来源都已审核且可用（`m2_script_source_is_usable`）；项目没有进行中的失效重算；`mock-media` 的 `image.generate` 配置启用；`M3_MOCK_IMAGE_ENABLED`。角色本身不需要已审核。完成写入时在同一事务内再检查一次。 |
| 审核 | 只针对 `reference_role = character_reference` 的资产；请求带 `expectedRowVersion` 和 `contentHash`，两者必须与库内一致，审核记录固定在该字节哈希上。通过只允许 `ACTIVE` 且来自角色当前 `CURRENT` 修订的资产；退回必须写原因。 |
| 选择 | 比较并写入：请求带 `expectedSelectedAssetId`（看到的当前选择，没有则 `null`），不一致返回 `409 REFERENCE_SELECTION_CONFLICT` 并给出当前值。被选资产必须 `ACTIVE`、已通过且审核哈希等于内容哈希、来自角色当前 `CURRENT` 修订。 |
| 失效 | 生成时写入 `asset_revision_dependency.character_revision_id` 边；严格视频成功时在同一事务写入「视频 → 选定参考图」的 `asset_dependency` 边。角色修订被替换时，既有失效传播把参考图及沿这些边依赖它的视频、成片标为 `STALE`。改选参考图时，同一事务把依赖被替换参考图的视频及其下游（合成成片等）标为 `STALE` 并写 `asset.stale` 事件；被替换的参考图本身、审核记录、账本和无关分支不变。`STALE` 的视频不能再进入合成预检，`STALE` 的成片不能导出。选择记录保留为历史；`STALE` 的已通过资产不能作为来源。 |
| 严格视频门 | 镜头修订引用的每个角色修订：角色当前且已审核、`CURRENT`；该角色的选择指向由同一修订生成、`ACTIVE`、按字节审核通过的参考图。选定参考图的 `assetId` 与内容哈希冻结进视频快照的 `characterReferences`，因此进入 `inputHash`。Worker 完成写入和手工 retry 前都重新核验这些冻结参考。 |

## 并发与锁序

锁顺序统一为「项目 → 角色 → 资产」，与文本链的 `lockProjectForAggregate` 一致。严格视频完成从镜头门槛开始持有项目锁，直到冻结参考复核、视频资产、参考来源边、成功事件和成本一起提交；换选和审核在读取任何角色、选择或资产之前先取得同一把项目锁。因此：视频先完成时，换选的失效扫描一定能看到它；换选先提交时，视频完成复核到选择已变化，以 `CHARACTER_REFERENCE_REQUIRED` 终结原 attempt，不写资产、成本或成功事件。

参考图结构探测只在查询成功且确认结构缺失时报告不可用；查询超时或连接中断原样抛出，按暂时故障处理，恢复时不重新提交。

## 兼容

`M3_CHARACTER_REFERENCE_GATE` 选择视频门：

- `legacy`（默认）：既有 Mock 视频契约。镜头引用的角色必须已审核且当前，不要求参考图。视频快照与 `m3.mock.video.v1` / `m4.mock.sample-video.v1` 完全相同，不访问参考图存储。现有部署、现有 E2E 都运行在这个模式。
- `strict`：上表的严格视频门。缺少草案结构或选择时拒绝视频，不退回 legacy。只有 `strict` 产生的视频快照带 `characterReferences`；legacy 创建的任务在完成时不额外检查参考图。

## 接口

| 方法 / 路径 | 说明 |
| --- | --- |
| `POST /character-revisions/:revisionId/reference-images/generate` | `{seed?, bypassCache?}`，需 `Idempotency-Key`；`202` 返回任务。任务类型 `MEDIA_CHARACTER_REFERENCE`，快照 `m3.mock.character-reference.v1`（含角色修订内容哈希）。 |
| `GET /characters/:characterId/reference-images` | 最近 100 张参考图（`items`，每项带服务端判定的 `selectable`）、`hasMore`、当前修订和选择。选择按选择记录中的资产 ID、在同一工作区/项目/角色/参考图角色内单独读取（`selection.asset`），不依赖这一页。`videoReadiness` 与 `selection.usable` 用严格视频门同一函数 `characterReferenceVideoBlockers` 判定，`blockers` 列出全部原因（如角色当前版本未审核）。 |
| `POST /character-reference-images/:assetId/review` | `{decision: APPROVED|REJECTED, expectedRowVersion, contentHash, note?}`，需 `Idempotency-Key`。 |
| `POST /characters/:characterId/reference-selection` | `{assetId, expectedSelectedAssetId}`，需 `Idempotency-Key`。 |

生成返回 `202` 只表示受理。角色页按 `GET /generation-jobs/:id` 串行跟踪该任务：终态停止、页面隐藏时暂停、恢复可见后重读；成功后重读参考图列表，失败或取消显示真实状态。切换项目、角色、修订或卸载后，迟到的应答不改写列表、提示和 busy。工作台任务区单列「角色参考图任务」，只提供取消。

成功写入时，ACTUAL 成本须与该冻结请求一致：工作区、项目、任务、attempt、Provider 配置（`mock-media`/`image.generate`）、请求 ID 与客户端键、`mock-media`/`mock-v1`、`<请求ID>:request:actual`、零美元，且该请求没有估算行（`guardSynchronousMockReferenceCost`）。不一致在任何写入前以 `COST_CONFLICT` 拒绝，资产、依赖、成本与成功事件同属一个事务。

Worker 为 `MEDIA_CHARACTER_REFERENCE` 单独路由，不进入文本或镜头媒体路径，也从通用文本恢复查询中排除。租约过期时：未附加请求的 attempt 重新入队；已附加请求的只重新查询并写入确定性输出，不重新提交。每次恢复逐行隔离：暂时故障留待下一轮并汇总上报，永久拒绝只结束所属 attempt。镜头媒体恢复与参考图恢复按顺序各自运行，一方抛错时另一方照常执行并各自上报（`recovery-modules.ts`）；进程停止时整轮中止。参考图是 Mock 固定 1×1 PNG，不是模型生成结果；成本按 Mock 账本记 ACTUAL 0。

## 授权后需要执行的验收

- 在新建、专用、可丢弃的隔离库执行既有 migration 后，再执行该草案。
- 运行 `CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED=true pnpm --filter @ai-drama/database integration` 中的参考图用例（审核哈希、行版本、选择比较写入、`STALE` 后不可用、冻结参考复核）。
- 用 `M3_CHARACTER_REFERENCE_GATE=strict` 启动 API/Worker，走一遍：生成 → 审核 → 选择 → 审核角色与分镜 → 视频；以及修改角色后视频被拒。
