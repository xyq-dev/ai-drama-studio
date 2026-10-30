# ViMax E2-B 工作安排与接续记录

更新：2026-10-31。当前交付：**E2-B 代码、本地分项与独立隔离验收完成；业务库未启用**。代码集成与最新 CI 结果以本功能分支关联 PR 为准。本文件随代码增量同步，不把未执行的操作记为完成。

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
| 平台候选/回执/视图契约与纯映射 | 已实现；领域定向与旧 E1/E2-A 共 142 项通过 | `packages/contracts`、`packages/domain` |
| SQL 草案、候选事务存储与隔离验收 | 已实现；定向 48 项通过；独立 CI 全新库 14 项通过 | `packages/database` |
| API、登录/CSRF、永久回执重放 | 已实现；定向 44 项通过；另一个 CI 全新库真实 HTTP/PG 4 项通过 | `apps/api/src/studio` |
| 保存、恢复、审核引导与镜头写入 UI | 已实现；99 项定向通过，1280/390 真实 Chromium 桩流程及刷新恢复通过 | `apps/web` |
| Review、直接回归、隔离 PostgreSQL、1280/390 页面验证 | 独立复审无剩余 findings；4249 项包级 JS、脚本检查、9 项 Python、构建/类型检查通过 | 视觉为真实 Chromium + 本地桩；后端为真实 HTTP + PG |
| GitHub PR / CI / merge | 以本分支关联 PR 的实时记录为准 | 不跳过当前提交的 CI / Review；GitHub 合并不等于服务器部署 |

## 执行权限与实际状态

- 常规选择性 commit、功能分支同步、PR、CI 和正常 merge：按 `ENGINEERING_WORKFLOW.md` 的持续授权推进。
- 新 Migration：SQL 草案经独立审查；**业务库/生产执行=未执行**。仅在 runner-local 两个新空命名隔离库施加草案，普通迁移链未包含草案，不据此宣称业务库已启用。
- 付费模型/媒体调用=0；部署=未执行；不修改历史任务或线上创作数据。
- 保留其他工作区和未提交改动；不得使用 force push、reset、clean 或覆盖无关模块。

## 当前审查事项

- 已修：SQL 缺失数组字段可能以 NULL 穿过 CHECK；场景保存结果需绑定当前、fresh DRAFT 的精确修订；视图状态必须与 1/2/3 版本及回执存在性一致。
- 已修：冻结记录体积放大采用应用 compact 1 MiB、JSONB 文本 1.5 MiB 限额和独立 413；游标严格校验日历日期；未配对 surrogate 在持久化前拒绝，旧离线规则不变。
- 已修：有效写回执立即废弃旧 UI 资格并取消旧读；明确的冻结超限可显式结束原请求，其他未知失败保留身份；历史重放提示不再误称当前尚未保存。
- 隔离草案验收要求新空命名库、原有 acceptance guard，另加 `VIMAX_CANDIDATE_ACCEPTANCE_DRAFT_AUTHORIZED=true`。只在单独 CI 任务提供；普通 `test` / `integration` / `migrate` 不施加草案。
- 首次普通全量默认并发中，原有密码哈希/页面用例出现超时；这三份文件限制并发单独复验 20 + 83 项均通过，后续等价分项和隔离 CI 的通过证据列在下方；正式 PR 的当前 HEAD 检查仍须单独核验。

## 已取得验证证据

- 专用 CI：[`41109277158`](https://github.com/xyq-dev/ai-drama-studio/actions/runs/41109277158)，提交 `ea59f4eed8e90cb6c7741c8ad6c91d6c96b5ffb7`，首次运行通过。存储 14/14、真实 HTTP/PG 4/4，无跳过，分别只使用独立的新空库。业务数据库执行 0，模型/媒体请求 0。
- 本地按项目等价分项验证：lint、typecheck、全部包级测试、build、Prisma validate、API acceptance 类型检查、脚本检查与 Python 通过。包级计数：contracts 206、domain 1902、providers 412、database 163、API 575、Web 901、worker 79、health 7、adapter 4，共 4249；Node 脚本 40、Python 9。
- 本地包级测试使用 `VITEST_MAX_WORKERS=2`、Turbo loose 环境及单任务并发，处理默认并发下原有 scrypt/页面测试超时；没有放宽断言或超时设置。标准 `pnpm verify` 的最终提交证据以正式 PR CI 为准，不把本地只输出部分阶段的命令记作全量通过。

## 中断后的接续顺序

1. 核验远端 main、当前分支和关联 PR。若尚未合并，先确认当前 HEAD 的 CI/Review，修正真实失败后正常 merge；若已合并，不重复实现本页能力。
2. 保留 SQL 草案、永久回执与已有修订。不得为了让页面可点而绕过缺结构、审批或来源门槛。
3. 后续先准备业务库启用与测试站点发布；必须有明确数据库执行授权及可用连接，并单独记录实际 SHA/SQL/页面检查。当前二者未执行。
4. 完整 E2 的发送预算、租约和未知结果恢复，以及 E3 真实规划另行推进；不借用旧系列调用预算，不自动调用模型。
