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

以下是 2026-10-07 旧基线（`2fb19ac`）上代码提交 `c595aed` 的结果，**不代表合入 `main` 之后的代码**；合入后的结论只以 PR #49 当前 HEAD 的检查为准（见下节）：

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

## 2026-10-13 合入 main 与评审处理

| 项目 | 值 |
| --- | --- |
| 起始 HEAD | `89415cd`（与 `origin/fix/v1-reliability-closeout` 一致，无他人后续提交） |
| 合入 | `origin/main` `65c91af5d7483c2907c8bb54e2fc8f2d6fc35fde`（PR #66 合并），普通 merge，未 rebase |
| 冲突 | `apps/web/src/components/workbench.tsx`、`docs/V1_DELIVERY_MATRIX.md`，逐段融合，未整文件取一方 |

### 七项在最新 main 上的核验

`2fb19ac..65c91af` 区间内，`main` 对七项涉及的后端文件（`character-reference-store.ts`、`mock-media-cost.ts`、`qwen-web.service.ts`、`qwen-web-writing.ts`、`start-runtime.ts`、`mock-character-reference.ts`、领域与 contracts 中的对应模块）以及 `character-reference-panel.tsx` 均无改动。逐项读 `origin/main` 代码确认缺陷仍在：列表只在 100 条页内 `find` 选定项（1、2）；`decide` 先 `storageReady()` 再判令牌（3）；`QwenWebService.request` 无字节上限（4）；面板无任务跟踪、工作台跟踪类型不含参考图（5）；恢复为两个连续 `await` 且 reconcile `catch(() => undefined)`（6）；`completeGeneration` 无参考图成本身份校验（7）。七项均为「最新主分支仍存在」，修复全部保留，没有已被 `main` 修复或因架构变化失效的项。

架构变化只影响第 5 项的网页挂载点：`main`（PR #50）把工作台的数据加载、任务跟踪与轮询抽到 `apps/web/src/lib/project-base.ts`（`useProjectBase`，工作台与新手流程共用）。合入时 `workbench.tsx` 采用 `main` 的结构，参考图类型 `REFERENCE_WORKFLOW_TYPE`、`trackedWorkflow` 与 `noteWorkflowTransitions` 的参考图分支移到 `project-base.ts`；任务区保留 `main` 新增的合成任务（`MEDIA_COMPOSE`）并加回「角色参考图任务」。新手流程的任务区接收全部任务，因此也会显示参考图任务。

### Codex 评审三条（`89415cd`）

1. **接受参考图任务后未刷新 `/workflow-runs`**：在 `main` 结构下仍成立（空闲时轮询链已停，只有重读项目才会唤醒）。修复：面板新增可选 `onJobAccepted`，仅在 202 受理且作用域未变时调用；`EntityPane` 传入 `props.onSaved`（即 `reloadBase`），重读成功后由 `useProjectBase` 既有的唤醒逻辑跟踪新任务；参考图任务到终态不触发文本或镜头媒体重读。测试：`project-base.spec.tsx`（空闲→受理回调重读→列出并跟踪到 SUCCEEDED→epoch 不变→停止读取）、`character-reference-panel.tracking.spec.tsx`（202 回调一次、409 不回调、切换角色后迟到的 202 不回调）。
2. **旧版 API 不返回 `selectable` 时全部不可选**：仍成立。修复：`selectable` 为布尔值时以服务端为准（明确 false 不放开）；缺失时回到原页面规则（属于当前版本、ACTIVE、APPROVED）。测试：缺字段时当前版本已通过可选、DRAFT 与旧版本不可选；`selectable: false` 的已通过图仍不可选。
3. **恢复旧请求绕过 256,000 字节上限**：仍成立（同一冻结指令重放分支与「用原请求标识重新读取」都直接调用 `send`）。修复：检查移入唯一发送点 `send()`，复用 `qwenWritingInputByteLength` / `QWEN_WRITING_INPUT_MAX_BYTES`，与新请求及服务端同一口径；准备阶段的检查保留，超限时仍不生成请求标识。测试：以 sessionStorage 中的 version-1 旧记录（超限输入）分别走两条恢复路径，均提示字节数且不发送。

三条的 5 个行为用例在去掉对应修复后全部失败，恢复修复后通过（本机临时回退验证，未提交）。

### 本轮重点复核（只读，无代码改动）

- 按 ID 读取选定项：作用域为 workspace + 角色所在 project + 角色（经来源修订）+ `reference_role`；project 由按 workspace 查得的角色行给出，不取客户端值。列表 `selectable` 与 `selectInTransaction` 规则一致（修订 CURRENT + `selectedReferenceUsable`）。
- 参考图成本守卫：只做身份与绑定比较，不因已有 ACTUAL 行拒绝；重复写入仍由 `recordProviderActualCost` / `providerCostMatches` 判定幂等；守卫在任何 INSERT 之前，拒绝时随事务回滚。
- Worker 恢复：reconcile 只由定时器在 `status.running = true` 之后触发；`reconciling` 防重叠；参考图已绑定请求只 `inspect` 不再 `submit`；终态竞争不上报。
- 千问：`decide` 先在不访问数据库的情况下判定开关、令牌与 Provider，未授权请求不探测存储、不预约、不维护、不调用 transport；字节上限在维护与预约之前。

### 本机验证（Node 24.21.0，合入后的工作区）

| 命令 | 结果 |
| --- | --- |
| `pnpm typecheck` | 14/14 通过 |
| `pnpm lint` | 9/9 通过 |
| `pnpm test` | 全部通过：contracts 42、domain 135、database 94、providers 160、api 220（43 跳过，需数据库的既有跳过）、worker 79、web 590、health 7、comfyui-adapter 4 |
| 定向：本轮新增评审回归、`character-reference-cost` / `listing`、`recovery-modules`、`start-runtime-media`、`mock-character-reference`、`qwen-web.service`、`qwen-web-writing` | 通过（包含在上行） |

**未在本机执行**：`character-reference-store.integration.spec.ts` 等真实 PostgreSQL 集成（本机无 Docker/PostgreSQL，以 CI 的隔离库结果为准）；参考图与千问草案段（未授权，未执行）；Chromium 路由桩验收未在合入后重跑；真实 API + 数据库的浏览器端到端。

### Migration

不需要。`packages/database/prisma` 与 `origin/main` 无差异，本轮未编写或执行 Migration。

## 2026-10-13 合并前复核与补测

起点 `ae20cc9`（与远端一致），`origin/main` 仍为 `65c91af`，无需再合入。复核范围为 PR 相对 `origin/main` 的全部差异（含旧提交的后端修复），未发现本 PR 引入的实质问题；只修了下面一处测试缺陷，产品代码未改。

### 草案段的含义与执行

「草案段」指 `character-reference-store.integration.spec.ts` 中 `CHARACTER_REFERENCE_DRAFT_SQL_AUTHORIZED=true` 才运行的用例：它在测试开头 `DROP SCHEMA public` 重建的临时库上执行 `prisma/drafts/20261005000200_character_reference_image.sql`，不是正式 Migration，不涉及生产库、新业务开关或付费调用，且直接覆盖第 1、2、7 项。本轮在本机临时 PostgreSQL 16.4（官方便携二进制，仅在临时目录、127.0.0.1:55432、库 `ai_drama_pr49_test`）上执行。CI 不设置该变量，CI 上这些用例为跳过，不计为通过。

- 首次执行发现既有用例「超过 100 张仍按 ID 读取选定项」本身有缺陷：用 `UPDATE asset SET created_at` 构造旧图，被资产不可变触发器拒绝（`asset records are immutable`）。改为插入时指定 `created_at`，产品代码不变。修复后草案段 4 例全部通过。
- 新增「completeGeneration with a mismatched cost leaves nothing behind」：在真实表上建立已审核故事与剧本、来源于该剧本的当前角色修订、RUNNING 的参考图任务与 attempt，调用真实 `CharacterReferenceStore.completeGeneration`。模型、attempt、金额三种成本不符均返回 `COST_CONFLICT`，且资产、依赖、成本行、任务状态与 row_version、attempt、领域事件、运行状态与调用前完全相同；匹配成本成功一次（资产 1、依赖 1、ACTUAL 1、任务 SUCCEEDED、事件 +1）；同一完成重放返回 `JOB_TERMINAL` 且没有任何新增写入。去掉守卫调用后该例失败（不符成本被接受并写入资产），恢复后通过。
- 结果：草案开启 12/12 通过；CI 模式（不开草案）7 通过、5 跳过。

### 浏览器检查（桩 API，非端到端）

新增 `scripts/character-reference-web-stub-check.mjs`：`pnpm build` 的生产构建 + `next start` + 真实 Chromium（Playwright 1.55.1）；`/api/v1` 由同端口的本地桩 HTTP 服务按脚本状态应答（登录关闭），没有 API、Worker 或数据库。1280 与 390 px 均通过（含后来补充的别处受理任务场景）：空闲时不轮询；受理（202）后立即重读 `/workflow-runs` 并在任务区列出 QUEUED；RUNNING 时面板任务轮询与任务区轮询都继续；SUCCEEDED 重读参考图列表、任务区显示成功；之后停止轮询；第二次生成 FAILED 时面板显示错误码、任务区显示失败；无横向溢出、无页面错误。去掉 `onJobAccepted` 接线并重新构建后，该脚本在「受理后立即重读」处失败。真实 API/Worker/数据库的浏览器验收本机缺 Redis，未执行。

### Codex 对 `ae20cc9` 的新意见

意见：恢复的超限旧记录被 `send()` 拒绝后仍停在 `sending`，页面一直只提供必然失败的「重新读取」，普通请求又被「结果未确定」拦住。核实：成立（勾选确认后「发起新的调用」其实仍可用，但界面与状态误导）。修复：`send()` 拒绝时，对无法再读取结果的记录（`sending`，或无请求 ID 的 `reserved`/`submitted`）结算为 `unknown` 并写回 sessionStorage；不标为 `rejected`，因为上限生效前的页面可能已发出并产生费用。已结算的记录不改。结算后不再显示重新读取，新调用仍需勾选确认、使用新请求标识。两条恢复路径的回归用例补充了这些断言，去掉结算步骤后两例失败。

### Codex 对 `0541b1b` 的新意见

意见：参考图任务若在别的标签页受理，或页面在任务运行中刷新，面板没有本地任务可跟踪；项目任务轮询虽然看到它到终态，但参考图分支刻意不发任何刷新信号，新图要手动刷新才出现。核实：成立，属于第 5 项「完成刷新」的缺口（PR 之前完全没有完成刷新，不是回归）。修复：`noteWorkflowTransitions` 对参考图运行报告 `referenceBecameTerminal`（只在观察到由进行中变为终态时，首次看到即为终态不算）；`useProjectBase` 暴露 `referenceEpoch`；`EntityPane` 把它传给面板的 `refreshEpoch`，变化时重读列表（挂载时的初始值不重复读取）。工作台与新手流程两处挂载都已传入。文本与镜头媒体仍不因参考图任务重读。测试：hook（入口即 RUNNING 的别处任务到 FAILED 时 epoch +1、只 +1；入口即终态不 +1；受理路径 SUCCEEDED 时 +1）、面板（epoch 变化重读、不变不读）、浏览器桩脚本新增「别处受理任务完成后重读列表且面板未跟踪该任务」1280/390。去掉 epoch 递增与面板重读后 3 例失败。

### Codex 对 `eaea3dd` 的两条意见

1. **首次看到即为终态的参考图任务不刷新面板**：例如本页隐藏期间另一个标签页提交并完成了任务，返回可见时的重读第一次看到它就是 SUCCEEDED。成立，已修：与镜头媒体的 `firstTerminalMedia` 一致，参考图运行首次看到即为终态也计一次 `referenceEpoch`，之后重复读取不再递增。测试：首次即终态 +1 且重读不再 +1；隐藏期间别处完成、返回可见后 +1。去掉该条件后两例失败。
2. **成本守卫拒绝前已写入图片对象**：Worker 的 `persist()` 先 `objects.put` 再进入 `completeGeneration` 事务，守卫拒绝时数据库无残留，但本地 Mock 对象目录留下一张该任务的 PNG。核实：现象属实，但不在本 PR 修改：(a) `main` 上镜头图片 `persistMockImageOutput` 是同一顺序（先写对象，再在事务内执行 `guardSynchronousMockImageCost`），这是 Mock 媒体既有的「先写对象、后提交」设计，任何事务内拒绝（含旧实现已有的 ESTIMATED/币种/金额拒绝、血缘不符）都会留下对象；(b) 成本信封由 Mock 适配器生成，身份不符只在适配器缺陷时出现；(c) `LocalMockObjects` 在 production 下被禁止，对象键按任务与校验和确定，重试覆盖同一键，不影响任何已提交数据。改变顺序需要同时调整两条 Mock 媒体持久化路径，超出本 PR 范围，登记为遗留风险。

### Codex 对 `b6aef4a` 的意见

意见：发起生成后、202 返回前切换到同一作品的另一角色或修订，面板的作用域守卫直接返回，`onJobAccepted` 不再调用，已受理的任务不进任务区、也不被项目轮询。成立，已修：面板对每一次受理都以受理时的作品 ID 调用最新的回调（`onJobAccepted(projectId)`），在作用域检查之前；面板自身的提示与任务跟踪仍只属于原作用域，新角色的面板不接管旧任务。接收方改为 `useProjectBase.reloadForProject(projectId)`：只有该作品仍是当前显示作品时才重读。若作品已切换则丢弃，因为执行旧作品的读取会以旧数据取代新作品的读取（共享的请求序号）。`EntityPane` 新增 `onReferenceAccepted`，工作台与新手流程都传入 `reloadForProject`。测试：面板（切换角色后仍回调原作品 ID、不跟踪旧任务；切换作品后回调原作品 ID）、hook（离开的作品的迟到回调不读取、不改写新作品；当前作品会重读）、工作台模拟 API（受理被挂起时切到角色乙，放行后重读任务并在任务区列出 QUEUED，乙的面板不显示甲的任务）。把回调移回作用域检查之后，或去掉作品检查，对应用例失败。

### M3 lifecycle 失败归因

两次运行（本分支 [38332871876](https://github.com/xyq-dev/ai-drama-studio/actions/runs/38332871876)、未改动的 `main` `65c91af` [38334586101](https://github.com/xyq-dev/ai-drama-studio/actions/runs/38334586101)）都在步骤「Run real page, API, worker, and database acceptance」的 `node scripts/m3-av-e2e/run.mjs` 失败，输出相同：`compose FAILED COMPOSE_PROBE_FAILED Local compose renderer exited 3`。之前的 node:test 结果 `fail 0`。该工作流没有安装 FFmpeg 的步骤，而 M4 three-episode 工作流安装固定版本 FFmpeg 并通过同一脚本。结论：基线既有问题，不在本 PR 修复。
