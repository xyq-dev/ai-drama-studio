# 剧名驱动 AI 文字创作：审查问题修复记录（R1–R9）

- 分支：`feat/title-driven-ai-writing`，PR #58（Draft）
- 审查基线：`5ddad79ebea2d25ac0019547303793953baa212d`
- 日期：2026-10-09
- 范围：只修复 R1–R9 涉及的实现、测试和文档；不新增功能，不改 UI 风格

## 状态总览

| 项 | 状态 |
| --- | --- |
| 真实 PostgreSQL | 未执行 |
| 真实项目 API | 未执行 |
| 真实模型调用 | 未执行 |
| SQL 草案 | 未执行，仍在 `prisma/drafts` |
| 合并、部署 | 均未发生 |

## 证据分类

下文每项的「证据」只说明用了哪种手段：

- **基线复现**：先写只依赖 `5ddad79` 已有接口的复现测试，放在临时、独立的 detached worktree（`D:\Projects\adst-baseline-tmp`，不在仓库内）中运行。复现测试不提交。
- **最终回归**：提交在本分支的测试，修复后通过。R1 与 R9 的最终回归文件也拿到基线副本跑过，在基线上失败。
- **静态分析**：通过阅读代码确认，没有在真实数据库上复现。
- **PostgreSQL 回归**：写在 `title-writing-store.acceptance.spec.ts`，本轮**未执行**。

内存存储、模拟 fetch 和脚本化客户端都不是真实数据库或真实 API 的证据。

## 逐项

### R1 启动幂等（P1）

**根因**

- 会话存储只保存剧名和请求串。刷新后，其他设置被服务端默认值覆盖，请求体变了，于是生成新的 `runKey`。
- `setItem` 抛错时被吞掉，请求照样发出。

**修复**

`apps/web/src/components/title-writing-start.tsx`：

- 待确认启动保存为冻结请求体加 `projectKey`、`projectId`、`runKey`，写入后读回核对；写不进或读不回就不发送。保存作品 ID 失败时，不启动任务。
- 刷新后表单显示并锁定这次请求，默认值不覆盖它。只能「重试上次请求」（原请求体、同一组键）或「查看进度」；「放弃上次请求，重新填写」是单独的新创作。
- 删除了「不会重复」的承诺文案。
- 令牌只在页面内存。

**提交**：`25f9fcb`

**证据**

| 类型 | 结果 |
| --- | --- |
| 基线复现 | 2/2 失败。① 非默认设置、丢失回执、重挂载后，重放的请求体不同；② 存储写入抛错时仍发出 2 个 POST |
| 最终回归 `title-writing-start.spec.tsx` | 9 项通过；拿到基线副本跑 8/9 失败，其中部分失败来自基线没有新按钮 |
| 真实 Chromium + 已构建网页 + 桩 API（1280、390） | 待确认状态完整恢复并锁定，无横向溢出，未点击时 0 个 POST；原一键流程六个阶段照常 |

### R2 旧的「可能已计费」确认授权了后续未知尝试（P1）

**根因**：续跑只检查布尔值 `confirmUncertain`，没有绑定具体调用，也没有操作幂等。

**修复**

- 续跑请求体改为 `confirmUncertainCallIds`。
- `currentUncertainCallIds` 定义在 contracts，服务端与页面共用；它取每个 `unknown` 步骤当前尝试的那次调用。
- 存储在续跑事务内、持有运行行锁时核对两者必须完全相等：
  - 没有给出确认 → `NEEDS_CONFIRMATION`
  - 内容不一致 → `CONFIRMATION_STALE`
- 续跑必须带 `Idempotency-Key`，被受理的操作记入新表 `title_writing_resume`：
  - 同键同内容 → 返回当前状态，不重置、不发送
  - 同键不同内容 → `IDEMPOTENCY_KEY_REUSED`
- 页面根据当前不确定调用集合推导勾选框状态；操作被受理或被拒绝后清除确认。只有在同一组调用、请求没有回应的情况下才复用操作键；收到「确认已过期」后重新读取。

**提交**：`6a06187`

**证据**

| 类型 | 覆盖内容 |
| --- | --- |
| 基线复现（失败） | 第 2 次尝试再次 unknown 后，重放 `{confirmUncertain:true}` 仍被受理 |
| 最终回归，内存存储与替身（通过） | `title-writing-resume.spec.ts`：旧确认对应旧尝试、快速再次 unknown、顺序重放、并发同键（1 个 ok、其余 replayed）、同键不同内容、rejected 步骤带旧确认、取消后仍含 unknown、新确认可以继续 |
| 最终回归，API（通过） | 错误令牌 403、缺 `Idempotency-Key` 400、旧请求体 400、回执丢失后重放不发送 |
| 最终回归，页面 | `title-writing-resume.spec.tsx` |
| PostgreSQL 回归（未执行） | 已写 |

### R3 后台恢复跨工作区（P1）

**根因**：`recoverExpired`、`listClaimable`、`claimRun`、`getRunById` 都没有工作区条件。

**修复**

- 引擎绑定一个 `workspaceId`，并传给所有执行侧存储方法：恢复、列出、领取、读取、预约、提交、完成、保存故事、结束。
- 两种存储都在同一条语句里按工作区过滤；发送前、写入前的运行行锁也带工作区条件。
- 服务拒绝绑定到其他工作区的引擎；开关关闭时只围栏本工作区。

**提交**：`a16afea`

**证据**

| 类型 | 覆盖内容 |
| --- | --- |
| 基线复现（失败） | A 的维护替 B 发出 5 次调用 |
| 最终回归，内存存储与替身（通过） | `title-writing.workspace.spec.ts`：同一存储里两个工作区各有可恢复任务，开关与密钥不同；A 的维护和 `drive` 都不改变 B 的运行、步骤、调用和故事，反之亦然 |
| PostgreSQL 回归（未执行） | 已写 |

### R4 集成入口会无条件清库（P1）

**根因**：根 `beforeAll` 无条件执行 `DROP SCHEMA public CASCADE`，授权变量只控制后面的 describe。文档还让人先执行草案，再跑会清掉它的整包 integration。

**修复**

- `title-writing-store.integration.spec.ts` 改为只读，只检查已应用的迁移里没有草案表。
- 草案表上的测试移到 `title-writing-store.acceptance.spec.ts`，只由专用命令 `pnpm --filter @ai-drama/database title-writing:acceptance` 收集。这个命令的配置只包含这一个文件；`pnpm test` 排除它。
- 打开任何连接之前必须同时满足：
  - `TITLE_WRITING_DRAFT_SQL_AUTHORIZED=true`
  - `TITLE_WRITING_ACCEPTANCE_DATABASE_NAME=ads_title_acceptance_<后缀>`
  - `TITLE_WRITING_ACCEPTANCE_DATABASE_URL` 指向同名库；不使用 `DATABASE_URL`，与它相同或同名都拒绝
- 任何写入之前，只读确认连接到的库就是这个名字，并且没有任何表。
- 入口不删库、不删表、不清表；只对这个新库执行迁移和草案。
- 文档改为这一种用法。

**提交**：`4e71ad8`

**证据**

| 类型 | 覆盖内容 |
| --- | --- |
| 最终回归（通过） | `title-writing-acceptance-guard.spec.ts`：12 种环境拒绝；4 种身份拒绝（脚本化客户端，只证明判断逻辑）；静态检查验收文件无 DROP、TRUNCATE、DELETE，且守卫先于连接和迁移；只读集成文件无写语句；配置只收集该文件 |
| 静态分析 | 基线问题由阅读代码确认 |
| 执行情况 | 本轮没有建库、没有执行草案、没有清库 |

### R5 取消后，尚未发送的预约仍被发送（P2）

**根因**：`markCallSubmitted` 只检查所有权，没有检查取消。

**修复**

- `submitted` 转换在运行行锁内同时读取取消状态。
- 取消先提交：调用记为 `rejected / canceled_before_send`，步骤记为 `canceled`，不发送，不留悬挂的 `reserved`。
- 发送先提交：如实记录该调用的结果，费用仍为 unknown，之后停止。
- 返回值改为 `submitted | canceled | lost`。

**提交**：`a7c95d9`

**证据**

| 类型 | 覆盖内容 |
| --- | --- |
| 基线复现（失败） | 取消落在预约与提交之间，仍发出 1 次 |
| 最终回归，内存存储与替身（通过） | `title-writing-cancel.spec.ts`：两种提交顺序，以及取消后超时 |
| PostgreSQL 回归（未执行） | 两种顺序，以及 10 次竞争的一致性 |

### R6 剧本写入锁顺序相反（P2）

**根因**：导入先锁分集，再经 helper 锁项目；人工保存先锁项目，再锁分集。

**修复**

- 导入改为 运行 → 项目（`FOR UPDATE`）→ 按集号锁分集。
- 在项目锁内复核故事资格。
- 保留 helper 对当前、已批准、`CURRENT` 故事的再次检查。

**提交**：`fba5178`

**证据**

| 类型 | 结果 |
| --- | --- |
| 静态分析 | 读 `text-chain.ts` 中 `lockAggregateForRevision`、`lockProjectForAggregate` 的加锁顺序 |
| PostgreSQL 回归（未执行） | 导入与人工保存同一集并发 5 轮：无 40P01，互不覆盖 |

### R7 草案审核测试的前置状态错误（P2）

**根因**：测试没有完成任何分集步骤，就期待 `story_not_approved`，实际先返回 `not_ready`。

**修复**：验收测试通过真实存储的完整生命周期构造合法输出（预约、提交、带合法输出完成、保存故事、结束运行），再覆盖：

- 审核前拒绝
- 审核后三集各写入一次
- 重放不增加版本
- 单集已有剧本时该集冲突、其他集正常写入
- 当前故事未审核时拒绝
- 故事换版后拒绝，接受后才写入

**提交**：`4e71ad8`

**证据**：PostgreSQL 回归，**未执行**。

### R8 策划和大纲接受纯空白的必填内容（P2）

**根因**：必填文本只用了 `z.string().min(1)`。

**修复**

- 两个 schema 的必填文本改为去掉首尾空白后非空；会去掉全角空格。保存时保留原值，长度上限不变。
- 这两个 schema 没有可空字段；共享的分集剧本契约没有改动。

**提交**：`e4f8be6`

**证据**

| 类型 | 覆盖内容 |
| --- | --- |
| 基线复现（失败） | 纯空白策划被接受 |
| 最终回归（通过） | 领域测试覆盖空格、换行、制表符加全角空格，涉及每个叙事字段、人物和关系；引擎测试证明拒收后不启动下一步 |

## 后端与 SQL 草案变更

- **存储接口**
  - 执行侧方法都增加 `workspaceId` 参数。
  - `markCallSubmitted` 改为返回三态。
  - `prepareResume` 改为接收 `TitleResumeRequest`。
  - 都是本功能内部接口，没有其他调用方。
- **HTTP 接口**（功能默认关闭，生产强制关闭，没有已部署的调用方）
  - `POST .../resume` 的请求体由 `{confirmUncertain}` 改为 `{confirmUncertainCallIds}`，并要求 `Idempotency-Key`。
  - 新错误码 `TITLE_WRITING_CONFIRMATION_STALE`。
- **SQL 草案**
  - 新增 `title_writing_resume` 表，仍然只新增、不改旧表。
  - `storageReady` 现在也要求这张表存在。
  - 回滚说明已更新为按 resume → call → step → run 的顺序删除。
  - 草案仍在 `prisma/drafts`，未执行，未移入 `prisma/migrations`。
- **兼容性**：草案从未执行，没有存量数据，因此没有兼容性影响。

## 本地验证

| 命令 | 结果 |
| --- | --- |
| `pnpm verify`（Node 24.21.0、pnpm 10.17.0，HEAD `4e71ad8` 加本文档改动） | 退出码 0 |
| `git diff --check` | 见最终回复 |
| 真实 Chromium + 已构建网页 + 桩 API | 一键流程与待确认状态在 1280、390 下均通过；只验证布局与交互 |

`pnpm verify` 的测试数：

| 包 | 测试数 |
| --- | --- |
| web | 323 |
| providers | 116 |
| api | 97 |
| domain | 86 |
| database | 49 |
| worker | 68 |
| contracts | 13 |
| health | 7 |
| comfyui-adapter | 4 |

## 仍未执行

- PostgreSQL 验收：`title-writing:acceptance`。需要授权的新建空库。
- 真实项目 API 加真实浏览器的全流程。
- 千问、OpenAI、DeepSeek 的真实调用；没有发生付费。

## 遗留问题

- 没有金额硬预算。次数、并发、token 限制都不是金额预算。
- 每次输出最多 4096 token，较长的剧本可能被截断；截断会被拒收。
- 预约后因取消而关闭、实际没有发出的调用，仍计入当次的 `callsUsed` 和每日次数。这是偏保守的计数。
