# 剧名驱动的 AI 文字创作（第一阶段）

本轮只覆盖文字：剧名 → 故事策划 → 分集大纲 → 全部分集剧本。角色场景、分镜、素材、配音字幕、合成仍走现有链路。

## 实施记录（先于编码）

### 为什么不直接复用现有表

| 现有结构 | 无法承载的原因（代码依据） |
| --- | --- |
| `workflow_run` / `generation_job` / `job_attempt` | worker 的 `RuntimeReconciler.recoverExpiredLeases` 扫描所有 `RUNNING` 且租约过期的 job 并按 Mock 提供方语义重派或判失败（`apps/worker/src/runtime/reconciler.ts`）；[`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) 只允许 `REPLAY_SAFE_SYNC` 进入文本 Job。真实文本模型结果未知时不可重放，放进这套表会被 worker 误恢复。新手页面还会轮询 `workflow-runs`，新类型会干扰既有步骤判定。 |
| `cost_ledger` | `amount_decimal` 非空。费用未知时只能写 0，违反「费用未知不得写成 0」。 |
| `qwen_writing_request`（未执行草案） | 千问专用，`mode` 只有 story/episode，单请求语义，没有多步骤、取消和续跑；不能改名破坏既有调用。 |
| `script_revision` | 创建剧本版本要求来源故事版本 `APPROVED` 且 `CURRENT`（`packages/database/src/text-chain.ts` `createScriptRevisionInTransaction`），分集在故事通过审核后才存在。自动创作不能自动审核。 |

### 最小数据变更

迁移草案 `packages/database/prisma/drafts/20261008000100_title_writing.sql`（**未执行**），四张新表，不改任何旧表：

- `title_writing_run`：一次创作。工作区、项目、操作者、幂等键、输入哈希、冻结输入（剧名与设置）、Provider、模型、状态、取消请求时间、执行者与租约、单次调用上限、已用调用数、故事保存结果、错误码。
- `title_writing_step`：`concept`、`outline`、`episode:1..3` 五步。状态、当前尝试号、校验后的结构化输出、输出哈希、剧本落入的版本 ID 与状态。
- `title_writing_call`：每次真实发送一行。请求哈希、Provider、模型、状态、服务商请求 ID、响应模型、usage、`billing_status`（固定 `unknown`，金额列不存在）、错误码。
- `title_writing_resume`：每个被受理的续跑操作一行。续跑的 `Idempotency-Key`、请求哈希、确认过的不确定调用 ID（审查 R2 后新增）。

兼容：只新增表；旧数据不受影响。回滚：在没有依赖前可按 resume → call → step → run 顺序 `DROP TABLE`；已有数据时保留表、关闭开关（forward-fix）。草案未执行时 `storageReady()` 为假，接口在任何发送前返回 503 `TITLE_WRITING_STORAGE_UNAVAILABLE`。

### 状态

运行（run）：`running` → `completed` / `partial` / `needs_attention` / `canceled` / `failed`。

- `completed`：五步全部通过 schema 校验并持久化，故事已保存为 DRAFT 版本。
- `partial`：已有部分步骤完成，后续步骤被拒（格式错误、鉴权、限额等）；已完成结果保留，可续跑。
- `needs_attention`：存在结果未知的调用（超时、断连、5xx、执行者丢失），或故事保存冲突。不自动重发。
- `failed`：没有任何完成步骤且最后一步被拒。
- `canceled`：用户取消；已发出的调用如实记录结果，之后不再启动新步骤。

步骤（step）：`pending` → `reserved` → `submitted` → `completed` / `rejected` / `unknown`；`canceled` 表示取消后未启动。

调用（call）：`reserved`（已占位、未发送）→ `submitted`（发送前持久化）→ `completed` / `rejected` / `unknown`。取消先于 `submitted` 提交时，占位调用记为 `rejected` / `canceled_before_send`（没有发出），步骤记为 `canceled`。

### 规则

1. 浏览器只负责启动、查询、展示。服务端在 API 进程里按租约执行；每步之间检查取消；重启后维护循环接管租约过期的运行：`reserved` 未发送 → 可安全重来；`submitted` → `unknown`，运行转 `needs_attention`，不自动重发。执行器、恢复、列出、领取、发送和每次写入都限定在本 API 实例的工作区（SQL 条件含 `workspace_id`），不会处理其他工作区的任务。
2. 已完成步骤绝不再调用。续跑只处理 `rejected`、`canceled` 与 `unknown`。`unknown` 需要用户确认「可能重复计费」，确认的内容是页面上看到的不确定调用 ID：服务端在续跑事务里核对它必须**正好等于**当前每个 `unknown` 步骤当前尝试的调用，旧确认（例如上一次尝试的）一律拒绝。每次续跑带 `Idempotency-Key`：同键同内容重放只返回当前状态、不重置、不发送；同键不同内容拒绝。同一 Provider、同一模型，不自动换供应商。
3. 取消与发送：`submitted` 转换在运行行锁内同时检查取消。取消先提交 → 占位关闭、不发送；发送先提交 → 该调用如实记录结果（费用 unknown），之后不再开始新步骤。
4. 幂等：`Idempotency-Key` + 输入哈希。同键同输入返回原运行；同键不同输入 409 `IDEMPOTENCY_KEY_REUSED`；同一项目已有进行中的运行 409 `TITLE_WRITING_RUN_ACTIVE`（返回该运行 ID）。
5. 限额（服务端、原子）：工作区每 24 小时调用数、同时进行中的运行数、每次运行调用上限（五步 + 续跑余量）。金额预算未实现：没有可靠单价来源，不声称硬预算。
6. 每步输出必须通过统一 schema 与安全检查；拒绝空结果、只有空白的必填叙事字段、缺集、错集号、无法解析的内容。只收到响应不算完成。
7. 后续步骤只读取已保存的前序输出：大纲读取故事策划；第 N 集读取策划、大纲和第 1..N-1 集的交接事实。
8. 保存：故事只在项目还没有当前故事版本时创建 DRAFT 版本（同一事务记录到运行上）；已有人工故事 → `conflict`，生成结果保留在运行中。分集剧本保存在运行中，故事通过人工审核后由「写入剧本草稿」写入还没有剧本的分集；已有剧本的集记为冲突，不覆盖。写入按 运行 → 项目 → 分集 的顺序加锁（与人工保存剧本相同），在项目锁内复核故事资格。从不改审核状态。
9. 浏览器启动：未确认结果的启动请求（冻结的请求体、作品键、作品 ID、任务键）先写入会话存储并读回确认，写不进去就不发送；刷新后表单显示并锁定这次请求，只能「重试上次请求」（原样重放、同一组键）或「查看进度」，「放弃上次请求，重新填写」是单独的新创作。操作者令牌只在页面内存。只有能证明结果的回执才算确认：作品回执须带合法作品 ID，启动回执须带合法任务 ID 且属于本次作品；`{}`、`{run:null}`、缺编号、归属不符一律按「结果尚未确认」处理，保留冻结请求和原键。每次发送绑定页面生命周期与本次操作，离开页面后迟到的回执不改状态、不写存储、不跳转；会话存储按 `projectKey` + `runKey` 比对后才更新或删除，旧操作不会覆盖或删除新操作的记录。进度页的写操作（停止、续跑、写入剧本）只在同一作品、同一任务、且仍是当前操作时回写结果、错误和忙碌状态；读到同作品的新任务后，旧操作及其确认、续跑键一律失效；操作进行中如果已显示过更新的读取结果，回执的先后无法判断，不覆盖，改为再读一次（GET，不重发写请求）。
10. 密钥只从 API 进程环境读取，不进浏览器、日志或响应。端点由服务端固定；用户只能在服务端白名单中选 Provider 和模型。

### API（均在项目范围内，响应 `Cache-Control: private, no-store`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/writing/title-runs/options` | 可用 Provider、模型、默认值、缺失配置项名称、限额。不含密钥。 |
| POST | `/api/v1/projects/:projectId/title-runs` | 启动。体 `{ title, providerKey?, model?, settings? }`，需 `Idempotency-Key` 与 `X-Operator-Token`。 |
| GET | `/api/v1/projects/:projectId/title-runs/latest` | 最近一次运行（刷新后恢复）。 |
| GET | `/api/v1/projects/:projectId/title-runs/:runId` | 运行状态、各步结果、调用记录（无密钥、无原始响应）。 |
| POST | `/api/v1/projects/:projectId/title-runs/:runId/cancel` | 请求取消。 |
| POST | `/api/v1/projects/:projectId/title-runs/:runId/resume` | 续跑，体 `{ confirmUncertainCallIds?: string[] }`（页面上看到的不确定调用），需 `X-Operator-Token` 与 `Idempotency-Key`。旧确认 → 409 `TITLE_WRITING_CONFIRMATION_STALE`；同键重放 → 200 当前状态。 |
| POST | `/api/v1/projects/:projectId/title-runs/:runId/scripts` | 故事通过审核后把各集剧本写入还没有剧本的分集。体 `{ acceptStoryChanged?: boolean }`。 |

错误体沿用 `{ error: { code, message } }`。

## 配置变量（只列名称）

| 变量 | 用途 |
| --- | --- |
| `TITLE_WRITING_ENABLED` | 总开关，默认 `false`；生产强制关闭（与千问网页调用一致，待审查后再开）。 |
| `TITLE_WRITING_OPERATOR_TOKEN` | 发起、续跑时的操作者令牌（16–200 字符）。 |
| `TITLE_WRITING_DEFAULT_PROVIDER` | `qwen` / `openai` / `deepseek`。 |
| `TITLE_WRITING_MAX_CALLS_PER_DAY` | 工作区 24 小时调用上限，默认 30。 |
| `TITLE_WRITING_MAX_ACTIVE_RUNS` | 同时进行的运行数，默认 1。 |
| `DASHSCOPE_API_KEY`、`BAILIAN_BASE_URL` | 千问密钥与官方 compatible-mode 端点（沿用既有校验）。 |
| `TITLE_WRITING_QWEN_MODELS` | 千问可选模型 ID，逗号分隔，第一个为默认。 |
| `OPENAI_API_KEY`、`TITLE_WRITING_OPENAI_MODELS` | OpenAI 密钥与模型白名单。端点固定 `https://api.openai.com/v1/responses`。 |
| `DEEPSEEK_API_KEY`、`TITLE_WRITING_DEEPSEEK_MODELS` | DeepSeek 密钥与模型白名单。端点固定 `https://api.deepseek.com/chat/completions`。 |

密钥和模型名只从进程环境读取，不读 `.env` 文件。

## 供应商差异（2026-10-08 核对官方文档）

| | 千问 | OpenAI | DeepSeek |
| --- | --- | --- | --- |
| 接口 | `POST {BAILIAN_BASE_URL}/chat/completions`（compatible-mode） | `POST /v1/responses` | `POST /chat/completions` |
| 结构化输出 | `response_format: {type: json_object}` | `text.format: {type: json_schema, name, schema, strict: true}` | `response_format: {type: json_object}`，提示词须含 json 与示例；可能返回空内容 |
| 输出上限 | `max_completion_tokens`（沿用 4096） | `max_output_tokens` | `max_tokens`（1–384000） |
| 思考 | `enable_thinking: false` | 不设置 | `thinking: {type: disabled}` |
| 截断 | `finish_reason=length` | `status=incomplete`、`incomplete_details.reason=max_output_tokens` | `finish_reason=length` |
| 拒答 | `refusal` / `content_filter` | 输出内容类型 `refusal` | `content_filter` |
| usage | `prompt/completion/total_tokens` | `input/output/total_tokens` | `prompt/completion/total_tokens` |
| 余额 | — | 429 `insufficient_quota` | 402 |

统一错误分类：`auth`、`quota`、`rate_limited`、`bad_request`、`refusal`、`truncated`、`invalid_output`、`timeout`、`disconnected`、`server_error`、`redirect_rejected`、`response_too_large`、`provider_error`。前四类与输出类为 `rejected`（服务商已明确答复）；超时、断连、5xx、重定向、超限为 `unknown`（可能已计费，不自动重发）。

## 与后续媒体链路的衔接

故事通过审核、剧本写入并通过审核后，现有链路照常：分集 → 场景/镜头（`workflows/mock-scenes`、`mock-shots`）→ 角色参考图 → 镜头素材 → 合成下载。本轮不新增图片、视频、配音服务。

## 验收状态（2026-10-09，审查 R1–R9 与 F1–F4 修复后，分支 feat/title-driven-ai-writing）

审查修复记录见 [`TITLE_WRITING_REVIEW_FIX_REPORT.md`](TITLE_WRITING_REVIEW_FIX_REPORT.md)。

| 项 | 状态 |
| --- | --- |
| 三家适配器请求映射、输出解析、错误分类 | 单元测试（`packages/providers/src/text-writing.spec.ts`），可控 transport 替身 |
| 顺序、上下文、幂等、并发、取消、恢复、限额、冲突、剧本落入、空白字段拒收 | 引擎测试（`title-writing-engine.spec.ts`、`title-writing-cancel.spec.ts`、`title-writing-resume.spec.ts`），内存存储 + 可控替身 |
| 访问门禁、缺配置提示、密钥不外泄、续跑确认与重放、工作区隔离 | API 测试（`title-writing.service.spec.ts`、`title-writing.workspace.spec.ts`），内存存储 + 可控替身 |
| 开始页幂等、进度页续跑确认、迟到回执、读取串行（P2-A/P2-B） | 组件测试（`title-writing.spec.tsx`、`title-writing-start.spec.tsx`、`title-writing-start-identity.spec.tsx`、`title-writing-resume.spec.tsx`、`title-writing-scope.spec.tsx`、`title-writing-run-order.spec.tsx`、`title-writing-run-reads.spec.tsx`，模拟 fetch；幂等服务端为内存模拟） |
| 真实浏览器用户闭环（桌面 1440 与手机 390） | **已在隔离环境执行并通过**（2026-10-09，CI run 37873699546）：Chrome → 已构建 Next 页面 → 同源 `/api/v1` 代理 → 真实 API → 一次性 PostgreSQL，模型为计数替身，4 项。见 [`TITLE_WRITING_BROWSER_ACCEPTANCE_REPORT.md`](TITLE_WRITING_BROWSER_ACCEPTANCE_REPORT.md) |
| 验收入口拒绝行为 | 单元测试（`title-writing-acceptance-guard.spec.ts`）：环境检查为纯函数；身份检查用脚本化客户端，只证明判断逻辑 |
| PostgreSQL 存储（含 R2/R3/R5/R6/R7 的数据库回归） | **已在隔离环境执行并通过**（2026-10-09，CI run 37862662279，`postgres:16`，一次性空库）：22 项（P2-C 后为 25 项，run 37873699546），含结构核对、独立会话竞争、最后一个日额度竞争、预约与发送的恢复区分，以及用 `pg_blocking_pids` 证明的确定性锁顺序。见 [`TITLE_WRITING_ISOLATED_ACCEPTANCE_REPORT.md`](TITLE_WRITING_ISOLATED_ACCEPTANCE_REPORT.md) |
| 真实项目 API（模型替身） | **已在隔离环境执行并通过**：真实 Nest 应用、真实 HTTP、真实 PostgreSQL，模型为计数替身，10 项。进程崩溃恢复未执行 |
| 真实模型调用（千问 / OpenAI / DeepSeek） | **未执行**，Paid calls = NO |

### 隔离 PostgreSQL 与真实 API 验收（需单独授权；2026-10-09 已在 CI 隔离环境执行一次）

只用一个**新建的空库**，库名必须形如 `ads_title_acceptance_<后缀>`。入口默认拒绝：

- 在打开任何连接前，必须同时满足 `TITLE_WRITING_DRAFT_SQL_AUTHORIZED=true`、`TITLE_WRITING_ACCEPTANCE_DATABASE_NAME=ads_title_acceptance_...`、`TITLE_WRITING_ACCEPTANCE_DATABASE_URL` 指向同名库。不读 `DATABASE_URL`；若 `DATABASE_URL` 与之相同或同名，拒绝。
- 在任何写入前，只读确认连接到的库就是这个名字且没有任何表。
- 入口不删库、不删表、不清表；它对这个新库执行现有迁移和草案 SQL，然后运行本功能的测试。
- 专用命令只收集 `title-writing-store.acceptance.spec.ts` 一个文件；`pnpm test` 不收集它；通用 `integration` 中本功能的文件只读。

```bash
# 由有权限的人先新建空库（示例名），再运行：
TITLE_WRITING_DRAFT_SQL_AUTHORIZED=true TITLE_WRITING_ACCEPTANCE_DATABASE_NAME=ads_title_acceptance_20261009a TITLE_WRITING_ACCEPTANCE_DATABASE_URL=postgresql://<user>@<isolated-host>:5432/ads_title_acceptance_20261009a pnpm --filter @ai-drama/database title-writing:acceptance
```

不要先手工执行草案再跑通用 `integration`：通用集成测试的其他文件会重建 schema。

真实 API 验收用同样三个变量，但要另建一个空库，命令为 `pnpm --filter @ai-drama/api title-writing:acceptance`。它在空库上先验证「存储未就绪时拒绝」，然后才应用草案。真实浏览器验收同样用三个变量和另一个空库，先 `pnpm build`，再运行 `pnpm --filter @ai-drama/api title-writing:browser-acceptance`（API 监听 3001，即网页构建时编译进代理的默认上游；网页监听 3010）。工作流 `.github/workflows/title-writing-acceptance.yml` 为三条命令各起一个作业级 `postgres:16` 容器和一次性库，并上传脱敏证据（浏览器作业只有 JSON 与截图，不录 trace/HAR）。
