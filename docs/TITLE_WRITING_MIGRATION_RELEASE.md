# 标题创作正式迁移发布说明（候选）

分支 `chore/title-writing-migration-release`，起点 `origin/main` `27710a96a0970f73ba747b5a1d0f9226b9d431d5`。本文是可审查的发布候选，**尚未在任何服务器或既有数据库执行**。数据库变更由 Codex 最终独立 Review，合并前不上线。

| 项 | 状态 |
| --- | --- |
| Migration 已编写 | 是：`packages/database/prisma/migrations/20261008000100_title_writing/migration.sql` |
| 隔离库执行 | 见文末「验证结果」：仅 CI 作业级 `postgres:16` 容器里新建的一次性库 |
| 服务器执行 | NO |
| 真实模型调用 | NO（全部为测试替身，provider 域名在 CI 中解析到回环地址） |
| Merge / Deploy | NO |

## 1. 正式迁移候选

- 路径：`packages/database/prisma/migrations/20261008000100_title_writing/migration.sql`，名称 `20261008000100_title_writing`，排在已发布的 5 个迁移之后。
- 来源：已通过隔离 store / API / 浏览器 / 运行时验收的草案 `prisma/drafts/20261008000100_title_writing.sql`。
- **与草案的差异：只有文件头注释。**从第一条语句起逐字节相同（包括行内注释）。`draft-migrations.spec.ts` 用两种方式锁定：去掉注释与空行后语句完全相等；从 `CREATE TABLE title_writing_run` 起字节完全相等。没有重新设计存储或状态机。
- 工具与约定：仓库自有 `runMigrations`（`pnpm --filter @ai-drama/database migrate`），Prisma 目录布局，按名称排序，单连接 advisory lock，每个迁移一个事务，`schema_migration` 记录 SHA-256 校验和，已应用文件被修改会拒绝。行尾由 `.gitattributes` 固定为 LF，Windows 与 Linux 检出的校验和一致。
- Prisma schema：沿用「每张迁移表都有 model、无 relation 字段」的现有管理方式，新增 `TitleWritingRun/Step/Call/Resume` 四个 model（列、主键、唯一约束、普通索引）。CHECK、部分索引、复合外键只在 SQL 中，与 README 约定一致。`prisma validate` 通过；没有用 Prisma 自动生成任何迁移差异。
- 既有迁移：未修改。`draft-migrations.spec.ts` 固定了 5 个已发布迁移的 SHA-256（即服务器已记录的校验和）。
- 草案：保留在 `prisma/drafts/`，首行改为 `SUPERSEDED DRAFT. Do not apply.`，写明替代它的正式迁移路径；原注释保留为历史出处。**草案不再是任何部署指令。**适用版本：从包含 `prisma/migrations/20261008000100_title_writing/` 的 main 提交起，由 `migrate` 命令执行。
- 迁移工具新增可选参数 `runMigrations(pool, dir, { before })`：只应用名称排在某个迁移之前的部分。仅供隔离验收先构造「上一版本」的库再升级；部署命令 `migrate-cli.ts` 未改，不传该参数。

## 2. 新增结构与对现有数据的影响

只新增，不改任何旧表、列、约束或数据：

| 表 | 用途 | 主要约束 |
| --- | --- | --- |
| `title_writing_run` | 一次创作 | PK `id`；`UNIQUE (workspace_id, actor_id, idempotency_key)`；`UNIQUE (id, workspace_id)`；FK `(project_id, workspace_id) → project`；FK `(story_revision_id, project_id, workspace_id) → story_revision`；状态、租约成对、故事保存等 CHECK |
| `title_writing_step` | 五个步骤 | PK `(run_id, step_key)`；`UNIQUE (run_id, ordinal)`；FK → run（ON DELETE CASCADE）；FK `script_revision_id → script_revision` |
| `title_writing_call` | 每次模型调用 | PK `id`；`UNIQUE (run_id, step_key, attempt_no)`；FK → step（ON DELETE CASCADE）；`CHECK (billing_status = 'unknown')`，**没有金额列** |
| `title_writing_resume` | 续跑确认 | PK `(run_id, idempotency_key)`；FK → run（ON DELETE CASCADE） |

索引：`title_writing_run_one_running_idx`（每个项目最多一个 running，部分唯一索引）、`title_writing_run_project_idx`、`title_writing_run_lease_idx`（部分）、`title_writing_call_recent_idx`、`title_writing_call_open_idx`（部分）。

影响说明：

- 现有行不读不写。验收把升级前后每张既有表的行数、全部行的摘要、列、约束、索引逐一比较，完全相同（见文末）。
- 新外键引用 `project`、`story_revision`、`script_revision`。建表时会对这三张表短暂加 `SHARE ROW EXCLUSIVE` 锁（新表为空，持续时间是建表本身），期间对这三张表的写入会等待。建议在低峰执行。
- 之后若某个项目、故事版本或剧本版本被标题创作引用，直接 `DELETE` 这些行会被外键拒绝（没有 ON DELETE）。现有产品没有删除项目或版本的路径（项目是归档），不受影响；人工清理数据时需要注意。
- 应用代码：API 在表存在后 `storageReady()` 为真，但功能仍默认关闭（见第 5 节）。Worker 不读这些表。API、Worker 都不会在启动时自动迁移。

## 3. 执行顺序

**预检查（只读）**

1. 按现有运维规程完成数据库备份，记录备份位置。
2. 确认目标库就是要发布的库：`SELECT current_database();`
3. 确认已发布迁移齐全且未被改动：
   ```sql
   SELECT name, checksum FROM schema_migration ORDER BY name;
   ```
   应恰好为下面 5 行，校验和一致：
   | name | checksum |
   | --- | --- |
   | `20260924000100_m1b_job_core` | `15ee68a4d23c82e3078db554c035ca9c29aed894cdb36448324d251432946605` |
   | `20260925000100_m2a_text_chain` | `678ac1aa0afc983d2f94efbe6b2d00fa5bfc0deb8e1a4b55e2911521d8cd1488` |
   | `20260928000100_script_dependency_scopes` | `d10b3314354069aeb6ce4ec0025411fae3cfcae200688fe74b407deb30f117d7` |
   | `20260928000200_m3a_media_assets` | `a8540cb57ec0e9a034ca56ef2c5c9a3ce55a2fdc4076bdabd7e6844c79b26ae2` |
   | `20260928000300_m3b_job_shot_lineage` | `fa3e195e82b760ea3ce8ed39b2daedd2169c8e5de955c5750a5511c8b7073b62` |
4. 确认四张表还不存在（应全为空）：
   ```sql
   SELECT to_regclass('title_writing_run'), to_regclass('title_writing_step'),
          to_regclass('title_writing_call'), to_regclass('title_writing_resume');
   ```
   不为空说明有人手工执行过草案：**停止发布**，不要补写 `schema_migration` 记录，交 Codex 评估。
5. 确认 API 环境：`NODE_ENV=production`（保持不变），`TITLE_WRITING_ENABLED` 未设置或为 `false`。

**执行**

1. 部署包含本迁移的代码并 `pnpm install --frozen-lockfile`、`pnpm build`。
2. 用与 API 相同的 `DATABASE_URL` 执行：`pnpm --filter @ai-drama/database migrate`。预期输出 `Applied 1 migration(s).`
3. 重启 API、Worker（顺序不限：旧代码不读新表；新代码在表缺失时只会返回 503 存储未就绪，而功能本来就关闭）。

**后检查**

1. `SELECT name FROM schema_migration ORDER BY name;` 多出 `20261008000100_title_writing` 一行。
2. 第 4 步的 `to_regclass` 四个值都不为空。
3. API `/health` 正常；`GET /api/v1/writing/title-runs/options` 返回 `TITLE_WRITING_DISABLED`（功能仍关闭）。
4. 再执行一次 `migrate` 应输出 `Applied 0 migration(s).`（重复部署安全）。

**失败处理**

- 迁移在单个事务里执行：任何语句失败都会整体回滚，不写 `schema_migration` 记录，库保持原样。记录错误、停止发布，交 Codex 评估后 forward-fix。
- `relation ... already exists`：草案曾被手工执行。不要删表、不要手工插入迁移记录来「让它通过」。
- `Applied migration checksum mismatch`：已发布迁移文件与服务器记录不一致，停止，排查代码版本。
- 连接或锁等待超时：确认没有长事务占用 `project`/`story_revision`/`script_revision` 后重试；重试是安全的。

## 4. 回滚

- 不提供 down migration，也不自动执行 `DROP`。
- 代码回滚到不含本迁移的版本时，**保留新增表**：旧代码不读它们，`migrate` 也只会把它当作已记录的迁移（旧版本目录里没有它，不会报错）。功能保持 `TITLE_WRITING_ENABLED` 关闭。
- 若将来确需删除这些表，需单独授权和 Review，不属于本发布。

## 5. 功能开关（不变）

- 默认关闭：`TITLE_WRITING_ENABLED` 默认 `false`。
- `NODE_ENV=production` 时强制关闭（`studio.runtime.ts`：`enabled = NODE_ENV !== "production" && TITLE_WRITING_ENABLED`），即使设置为 `true`。
- **不要**通过把线上 `NODE_ENV` 改成 `development` 来启用功能。执行迁移只是让存储就绪，不代表功能上线。

## 6. 验收如何改为走正式迁移链

| 验收 | 之前 | 现在 |
| --- | --- | --- |
| store（`title-writing-store.acceptance.spec.ts`） | 迁移 + 手工执行草案 | 先 `before` 只迁到已发布的 5 个 → 断言存储未就绪 → 写入既有业务数据（项目、已审核故事、剧本版本、工作流、任务、尝试、成本账本）→ 快照 → 普通 `runMigrations` 升级（只应用新迁移，校验和与文件一致）→ 快照完全相同 → 再跑一次无变化 |
| API（`title-writing.acceptance.spec.ts`） | 同上 | 迁到已发布版本 → 真实 HTTP 拒绝（503，发送 0）→ API 不重启、普通链升级 → 就绪 |
| 运行时（`title-writing.runtime-acceptance.spec.ts`） | 同上 | 迁移前：默认关闭、生产强制关闭、缺存储均拒绝且发送 0 → 普通链升级、再跑一次为 0 → 迁移后 `node dist/main.js` 默认关闭仍正常启动并返回 404 → 其余原有用例 |
| 浏览器（`title-writing.browser-acceptance.spec.ts`） | 同上 | 全新空库直接走完整迁移链（6 个） |
| CI store 作业新增 | — | 用真实部署命令 `migrate` 在另一个新库执行两次（6 → 0，四表存在）；在升级后的验收库再执行一次（0） |
| 通用 `integration`（共享库，其他文件会重建 schema） | 断言存储未就绪 | 只读断言「存储就绪 ⇔ `schema_migration` 已记录该迁移」。缺存储拒绝改在上面三个独立场景里，未删除或放宽 |

验收入口的授权变量由 `TITLE_WRITING_DRAFT_SQL_AUTHORIZED` 改名为 `TITLE_WRITING_ACCEPTANCE_AUTHORIZED`（不再执行草案）。其余守卫不变：只接受新建的空库 `ads_title_acceptance_*`，不读 `DATABASE_URL`，写入前只读确认库名且没有任何表，不删库、删表或清表。

## 7. 下一轮真实千问验收仍缺的配置与授权

本轮不调用任何模型。下一轮真实千问验收至少需要以下内容全部到位并书面授权；任一缺失就不调用，费用未知时记为 `unknown`，**不记为 0**。

| 项 | 需要 | 说明 |
| --- | --- | --- |
| 地域 / 端点 | `BAILIAN_BASE_URL` | 只接受官方 DashScope 域名（代码校验），需确定地域（如中国内地或国际）与对应端点 |
| 模型白名单 | `TITLE_WRITING_QWEN_MODELS` | 逗号分隔、只允许列出的模型；需指定确切模型名 |
| 密钥安全配置 | `DASHSCOPE_API_KEY` | 只放在验收环境 API 进程的环境变量或密钥管理里，不写入仓库、日志、证据或浏览器；用后轮换 |
| 操作者令牌 | `TITLE_WRITING_OPERATOR_TOKEN` | 16–200 字符，只给执行人 |
| 允许调用次数 | `TITLE_WRITING_MAX_CALLS_PER_DAY`（默认 30）、每次创作最多 8 次（`TITLE_WRITING_CALL_CAP_PER_RUN`）、`TITLE_WRITING_MAX_ACTIVE_RUNS`（默认 1） | 这些是**次数**上限，不是金额预算 |
| 费用上限 | 需在服务商控制台设置额度 / 预算告警，或由负责人书面给出金额上限 | 产品内没有金额硬上限，也不记录金额；`billing_status` 恒为 `unknown` |
| 运行环境 | 非 production 的隔离环境，`TITLE_WRITING_ENABLED=true` | 不在线上把 `NODE_ENV` 改成 development |
| 数据库 | 已执行本迁移的隔离库 | 不用生产库 |

## 8. 给 Codex 的审查范围

见 PR 描述「审查范围」一节；核心是第 1、2、3、4 节与以下文件：

- `packages/database/prisma/migrations/20261008000100_title_writing/migration.sql`（新增）
- `packages/database/prisma/drafts/20261008000100_title_writing.sql`（仅头注释）
- `packages/database/prisma/schema.prisma`（新增 4 个 model）
- `packages/database/src/migrations.ts`（`before` 选项）及 `migrations.spec.ts`、`draft-migrations.spec.ts`
- `packages/database/src/title-writing-store.ts`（导出迁移名，注释）、`index.ts`（导出）
- 验收：`title-writing-store.acceptance.spec.ts`、`title-writing-store.integration.spec.ts`、`title-writing-acceptance-guard*.ts`、`apps/api/src/studio/title-writing.{acceptance,runtime-acceptance,browser-acceptance}.spec.ts`、`apps/api/acceptance/title-writing-runtime-preload.cjs`
- `.github/workflows/title-writing-acceptance.yml`

## 验证结果

验证对象是提交 `88c351ad6b351aa201ec0fd99078d190819fa1d5`（Draft PR #61）。本机没有 PostgreSQL 或 Docker，真实数据库与真实进程验收沿用已有的隔离 CI。

### 模拟测试（本机，Node 24.21.0，没有数据库）

| 检查 | 结果 |
| --- | --- |
| database lint / typecheck / test | 0 / 0 / 54 通过（含新增：语句逐字节一致、只新增、草案标记、5 个已发布迁移校验和、Prisma 列与存储列一致、`before` 分阶段迁移） |
| api lint / typecheck / test | 0 / 0 / 97 通过 |
| web lint / typecheck / test | 0 / 0 / 387 通过（只改了一句提示文字） |
| `prisma validate` / `prisma generate` | 通过 |

### 真实 PostgreSQL（CI「Title writing isolated acceptance」run 37953785450，作业级 `postgres:16`，一次性库）

| 场景 | 结果 |
| --- | --- |
| B 升级路径（store 作业） | 30/30 通过。先只迁到已发布的 5 个 → `storageReady()` 为假 → 写入项目、已审核故事、剧本版本、工作流、任务、尝试、成本账本 → 普通 `runMigrations` 只应用 `20261008000100_title_writing`，记录的校验和与文件一致 → 全部既有表的行数、行摘要、列、约束、索引与升级前相同 → 再执行一次 `applied = []` |
| A 全新空库 + 部署命令 | 真实命令 `pnpm --filter @ai-drama/database migrate` 在新库输出 `Applied 6 migration(s).`，再执行输出 `Applied 0 migration(s).`，四张表存在，`schema_migration` 末行为 `20261008000100_title_writing` |
| C 重复部署 | 在升级后的验收库再执行部署命令：`Applied 0 migration(s).` |
| A 全新空库 + 浏览器（browser 作业） | 4/4 通过：完整迁移链后，Chrome → 已构建网页 → 真实 API 的原有三条用户闭环 |

### 真实进程（同一 run）

| 场景 | 结果 |
| --- | --- |
| API 作业（真实 Nest + HTTP） | 10/10 通过。迁移前开始创作返回 503 `TITLE_WRITING_STORAGE_UNAVAILABLE`、发送 0；API 不重启、普通链升级后就绪；其余原有用例不变 |
| 运行时作业（`node dist/main.js` 子进程） | 5/5 通过。迁移前：默认关闭 404、production 强制关闭 404、缺存储 503，均发送 0；升级 → 再执行为 0 → **迁移后以默认关闭启动真实 API 正常并返回 404**；之后原有的 SIGKILL / 重启 / 240 秒租约恢复用例全部通过 |

### 其他 CI（同一提交）

10 个工作流全部成功。5 个 `integration` 作业都运行了只读的 `title-writing-store.integration.spec.ts` 并通过（共享库已走完整迁移链）。跳过数与 main（`27710a9`）相同：都在千问与角色参考图草案的既有用例里，与本次无关。

模型全程是测试替身，运行时作业把 provider 域名解析到回环地址；没有真实外网模型调用。

### 未执行

- 没有在任何服务器、生产库或既有开发库执行迁移。
- 本机没有运行真实 PostgreSQL（没有 PostgreSQL 或 Docker），真实库只在 CI 一次性容器中运行。
- 没有执行真实千问调用（缺第 7 节所列授权）。
