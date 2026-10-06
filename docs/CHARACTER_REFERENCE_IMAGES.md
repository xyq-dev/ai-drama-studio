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
| 失效 | 生成时写入 `asset_revision_dependency.character_revision_id` 边。角色修订被替换时，既有失效传播把这些参考图标为 `STALE`。选择记录保留为历史，但不再满足可用条件；`STALE` 的已通过资产不能作为来源。 |
| 严格视频门 | 镜头修订引用的每个角色修订：角色当前且已审核、`CURRENT`；该角色的选择指向由同一修订生成、`ACTIVE`、按字节审核通过的参考图。选定参考图的 `assetId` 与内容哈希冻结进视频快照的 `characterReferences`，因此进入 `inputHash`。Worker 完成写入和手工 retry 前都重新核验这些冻结参考。 |

## 兼容

`M3_CHARACTER_REFERENCE_GATE` 选择视频门：

- `legacy`（默认）：既有 Mock 视频契约。镜头引用的角色必须已审核且当前，不要求参考图。视频快照与 `m3.mock.video.v1` / `m4.mock.sample-video.v1` 完全相同，不访问参考图存储。现有部署、现有 E2E 都运行在这个模式。
- `strict`：上表的严格视频门。缺少草案结构或选择时拒绝视频，不退回 legacy。只有 `strict` 产生的视频快照带 `characterReferences`；legacy 创建的任务在完成时不额外检查参考图。

## 接口

| 方法 / 路径 | 说明 |
| --- | --- |
| `POST /character-revisions/:revisionId/reference-images/generate` | `{seed?, bypassCache?}`，需 `Idempotency-Key`；`202` 返回任务。任务类型 `MEDIA_CHARACTER_REFERENCE`，快照 `m3.mock.character-reference.v1`（含角色修订内容哈希）。 |
| `GET /characters/:characterId/reference-images` | 该角色所有参考图、当前修订和选择（含 `usable`）。 |
| `POST /character-reference-images/:assetId/review` | `{decision: APPROVED|REJECTED, expectedRowVersion, contentHash, note?}`，需 `Idempotency-Key`。 |
| `POST /characters/:characterId/reference-selection` | `{assetId, expectedSelectedAssetId}`，需 `Idempotency-Key`。 |

Worker 为 `MEDIA_CHARACTER_REFERENCE` 单独路由，不进入文本或镜头媒体路径，也从通用文本恢复查询中排除。租约过期时：未附加请求的 attempt 重新入队；已附加请求的只重新查询并写入确定性输出，不重新提交。参考图是 Mock 固定 1×1 PNG，不是模型生成结果；成本按 Mock 账本记 ACTUAL 0。

## 授权后需要执行的验收

- 在新建、专用、可丢弃的隔离库执行既有 migration 后，再执行该草案。
- 运行 `CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED=true pnpm --filter @ai-drama/database integration` 中的参考图用例（审核哈希、行版本、选择比较写入、`STALE` 后不可用、冻结参考复核）。
- 用 `M3_CHARACTER_REFERENCE_GATE=strict` 启动 API/Worker，走一遍：生成 → 审核 → 选择 → 审核角色与分镜 → 视频；以及修改角色后视频被拒。
