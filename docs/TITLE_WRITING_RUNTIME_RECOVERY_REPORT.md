# 标题创作：正式运行时装配与进程崩溃恢复验收报告

日期：2026-10-09。分支 `feat/title-driven-ai-writing`，PR #58（Draft）。

**结论：**正式运行时装配和真实的进程终止、重启恢复，都已在隔离 PostgreSQL、模型替身条件下验收通过。

- 模型始终是替身，付费调用为 0。
- SQL 草案只在一次性隔离库中执行。
- 正式迁移、真实供应商验收和部署都没有执行。
- 本轮没有发现实现缺陷，产品代码没有改动。

## 1. 现场与 SHA

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio-title-writing`（origin `xyq-dev/ai-drama-studio`） |
| 起点 | `cf0c331c04ea820332e9e1dc771d6d20c7570028`。开始时本地、远端、PR head 一致，工作区干净，没有新提交 |
| 源码 SHA（验收对象） | `756797c5d55d9015553adcdf6f77c1ad0019bde2` |
| 最终 HEAD | 本报告所在的文档提交，只改 `docs/`。它自己的 CI 记在 PR #58 说明里，不拿源码 SHA 的结果代替 |
| 其他 worktree | 未触碰，包括 `D:\Projects\adst-baseline-761acd6` |

本轮提交：

| 提交 | 内容 |
| --- | --- |
| `cb4e375` | 运行时验收：`apps/api/src/studio/title-writing.runtime-acceptance.spec.ts`、测试专用预加载 `apps/api/acceptance/title-writing-runtime-preload.cjs`、专用配置和命令 `title-writing:runtime-acceptance`、默认单测排除；工作流新增 `runtime` 作业，并接入发往 main 的 pull_request 和 main push |
| `756797c` | 证据记录分支 head SHA（pull_request 事件里 `GITHUB_SHA` 是合并提交），并补记恢复后的调用列表 |
| 文档提交 | 本报告，以及 `docs/TITLE_DRIVEN_WRITING.md` 状态表 |

## 2. 正式运行时装配：已真实执行

**API 的启动方式：**
- 每次都用正常入口启动子进程：`node --require <预加载> dist/main.js`。
- 启动路径与生产相同：`main.ts` → `loadApiEnv` → `AppModule.register` → `StudioRuntime.open`，其中的存储、执行引擎和 15 秒恢复定时器都是正式代码。
- 测试没有替换 `TITLE_WRITING_SERVICE`，没有自己构造服务，也没有调用 `maintain()`。

**模型替身如何接入：**
- 接在进程的出站边界。产品仍用自己的 `fetch` 访问白名单里的 `https://dashscope.aliyuncs.com/...`。
- 测试专用预加载把发往供应商主机的 fetch 原样转交给测试进程里的计数替身：方法、路径、请求头、正文都不变。
- 其他非本机的 fetch 一律拒绝。
- 替身计数保存在测试进程里，杀掉 API 不会清零。

**预加载的守卫（默认拒绝，在 API 启动前结束进程）：**
- 必须有验收授权。
- `DATABASE_URL` 必须指向命名的一次性验收库，且主机是本机。
- 控制端点必须是本机 http。
- 预加载不输出任何内容。没有产品代码引用它，它不进入构建产物。

**第二层网络防护：**作业把千问、OpenAI、DeepSeek 的主机名在 `/etc/hosts` 中指向 127.0.0.1，证据记录了三个主机都解析到 127.0.0.1。

**额外的检查：**
- 仓库根目录存在 `.env` 时拒绝运行，因为 API 会读取它。
- 运行配置 `TITLE_WRITING_MAX_ACTIVE_RUNS=5`、`TITLE_WRITING_MAX_CALLS_PER_DAY=100`，用于并行的三个崩溃场景。这是配置而不是规则：租约、恢复规则、每次运行的调用上限和费用未知规则都没有改。

**结果（每一行都是一次独立的正式启动，替身发送都是 0）：**

| 配置 | 结果 |
| --- | --- |
| 默认关闭（不设开关） | 404 `TITLE_WRITING_DISABLED` |
| `NODE_ENV=production` 且开关打开 | 404 `TITLE_WRITING_DISABLED`；options 也是 DISABLED |
| 开启但草案表不存在 | 503 `TITLE_WRITING_STORAGE_UNAVAILABLE` |
| 开启但服务端未配置操作者令牌 | 403 `TITLE_WRITING_FORBIDDEN` |
| 开启但缺 `DASHSCOPE_API_KEY` | 503 `TITLE_WRITING_PROVIDER_UNCONFIGURED` |
| 合法配置：请求不带令牌 / 令牌错误 | 403 / 403 |

以上拒绝之后，任务表仍为 0 行。

**合法配置下的正常运行：**HTTP 请求经正式运行时启动任务，五步完成，替身调用 5 次，故事保存 1 个 DRAFT 版本。

**审核后写入：**在场景 C 的作品上验证（见第 3 节 C）：
- 审核前写入，返回 409 `TITLE_WRITING_STORY_NOT_APPROVED`。
- 经现有审核 API 批准故事后写入，三集结果为 saved、saved、conflict。
- 第 3 集通过 API 准备的人工剧本，正文和当前版本指针都没变。
- 共 3 个剧本版本，重复写入后仍是 3 个。

## 3. 真实进程崩溃与恢复：已真实终止并重启

三个场景在同一个 API 进程（第 1 代）里同时摆好故障位置，然后一次 SIGKILL，再在同一个库上启动第 2 代进程。

**故障时机的安排方式（不用固定 sleep）：**
- “已预约未发送”：预加载在“把调用标为已发送”的那条 SQL 执行前询问控制器，被指定的调用得不到答复。此时预约已提交到 PostgreSQL，发送事务还没有执行。
- “已发送”：替身收到请求后不回答。
- 每个场景都先由控制器记录、并用数据库状态确认到位，才执行终止。

**终止与重启：**
- 只终止测试自己启动并记录的 PID。
- 确认该 PID 已退出（`process.kill(pid, 0)` 失败），并确认该代进程在数据库中的会话已全部结束（按 `PGAPPNAME` 统计为 0）。
- 被暂停的发送事务随进程一起消失，杀进程后三个任务的调用状态与杀进程前完全一致。

**恢复：**
- 只由第 2 代进程自己的恢复定时器完成。产品租约 240 秒，没有缩短。
- 测试只做有界轮询，上限为“租约剩余时间 + 4 个维护周期 + 60 秒”。
- 推送运行 37884818164 的时间线：
  - 04:39:41.501 SIGKILL 第 1 代（pid 3769）。
  - 立即启动第 2 代（pid 3786）。
  - 三个任务的租约分别到 04:43:40.958、04:43:40.997、04:43:41.041。
  - 04:43:42.338 观察到恢复完成，距杀进程 241 秒，即租约到期后的第一个维护周期。
  - 第 2 代在此期间共上报 16 次恢复轮次，租约未到期前的轮次没有改动任何任务。

| 场景 | 杀进程前（数据库 / 替身） | 重启并恢复后 |
| --- | --- | --- |
| A 已预约未发送 | `concept#1 reserved`；替身 0 次 | `concept#1 rejected/executor_lost_before_send`，随后 `concept#2` 及其余四步完成；替身共 5 次；该作品 1 个任务、1 个故事版本 |
| B 已发送、结果未持久化 | `concept#1 completed`、`outline#1 submitted`；替身 2 次 | `outline#1 unknown/executor_lost`，任务 `needs_attention`；替身仍为 2 次 |
| C 已有步骤结果提交 | 故事策划、大纲、第 1 集已完成，`episode:2#1 reserved`；替身 3 次 | 已完成的三步没有再调用；`episode:2#1` 被释放，`episode:2#2` 和第 3 集完成；替身共 5 次；1 个故事版本，写入前 0 个剧本版本 |

**B 的后续（都经现有 HTTP 接口）：**
- 进入结果未知后，6 次读取（latest 和 get）加上又观察到的 2 次真实恢复轮次（04:43:57.204、04:44:12.204），替身仍为 2 次。
- **续跑被拒绝的四种情况：**
  - 不带令牌：403；
  - 令牌错误：403；
  - 不带幂等键：400；
  - 带令牌但未确认可能已计费：409 `TITLE_WRITING_NEEDS_CONFIRMATION`。
  - 这四次都没有发送。
- 提交有效令牌、当前不确定调用的确认和幂等键后，返回 200，任务完成。替身共 6 次：大纲重发 1 次，加上三集。故事策划没有重做，全程只调用过 1 次。
- 用同一个幂等键重放，返回 200，替身仍为 6 次，续跑记录只有 1 条。

## 4. 哪些是真实的，哪些是模拟的

| 项 | 性质 |
| --- | --- |
| API 启动、环境解析、模块注册、`StudioRuntime.open`、存储、引擎、恢复定时器 | 真实，与生产入口相同 |
| 进程终止 | 真实 SIGKILL；PID 退出和数据库会话结束都已核实 |
| 重启 | 真实的新进程，使用同一个隔离库 |
| 恢复 | 真实的产品租约（240 秒）和真实的定时器周期，测试不驱动 |
| 模型 | **替身**：在进程出站边界转交给计数替身，付费调用为 0 |
| “已预约未发送”的停顿 | 测试设施（受守卫的预加载）暂停在“标为已发送”的 SQL 之前；进程在停顿时被真实终止 |
| “已发送、结果未持久化” | 替身不回答，进程在等待时被真实终止 |
| 冲突集的人工剧本 | 通过 API 准备 |

以前浏览器验收里的“迟到结果”用的是逻辑时钟，本轮没有用逻辑时钟代替真实终止。

## 5. 验收设施与 CI

**专用命令与收集范围：**
- 命令 `pnpm --filter @ai-drama/api title-writing:runtime-acceptance`，需先 `pnpm build`。
- 默认 `vitest` 配置排除这个文件；通用 integration 只收集 `*.integration.spec.ts`，也不会收集它。
- 未授权时在连接前以退出码 1 拒绝；预加载未授权时以退出码 78 结束进程。

**工作流：**
- `Title writing isolated acceptance` 新增 `runtime` 作业。
- 触发方式：保留功能分支 push 和 `workflow_dispatch`，新增 main push 和发往 main 的 `pull_request`，后两者沿用仓库的路径过滤写法。
- 不使用 `pull_request_target`，权限仍为 `contents: read`，没有生产凭据，也没有部署步骤。

**清理（失败路径不遮盖原始错误）：**
- `afterAll` 依次处理：停止测试自己记录的子进程（SIGTERM，不退出再 SIGKILL）、断开挂起的替身连接、关闭控制服务和连接池。
- 证据写出前会检查不含令牌、假密钥和连接地址。
- 作业最后确认 3101 端口没有残留监听。
- 容器和网络在作业结束时删除。

| 运行（源码 SHA `756797c`） | 结果 |
| --- | --- |
| push run [37884818164](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37884818164) | 全部成功，第 1 次尝试。runtime 作业 113672331969（5/5，库 `ads_title_acceptance_runtime_37884818164_1`），browser 113672332126（4/4），api 113672332133（10/10），store 113672332146（25/25）。每个库写入前用户表 0，PostgreSQL 16.15 |
| pull_request run [37884821545](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37884821545) | 全部成功。测试的是与 main 的合并提交 `770dd44`，head `756797c`；runtime 恢复结果与 push 运行一致（241 秒，16 次轮次） |
| 证据 artifact（push 运行） | runtime 11595673358、browser 11595553307、api 11596226406、store 11595652794。已下载核对：没有令牌、密钥或连接地址 |
| 同一 SHA 上的其他工作流（pull_request 事件） | 全部成功，均为第 1 次尝试：Writing assistant API 37884821538、M1-C 37884821509、M2-A 37884821506、M2-C 37884821513、M3-A 37884821548、M3-B 37884821531、Beginner creator web 37884821516、M4 three episode sample 37884821510 |
| `cb4e375` 的 push run 37884230543 和 PR run 37884234905 | 全部成功。它们的证据只记录了 `GITHUB_SHA`，PR 运行中那是合并提交，因此 `756797c` 改为显式记录 head |

**本地：**
- `pnpm verify` 退出码 0（Node 24.21.0、pnpm 10.17.0，engine-strict）。各包测试数与上一轮相同：web 366、api 97、providers 116、domain 86、database 49、worker 68、contracts 13、health 7、comfyui 4。
- `git diff --check` 为 0。
- 预加载的本地冒烟检查：供应商请求被转交并保留 Authorization，其他外网被拒绝，pg 查询已被接管。

既有验收保持原样，没有删除、跳过或放宽：store 25、api 10、browser 4。

## 6. 未执行与遗留

- 没有调用真实模型（千问、OpenAI、DeepSeek），付费调用为 0。
- 没有执行正式迁移：草案仍在 `prisma/drafts`，只在一次性 CI 库中执行过。
- 没有部署，也没有修改服务器开关。
- 只测了 SIGKILL 一种终止方式，没有测断电或宿主机重启；数据库本身没有重启。
- “已预约未发送”的停顿点依赖测试预加载匹配那条 SQL 的文本。以后如果改写这条语句，验收会因为等不到停顿而失败，不会误判通过。

## 7. 状态

| 项 | 状态 |
| --- | --- |
| commit | 是：`cb4e375`、`756797c`，以及本报告的文档提交 |
| push | 是，普通推送 |
| merge / 推 main / force push | 否 |
| pack / release / deploy / 修改服务器开关 | 否 |
| 正式 Migration | 没有新增或修改 |
| 隔离草案执行 | 只在一次性 CI 库中执行 |
| 付费调用 | 0 |
| PR #58 | 已更新说明，仍是 Draft，等待 Codex 独立复审 |
