# V1_RELIABILITY_CLOSEOUT_REPORT

V1 可靠性收尾：PR #48 复审登记的 5 项 P2，加上「可用于视频」口径与参考图成本身份两项，共七项。本轮修复通过不等于完整 V1 或商业运营验收通过。

## 现场

| 项目 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio` |
| 远端 | `origin` = `https://github.com/xyq-dev/ai-drama-studio.git` |
| 分支 | `fix/v1-reliability-closeout`（新建，从 fetch 后的 `origin/main` 创建） |
| 起点 | `origin/main` = `2fb19acfe086392eb415a3be92b4c4a6830a4cfd`（fetch 后核实，与给定历史参考一致） |
| 代码提交 | `a4b5c56` 千问、`7783a1f` 数据库/领域、`2501a91` 网页、`c595aed` Worker |
| 最终 HEAD | 见 PR #49 当前 HEAD；本报告所在的文档提交之后无代码改动 |
| PR | https://github.com/xyq-dev/ai-drama-studio/pull/49 |
| 已有改动 | 未跟踪的 `m3-av-e2e-output-ci/` 原样保留，未纳入提交。未使用 reset、clean、stash 或 force push |
| 本机环境 | Node 24.21.0（`Tools/node/node-v24.21.0-win-x64`，PATH 默认的 23.9 不满足 engines）；无 Docker、无 PostgreSQL |

仓库内不存在 `AGENTS.md`、`CLAUDE.md`；已读 README、ENGINEERING_WORKFLOW、IMPLEMENTATION_PLAN、V1_DELIVERY_MATRIX、V1_AUTHORIZATION_CHECKLIST、CHARACTER_REFERENCE_IMAGES、QWEN_WEB_INVOCATION 及相关代码。

## 七项

测试性质缩写：**单测**（纯函数或假依赖）、**假客户端**（数据库客户端以内存行按绑定参数应答，只验证发出的语句和作用域参数，不验证 SQL 在 PostgreSQL 上的语义）、**组件**（happy-dom + 模拟 fetch，不是真实页面）、**CI-PG**（CI 专用隔离 PostgreSQL）、**Chromium-桩**（真实 Chromium + 本地生产构建，`/api/v1` 由 Playwright 路由桩应答，不是端到端）。

### 1. 参考图分页与当前选定项

- 修复：`CharacterReferenceStore.listForCharacter` 仍只取最近 100 张（取 101 条判断 `hasMore`）。选定项由选择记录给出 ID，不在本页时按 ID 单独读取，条件为同一 workspace、project、角色（经来源修订）且 `reference_role = character_reference`。不信任客户端 ID，不扩大查询。选择记录也按项目过滤。
- 证据：`packages/database/src/character-reference-listing.spec.ts`（假客户端，10 例）：150 张、选定项为最旧一张时读到且可用；选定项在页内不发第二次读取；页外失效项给出 `REFERENCE_NOT_ACTIVE`；另一 workspace / project / 角色 / 普通图片四种错误作用域均得到 `asset: null` 与 `REFERENCE_UNAVAILABLE`；页查询参数固定为 `LIMIT 101`。
- 旧实现对照：10 例在旧实现上全部失败，但失败点是假客户端不识别旧 SQL 形状，**不能算语义对照**。旧缺陷（只在页内 `find`）由代码阅读确认。
- 依赖草案：是。`character-reference-store.integration.spec.ts` 新增「超过 100 张仍按 ID 读取选定项、他工作区 NOT_FOUND」用例，只在 `CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED=true` 的授权库运行，**未执行，不计入通过数**。

### 2. 参考图可用状态

- 修复：领域新增 `characterReferenceVideoBlockers`，严格视频门（`strictVideoReferencesInTransaction`）与列表共用，避免两套规则。列表返回 `videoReadiness: { usable, blockers }`，`selection.usable` 与其一致；角色当前修订未审核时不再显示「可用于视频」。每张图的 `selectable` 由服务端用选择接口自己的规则（`selectedReferenceUsable` + 修订 CURRENT）判定，页面不再自算。页面逐条显示原因；历史图与审核记录照常显示。
- 证据：领域单测（与 `selectedReferenceUsable` 逐变体一致）；假客户端：未审核角色修订给出 `CHARACTER_REVISION_NOT_APPROVED` 且图仍可选、多原因按序列出；组件：页外选定项显示状态与原因、无原因时显示可用；Chromium-桩 1280/390 显示「角色当前版本尚未审核通过」。
- 依赖草案：真实库用例（原「选择后 usable」断言改为未审核角色时为 false 并列出原因）依赖草案，**未执行**。

### 3. 千问先鉴权，再探测存储

- 修复：`QwenWebService.decide` 先在不访问数据库的情况下判定生产/开关、令牌、Provider 配置；全部通过后才 `storageReady()`。默认关闭和 production 仍为 404。令牌不进入日志、sessionStorage、响应或错误详情（未改动这部分路径）。
- 证据：`apps/api/src/studio/qwen-web.service.spec.ts` 新增用例：缺失、空、错误、多一字符四种令牌 × 存储有/无，对 status/request/get 三个入口断言探测 0 次、预约 0 次、维护 0 次、transport 0 次，且有无存储时响应完全相同；正确令牌每次恰好探测 1 次。
- 旧实现对照：已做，旧实现该例失败（探测 3 次）。
- 依赖草案：否。

### 4. 千问输入字节上限

- 计量对象：仓库规定的是「合法输入 256,000 字节」（`QWEN_WRITING_INPUT_MAX_BYTES`，CLI 读取输入文件的字节）。网页发送的 `input` 与 CLI 输入文件是同一对象，因此计量 `input` 的紧凑 JSON 序列化的 UTF-8 字节；未改为某个文本字段，也未改成外层请求体。API 对解析后的值重新序列化得到相同字节。
- 修复：`@ai-drama/contracts` 新增 `qwenWritingInputByteLength` / `qwenWritingInputWithinLimit`（TextEncoder，浏览器与 Node 共用）。网页在准备指令后即显示字节数并禁用两个发送按钮，超限时不生成请求标识、不写 sessionStorage；服务端在维护、预约、发送前返回 413 `QWEN_WEB_INPUT_TOO_LARGE`，`runQwenWebWriting` 再独立检查。原请求标识重放、不确定结果确认、冻结指令语义不变；千问本无成本记录，超限时不产生任何记录。
- 证据：contracts 单测（ASCII/中文/emoji/控制字符的字节数；中文与 emoji 恰好 256,000 通过、256,001 拒绝，且字符串长度都低于上限）；providers 单测（超限 413、未预约、未发送，同键改小后正常首发）；API 单测（各字段均在字符上限内的 episode 输入恰好 256,000 字节被预约并发送 1 次，256,001 字节 413 且预约/维护/transport 均为 0；中文 20,000 字按字节计）；组件测试（超限提示「输入为 27x,xxx 字节」、按钮禁用、无请求标识；服务端 413 文案）。注：story 模式各字段在字符上限内时最多约 156,000 字节，越界需 episode 模式且含 JSON 转义字符。
- 旧实现对照：已做，旧实现该例失败（超限输入被预约并发送，结果 422）。
- 依赖草案：否。

### 5. 角色参考图任务可见与完成刷新

- 修复：生成返回 202 时只显示「已受理（202）。这不是生成成功」，随后用既有 `GET /generation-jobs/:id` 串行跟踪（上一读完成后再等 1.5 秒）；终态停止；页面隐藏时暂停、恢复可见立即重读；成功后重读参考图列表，失败/取消显示真实状态与错误码。项目、角色、修订变化或卸载会使旧应答失效（任务绑定受理时的作用域），不改写列表、提示和 busy。工作台任务区增加「角色参考图任务」，与其他任务同一轮询，只提供取消（服务端的通用重试不适用参考图，不显示重试）。草稿、If-Match、审核规则未改。
- 证据：组件（`character-reference-panel.tracking.spec.tsx`，假定时器，9 例）：202 受理→QUEUED→RUNNING→SUCCEEDED 串行且终态后无读取；FAILED/CANCELED 原样显示；隐藏暂停、可见重读；切换角色后旧任务应答和迟到的 202 不改写新角色；切换修订后旧列表应答被丢弃；卸载后停止。工作台组件：参考图任务出现在任务区、运行中继续轮询、无重试按钮。Chromium-桩：1280 与 390px 走完「生成→受理→跟踪→成功→列表重读」，无横向滚动（截图未入库）。
- 旧实现对照：已做，旧面板 7 例失败（无任务跟踪、无原因显示）。本轮新增的「切换后不改写」用例走真实挂载组件，不是组件替身。
- 依赖草案：真实后端上的生成仍需草案；未执行。

### 6. 恢复循环的错误隔离

- 修复：新增 `apps/worker/src/runtime/recovery-modules.ts`。镜头媒体恢复与参考图恢复按顺序（不并行）运行，各自失败按模块名上报（只报错误类名），另一模块照常执行；关机开始或连接池已关闭视为进程停止，整轮中止并原样抛出；调用方可指定致命错误。全局配置在启动时校验（`EnvValidationError`），不进入循环。参考图恢复：执行记录读取移入逐行 try；暂时故障汇总为 `AggregateError`；永久拒绝只 `failJob` 所属 attempt，结算失败不再被空 catch 吞掉（终态竞争除外）；已绑定请求只 `inspect` 不再 `submit`。顶层 reconcile 不再重叠执行，错误上报而非 `catch(() => undefined)`。
- 证据：`recovery-modules.spec.ts`（两个方向一方失败另一方仍跑、串行峰值 1、停止/池关闭/致命错误中止）；`mock-character-reference.spec.ts`（永久/暂时/兄弟行、执行读取失败不跳过兄弟、结算失败上报、终态竞争忽略）；`start-runtime-media.spec.ts`（真实 `startQueueRuntime` + 模拟数据库层）：媒体恢复连续抛错期间参考图未绑定 attempt 被重新入队、已绑定请求被落库且 `submit` 0 次，故障解除后图片恢复 1 次；反向同样成立。
- 旧实现对照：已做。旧实现下第一例因参考图恢复被整轮跳过而失败；第二例旧实现本可恢复媒体，失败点是没有错误上报。
- 依赖草案：否（Worker 逻辑）。真实数据库/文件系统故障注入未做。

### 7. 参考图成本身份校验

- 修复：`mock-media-cost.ts` 新增 `guardSynchronousMockReferenceCost`，与普通 Mock 图片 `guardSynchronousMockImageCost` 共用身份比较和「无估算」检查（抽出，不改图片口径与错误文案）。要求成本的 workspace/project/job/attempt/Provider 配置/请求 ID 与资产一致，provider `mock-media`、model `mock-v1`、幂等键 `<请求ID>:request:actual`、USD 0 的 ACTUAL；库内 attempt 属于 `MEDIA_CHARACTER_REFERENCE` 任务、快照与任务一致且是该角色修订的 `m3.mock.character-reference.v1`、配置为 `mock-media/image.generate`、请求 ID 与客户端键为 `mock-media|sync|image.generate|<job>:<attemptNo>` / `<job>:<attemptNo>`；该请求无估算行、估算键未占用。`completeGeneration` 在血缘检查后、任何写入前调用，拒绝为 `COST_CONFLICT`（Worker 归为永久，结束所属 attempt）。资产、依赖、ACTUAL、成功事件仍在 `succeedJobWithArtifact` 的同一事务。不补历史账、不重开终态任务。
- 证据：假客户端（17 例）：一致时依次写资产/依赖/成本；11 种成本字段错误与 5 种绑定错误均拒绝且没有任何 INSERT/UPDATE。CI-PG：守卫 SQL 在已执行表上验证（接受、11 种字段冲突、任务类型/能力/快照漂移/修订不符/客户端键、估算行与估算键占用），位于 `character-reference-store.integration.spec.ts` 非草案段，由 CI 的 database integration 执行。
- 旧实现对照：去掉守卫调用后 16/17 例失败。其中 13 种身份错误旧实现确实会接受；ESTIMATED、币种、金额 3 种旧实现在写入资产后由 `assertSyncActualCost` 拒绝并随事务回滚，只在假客户端的写入顺序断言上失败。
- 依赖草案：完整 `completeGeneration` 的事务回滚（资产/依赖/成本/事件均无残留）需要草案列，**未编写也未执行**，登记为授权后验收项。

## 后端修改与 Migration

| 位置 | 原因 | 影响 |
| --- | --- | --- |
| `apps/api` `QwenWebService` | 第 3、4 项 | 只在开关开启时生效；默认关闭行为不变 |
| `packages/providers` `runQwenWebWriting` | 第 4 项 | 新错误码 413，仅超限输入 |
| `packages/contracts` | 第 4 项共享计量 | 新增两个导出 |
| `packages/domain` | 第 2 项共享规则 | 新增函数；严格门判定结果与原逻辑等价，拒绝时 `details` 多一个 `blockers` |
| `packages/database` 参考图存储与成本 | 第 1、2、7 项 | 列表响应新增字段（`selection.asset`、`videoReadiness`、`items[].selectable`、`hasMore`）；参考图完成多一次只读校验。仅在草案结构存在时可达 |
| `apps/worker` 恢复 | 第 6 项 | 恢复顺序不变；失败上报到 stderr（仅类名）；reconcile 不重叠 |

Migration：**不需要**。没有新增或执行 Migration，`packages/database/prisma` 下（含两份草案）与 `origin/main` 无差异。`QWEN_WEB_WRITING_ENABLED` 默认关闭、`M3_CHARACTER_REFERENCE_GATE` 默认 legacy 未变；草案缺失时依赖功能仍 503，不回退内存。

## 测试命令与结果

| 命令 | 结果 | 性质 |
| --- | --- | --- |
| 各项定向 vitest（见上） | 通过 | 单测 / 假客户端 / 组件 |
| `pnpm m3-av-e2e:check` | 通过 | 脚本语法与工作流检查 |
| `pnpm m3-av-e2e:outcome` | 23/23 通过 | node:test |
| `pnpm verify`（Node 24.21.0，最终代码） | exit 0。lint、typecheck、build 通过；测试 contracts 14、health 7、domain 80、comfyui-adapter 4、providers 51、database 54、api 70、worker 79、web 175，均全部通过；dev-doctor 9/9、ffmpeg-sbom 3/3；media-worker pytest 7 通过 2 跳过（既有跳过） | 本机 |
| `git diff --check` | 无输出 | — |
| 真实 Chromium（Playwright 1.55.1）本地 `next start` | 1280 与 390px 通过，横向溢出 0px | Chromium-桩，非端到端 |

首次失败记录（均已修根因，未放宽断言）：
1. 本机默认 Node 23.9 不满足 engines，换用已安装的 24.21.0。
2. 字节上限用例最初用 story 模式，字段字符上限内到不了 256,000 字节，改为 episode 模式并校验输入合法。
3. 组件测试中 `load` 参数签名写错、episode 快照字面量类型（typecheck）——测试代码问题。
4. 面板任务跟踪在切换角色的同一提交里会用旧任务 ID 多发一次读取（结果被丢弃，但属多余请求）——产品代码问题，改为任务绑定受理时作用域。
5. 面板中可见性判断被 TS 收窄（typecheck）——改为函数读取。

`pnpm verify` 中 web 测试输出的 55 条 `ECONNREFUSED 127.0.0.1:3000` 来自既有 `workbench.review.spec.tsx`，在基线代码上同样是 55 条，与本轮无关，测试仍通过。

**未执行、不计入通过数：** 参考图草案段全部真实库用例（含本轮新增与修改的 2 处）；千问草案存储集成；任何真实千问或付费调用；本机 PostgreSQL 集成（本机无数据库/Docker）；真实数据库/文件系统故障注入；有真实 API 与数据库的浏览器端到端。

## CI

见 PR #49 当前 HEAD 的检查。代码提交 `c595aed` 的结果：

| 工作流 | 结论 | Run |
| --- | --- | --- |
| M1-C integration | success | [37566302739](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302739) |
| M2-A integration | success | [37566302713](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302713) |
| M2-C integration | success | [37566302708](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302708) |
| M3-A integration | success | [37566302733](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302733) |
| M3-B integration | success | [37566302852](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302852) |
| Writing assistant API | success | [37566302705](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302705) |
| M4 three episode sample end-to-end | success | [37566302714](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37566302714) |

7/7 success。M3-B 日志：`character-reference-store.integration.spec.ts` 11 例中 7 例在隔离 PostgreSQL 上执行通过（含本轮 4 个参考图成本守卫用例），4 例为草案段跳过；数据库集成合计 100 通过、8 跳过（均为两份草案段）。之后的文档提交只改 `docs/`，其 CI 结论以 PR #49 当前 HEAD 为准。

## 状态

| 项目 | 状态 |
| --- | --- |
| Commit | YES（4 个代码提交 + 文档提交） |
| Push | YES，普通推送到 `fix/v1-reliability-closeout` |
| PR | #49，面向 `main`；CI 全绿后标记为可审查 |
| Review | 待 Codex 独立 Review；作者未自审合并 |
| Merge | NO |
| Deploy | NO（本轮未授权部署，未接触服务器） |
| Migration | NO |
| Paid calls | NO |

## 剩余阻断与下一步

1. 参考图草案授权后，在新建隔离库执行：第 1、2 项真实库用例，并补写、执行第 7 项 `completeGeneration` 全事务回滚用例。
2. 千问草案授权后执行存储集成；真实千问调用另需预算授权。
3. 有真实 API 与数据库的浏览器验收（生成→跟踪→刷新）待 CI 或授权环境。
4. `RuntimeReconciler` 内文本链恢复步骤之间仍是顺序且相互可跳过的旧结构，本轮只隔离了媒体与参考图两路，未扩大范围。
5. Codex 独立 Review 处理意见后再合并。
