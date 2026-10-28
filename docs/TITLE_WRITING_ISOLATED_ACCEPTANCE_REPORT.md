# 剧名驱动 AI 文字创作：隔离 PostgreSQL 与真实 API 验收报告

结论：**标题创作的 PostgreSQL 与真实 API 流程在隔离环境、模型替身条件下通过。**

这不是真实 AI 创作验收，不是真实供应商验收，也没有生产部署。

## 1. 现场

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio-title-writing`（git worktree） |
| origin | `https://github.com/xyq-dev/ai-drama-studio.git` |
| 分支 | `feat/title-driven-ai-writing`，PR #58（Draft） |
| 起点 | `027d941f59f849f3a9164197a282f017a7acd968`：本地、远端分支、PR head 一致，工作区干净，没有他人的新提交 |
| 验收 SHA | `3a4d5d46f3175c99d130750d45ab89deba67774d`（验收设施与 CI 修正后的代码；验收工作流在这个 SHA 上通过） |
| 最终 HEAD | 本报告所在的文档提交；其 SHA、远端一致性和 CI 见 PR #58 说明与本轮最终回复 |

其他 worktree（含 `D:\Projects\adst-baseline-761acd6`）未改动。没有 reset、clean、stash 或强推。

## 2. 修改的文件

| 文件 | 原因 | 影响范围 |
| --- | --- | --- |
| `packages/database/src/title-writing-store.acceptance.spec.ts` | 增加结构核对、独立会话竞争、最后一个日额度竞争、预约与发送的恢复区分、确定性锁等待；输出脱敏证据 JSON | 只由专用验收命令收集 |
| `packages/database/src/index.ts` | 导出已有的验收守卫，让 API 验收使用同一套拒绝规则 | 只新增导出，没有行为变化 |
| `apps/api/src/studio/title-writing.acceptance.spec.ts` | 新增：真实 Nest 应用 + 真实 HTTP + 隔离 PostgreSQL + 计数的模型替身 | 只由专用验收命令收集 |
| `apps/api/vitest.title-writing-acceptance.config.ts`、`apps/api/package.json` | 专用命令 `pnpm --filter @ai-drama/api title-writing:acceptance`，只收集这一个文件 | 测试设施 |
| `apps/api/vitest.config.ts` | `pnpm test` 排除这个验收文件 | 测试设施 |
| `.github/workflows/title-writing-acceptance.yml` | 新增隔离验收工作流 | 只运行两条守卫过的验收命令 |

**产品实现、SQL 草案、既有迁移都没有改动。** 验收没有发现实现缺陷，所以没有做实现修复。

### 模型替身怎样接入（只在验收设施内）

- 应用用 `AppModule` 原样启动。运行时自带的标题创作保持关闭（`TITLE_WRITING_ENABLED` 为默认值 false），也不配置任何供应商密钥；这个进程里没有能连到真实供应商的路径。
- 只有控制器使用的 `TITLE_WRITING_SERVICE` 在测试里用 Nest 的 `overrideProvider` 替换。替换后仍是真实的 `TitleWritingService`、`TitleWritingEngine` 和 `PostgresTitleWritingStore`，只有 transport 换成替身。
- 替身记录每一次请求：剧名、步骤、第几次尝试、目标地址、所带密钥是否为替身密钥。它可以控制成功、503、超时（挂起直到中止）、断连、截断，以及挂起后迟到返回。它不打开任何网络连接。
- 供应商配置照常经过 `titleWritingProviderConfigs`。地址使用官方白名单内的千问地址字符串，但请求只交给替身。白名单没有改，也没有增加正式环境的 Mock 回退。
- 为了让「超时」用例不必等 120 秒，引擎的 `timeoutMs` 设为 1.5 秒。产品上限、租约和断言都没有放宽。

## 3. 隔离环境

本机没有 PostgreSQL 和 Docker，因此使用 GitHub Actions 的独立验收工作流。

| 项 | store 作业 | API 作业 |
| --- | --- | --- |
| PostgreSQL | `postgres:16` 作业级服务容器，16.15（与仓库既有 CI 相同的 `postgres:16`） | 同左，另一个容器 |
| 隔离库 | `ads_title_acceptance_store_37862662279_1` | `ads_title_acceptance_api_37862662279_1` |
| 建库后、写入前读取 | `current_database()` 与库名一致，用户表 0 | 同左 |
| 守卫 | 测试内 `checkTitleWritingAcceptanceEnv`（打开连接前），`verifyTitleWritingAcceptanceDatabase`（写入前，核对库名并要求没有表） | 同左 |
| 连接配置 | 只在验收那一步的命令行环境里提供三个变量；作业没有设置 `DATABASE_URL`。Prisma 校验那一步只拿到一个指向无效地址、不会被连接的占位 `DATABASE_URL` | 同左 |
| 口令 | 容器使用 `trust`，不存在口令，日志和证据里没有口令 | 同左 |
| 应用的既有迁移 | `20260924000100_m1b_job_core`、`20260925000100_m2a_text_chain`、`20260928000100_script_dependency_scopes`、`20260928000200_m3a_media_assets`、`20260928000300_m3b_job_shot_lineage` | 同左 |
| 应用的草案 | `20261008000100_title_writing.sql`（只这一份） | 同左（在「存储未就绪」用例之后才应用） |

## 4. 验证结果（分类，不混计）

### 真实 PostgreSQL：store 验收，22/22 通过（作业 113601830551）

原有 13 项（含 F4 修正后的逻辑时钟用例）首次实际执行并通过。新增 9 项全部通过：

| 证据 | 结果 |
| --- | --- |
| 四张草案表 | 从目录读回：4 张表；14 条主键、唯一和外键约束与草案逐条一致；29 条 CHECK；5 个索引，含 `WHERE state = 'running'` 的唯一部分索引。草案应用前 `storageReady()` 为 false |
| 费用 | 把 `billing_status` 改成 `'0'` 时被 CHECK 拒绝（23514），值仍为 `unknown` |
| 领取竞争 | 6 个独立会话同时领取同一任务：1 个成功，数据库里的执行者就是它 |
| 同键重放 | 5 个独立会话用同一键同一输入：1 个 `created`、4 个 `existing`，只有 1 行任务、0 次调用；同键不同输入为 `conflict` |
| 工作区并发上限 | 6 个独立会话启动 6 部作品，上限 2：2 个创建，4 个 `TITLE_WRITING_ACTIVE_RUN_CAP`，运行中恰为 2 |
| 最后一个日额度 | 已用 2 次、上限 3；4 个独立会话同时预约：1 个成功，3 个 `TITLE_WRITING_DAILY_CAP`；持久化调用正好 3 行，`calls_used` 合计 3 |
| 恢复区分 | 只预约未发送：调用记为 `rejected/executor_lost_before_send`，步骤回到 pending，任务可再次领取；已提交发送：调用与步骤 `unknown/executor_lost`，任务 `needs_attention`。失效执行者迟到时：发送返回 `lost`，写结果返回 false，没有新增调用行 |
| 确定性锁竞争（导入先排队） | 测试会话先持有作品行锁。导入会话的等待为 `Lock/transactionid`，被持锁会话阻塞；人工保存的等待为 `Lock/tuple`，被导入会话阻塞（`pg_blocking_pids`）。释放后导入写入三集，人工保存因版本过期得到 `REVISION_CONFLICT`。无死锁，剧本 3 版 |
| 确定性锁竞争（人工先排队） | 人工保存的等待为 `Lock/transactionid`，被持锁会话阻塞；导入的等待为 `Lock/tuple`，被人工保存阻塞。释放后人工保存成功；导入返回第 1 集冲突、第 2、3 集写入。第 1 集保留人工版本，剧本 3 版，无死锁 |

原有的普通 `Promise.allSettled` 竞争用例（R6，5 轮）保留，仍只说明这几轮没有出现死锁。锁顺序的证据来自上面两条确定性用例。

### 真实 HTTP + 真实 PostgreSQL + 模型替身：API 验收，10/10 通过（作业 113601830363）

| 用例 | 关键关联与替身发送次数 |
| --- | --- |
| 草案未应用 | 选项接口 `TITLE_WRITING_STORAGE_UNAVAILABLE`；启动 503；发送 0。随后应用草案，选项接口变为 `TITLE_WRITING_READY` |
| 开关关闭、无令牌、错令牌、缺幂等键 | 404 / 403 / 403 / 400；发送 0；任务行 0 |
| 完整流程 | 作品 `ab5b6f1c…`，任务 `05190871…`。重放同键返回 200 和同一任务；同键改剧名 409 `IDEMPOTENCY_KEY_REUSED`；进行中另起 409 `TITLE_WRITING_RUN_ACTIVE`（带原任务 ID）。完成后 5 次调用、`billingStatus` 均为 unknown；故事 `a3c5846d…` 为 DRAFT；剧本在任务内，分集没有剧本版本。审核前写入为 409；经现有审核接口批准后写入三集（`4dd2175f…`、`7734878a…`、`744f214a…`，均为 DRAFT，来源是该故事），分集指针一致；重复写入仍是 3 版。发送 5 |
| 已有人工剧本 | 第 2 集先由人工保存（`bca83677…`）；写入结果为 saved / conflict / saved；第 2 集指针与正文不变；共 3 版。发送 5 |
| 故事换版 | 人工另存并批准另一版故事（`352f8678…`，不是任务的 `bcb9ae18…`）：未批准时 409 `STORY_NOT_APPROVED`，批准后 409 `STORY_CHANGED`；剧本 0 版 |
| 5xx 结果未知 | 第一步 503 → `unknown/server_error`，任务 `needs_attention`。之后执行两次维护，发送仍为 1。续跑时：无令牌、错令牌、缺键、未确认、旧确认分别得到 403 / 403 / 400 / 409 / 409，发送仍为 1。正确确认后完成，发送 6；同键重放 200、不再发送；同键换内容 409；续跑记录 1 行；6 行调用的费用均为 unknown |
| 超时、断连、截断 | 超时 → `unknown/timeout`，发送 1；断连 → `unknown/disconnected`，发送 1；大纲被截断 → `rejected/truncated`，任务 partial。截断的续跑不需要确认，补发大纲和三集，故事策划只发过 1 次，合计 6 |
| 发送中取消 | 取消回执中 `cancelRequested` 为 true；已发出的那一步如实记为 completed，任务 canceled；只有 1 行调用，发送 1 |
| 失效执行者的迟到结果 | **引擎 + 真实 PostgreSQL，逻辑时钟，不经 HTTP，没有终止进程**：执行者 B 的时钟设为 A 的租约之后，维护把 A 已发出的调用记为 `unknown/executor_lost`。A 的替身随后返回合法结果，没有落库，下一步也没有开始。发送 1，调用 1 行 |
| 替身 | 共 31 次请求，全部只到替身，所带密钥都是替身密钥；HTTP 交换 118 次 |

### 未执行

- 真实模型（千问 / OpenAI / DeepSeek）：未执行，没有付费调用。
- 进程终止后重启的恢复：未执行。恢复只用逻辑时钟验证（上面两处），不能当作真实崩溃证据。
- 浏览器：本轮没有运行。没有混用桩 API。

## 5. 命令、退出码与 CI

| 命令 / 运行 | 结果 |
| --- | --- |
| 本地：无授权变量运行两条专用验收命令 | 均退出码 1，打开连接前报 `refused`（证明默认拒绝） |
| 本地：`pnpm lint`、`pnpm typecheck`、`git diff --check` | 0 |
| 本地：`pnpm verify`（Node 24.21.0、pnpm 10.17.0，`engine-strict=true`） | 0；web 357、api 97、providers 116、domain 86、database 49、worker 68、contracts 13、health 7、comfyui-adapter 4（验收文件不在 `pnpm test` 中） |
| 本地：验收文件单独做类型检查（`tsconfig` 排除 spec 文件，所以另用临时配置）、eslint | 无错误；临时配置已删除 |
| CI [37862568929](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37862568929)（`32187e9`，第 1 次尝试） | **失败，保留**：`prisma validate` 报 P1012，原因是缺少 `DATABASE_URL`。失败发生在建库之前，没有创建或写入任何库。修复：只给这一步一个不会被连接的占位地址（`3a4d5d4`） |
| CI [37862662279](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37862662279)（`3a4d5d4`，第 1 次尝试） | 成功。store 作业 113601830551：22/22；API 作业 113601830363：10/10 |
| 证据 artifact | `title-writing-store-acceptance-evidence`（11586398869）、`title-writing-api-acceptance-evidence`（11587260961）。已下载核对：没有连接 URL、口令、操作者令牌或替身密钥 |

没有为了变绿而重跑，也没有放宽断言或超时。最终 HEAD 的 CI 见 PR #58 说明。

## 6. 清理

- 两个 `postgres:16` 服务容器和各自的网络在作业结束时由 Runner 删除，日志中有「Stop and remove container」与「Remove container network」。隔离库只存在于这两个容器中。
- 本机没有启动数据库、容器或后台服务，没有遗留资源。

## 7. 状态

| 项 | 状态 |
| --- | --- |
| commit | `3c554f4`（数据库验收）、`32187e9`（API 验收与工作流）、`3a4d5d4`（CI 修正）、本报告的文档提交 |
| push | 普通推送到 `feat/title-driven-ai-writing` |
| merge / 推 main / force push | 均未发生 |
| pack / release / deploy / 修改服务器开关 | 均未发生 |
| 正式 Migration | 没有新增或修改；草案仍在 `prisma/drafts` |
| 隔离草案执行 | 只在上面两个一次性隔离库中执行 |
| 付费调用 / 真实模型 | 0 |

## 8. 遗留

- 两个非阻断 P2 **仍未处理**：
  1. 轮询已经显示取消终态后，旧的取消请求失败，仍可能显示过时的提示。
  2. 操作后的补读可能与正在进行的轮询 GET 重叠。
- 进程级崩溃恢复与真实模型都未验收。

## 9. 唯一优先的下一步

请 Codex 复审本轮新增的验收设施（`3c554f4..3a4d5d4`）。重点是：替身接入方式是否只在测试内；工作流的隔离、权限与清理；锁等待证据的判定。

本轮没有实现变更或 SQL 变更需要复审，只新增了守卫的导出。复审通过后，再决定是否另行授权真实模型的小额试调用。
