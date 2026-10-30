# ViMax E2-B 工作安排与接续记录

更新：2026-10-31。当前阶段：**设计已核验，开始实现**。本文件会随可验证增量同步到功能分支；未通过的检查不记为完成。

## 当前基线

- 仓库：`xyq-dev/ai-drama-studio`。
- 开发分支：`feat/vimax-e2b-candidate-persistence`。
- main 基线：`c50422c9a605adcc0c563f3b4cbd65c25533687e`（PR #98，E2-A 只读预览）；其 7 个 main-push 工作流已全部 success。
- 工作目录以执行环境实际路径为准，本轮为 `/workspace/scratch/416c07b24454/ai-drama-studio`；不得推断为用户电脑目录。

## 本轮交付目标

短剧中已有且无活动镜头的一个场景：导入方案并核验 → 永久保存候选 → 创建该场景的新草稿修订 → 创作者批准精确修订 → 写入镜头草稿。复用现有修订/审核/STALE 机制，保护其他场景与人工镜头。页面刷新可找回候选，丢失回执可用原请求身份重放。

不包含模型发送、预算/租约执行、未知模型结果恢复、真实图片/视频/TTS、系列媒体或部署。E2 的发送治理与 E3 真实试验仍是后续范围。

## 已确认设计

1. 新增独立候选与镜头映射两表；严格版本化冻结快照、永久请求键/哈希、状态与操作回执。HTTP 24 小时幂等表不作为长期候选仓库。
2. 状态仅向前：`stored → scene_saved → shots_saved`。保存来源资格是实时判断，不把 E2-A 报告或其 ready 状态当作写入许可。
3. 锁序：工作区写作 advisory 锁 → 候选 → project → episode → scene → shots。原回执重放优先于实时源检查；同键不同内容拒绝。
4. 写事务内重读源，保留 pending STALE 传播、同集活动整集拆解、当前批准剧本、完整角色身份、基线场景及零活动镜头检查。
5. 场景保存保留 scene ID、原序号和地点引用；镜头仅能挂到候选实际创建且当前已批准的精确场景修订。不能归档整集、自动批准或覆盖人工镜头。
6. SQL 放 `packages/database/prisma/drafts/20261031000100_vimax_storyboard_candidate.sql`，不进入通用 migration 发现目录。前置条件为既有 base migrations 与 script breakdown migration；无表/不完整结构时新接口明确 503，E2-A 不受影响。

## 工作清单

| 项 | 状态 | 接续位置 |
| --- | --- | --- |
| 数据模型、锁序及迁移隔离设计 | 已核验 | 本页；`VIMAX_PLATFORM_PREVIEW.md` |
| 平台候选/回执/视图契约与纯映射 | 开始实现 | `packages/contracts`、`packages/domain` |
| SQL 草案、候选事务存储与隔离验收 | 待实现 | `packages/database` |
| API、登录/CSRF、永久回执重放 | 待实现 | `apps/api/src/studio` |
| 保存、恢复、审核引导与镜头写入 UI | 待实现 | `apps/web` |
| Review、直接回归、隔离 PostgreSQL、1280/390 页面验证 | 待执行 | 按实际记录更新 |
| GitHub PR / CI / merge | 待执行 | 不跳过当前提交的 CI / Review |

## 执行权限与实际状态

- 常规选择性 commit、功能分支同步、PR、CI 和正常 merge：按 `ENGINEERING_WORKFLOW.md` 的持续授权推进。
- 新 Migration：本轮先编写和审查 SQL 草案；**业务库/生产执行=未执行**。任何隔离测试库验证单列其库身份、保护条件与实际结果，不据此宣称业务库已启用。
- 付费模型/媒体调用=0；部署=未执行；不修改历史任务或线上创作数据。
- 保留其他工作区和未提交改动；不得使用 force push、reset、clean 或覆盖无关模块。
