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

迁移草案 `packages/database/prisma/drafts/20261008000100_title_writing.sql`（**未执行**），三张新表，不改任何旧表：

- `title_writing_run`：一次创作。工作区、项目、操作者、幂等键、输入哈希、冻结输入（剧名与设置）、Provider、模型、状态、取消请求时间、执行者与租约、单次调用上限、已用调用数、故事保存结果、错误码。
- `title_writing_step`：`concept`、`outline`、`episode:1..3` 五步。状态、当前尝试号、校验后的结构化输出、输出哈希、剧本落入的版本 ID 与状态。
- `title_writing_call`：每次真实发送一行。请求哈希、Provider、模型、状态、服务商请求 ID、响应模型、usage、`billing_status`（固定 `unknown`，金额列不存在）、错误码。

兼容：只新增表；旧数据不受影响。回滚：在没有依赖前可 `DROP TABLE`；已有数据时保留表、关闭开关（forward-fix）。草案未执行时 `storageReady()` 为假，接口在任何发送前返回 503 `TITLE_WRITING_STORAGE_UNAVAILABLE`。

### 状态

运行（run）：`running` → `completed` / `partial` / `needs_attention` / `canceled` / `failed`。

- `completed`：五步全部通过 schema 校验并持久化，故事已保存为 DRAFT 版本。
- `partial`：已有部分步骤完成，后续步骤被拒（格式错误、鉴权、限额等）；已完成结果保留，可续跑。
- `needs_attention`：存在结果未知的调用（超时、断连、5xx、执行者丢失），或故事保存冲突。不自动重发。
- `failed`：没有任何完成步骤且最后一步被拒。
- `canceled`：用户取消；已发出的调用如实记录结果，之后不再启动新步骤。

步骤（step）：`pending` → `reserved` → `submitted` → `completed` / `rejected` / `unknown`；`canceled` 表示取消后未启动。

调用（call）：`reserved`（已占位、未发送）→ `submitted`（发送前持久化）→ `completed` / `rejected` / `unknown`。

### 规则

1. 浏览器只负责启动、查询、展示。服务端在 API 进程里按租约执行；每步之间检查取消；重启后维护循环接管租约过期的运行：`reserved` 未发送 → 可安全重来；`submitted` → `unknown`，运行转 `needs_attention`，不自动重发。
2. 已完成步骤绝不再调用。续跑只处理 `rejected`（需要用户点击）与 `unknown`（需要用户勾选「可能重复计费」确认）。同一 Provider、同一模型，不自动换供应商。
3. 幂等：`Idempotency-Key` + 输入哈希。同键同输入返回原运行；同键不同输入 409 `IDEMPOTENCY_KEY_REUSED`；同一项目已有进行中的运行 409 `TITLE_WRITING_RUN_ACTIVE`（返回该运行 ID）。
4. 限额（服务端、原子）：工作区每 24 小时调用数、同时进行中的运行数、每次运行调用上限（五步 + 续跑余量）。金额预算未实现：没有可靠单价来源，不声称硬预算。
5. 每步输出必须通过统一 schema 与安全检查；拒绝空结果、缺集、错集号、无法解析的内容。只收到响应不算完成。
6. 后续步骤只读取已保存的前序输出：大纲读取故事策划；第 N 集读取策划、大纲和第 1..N-1 集的交接事实。
7. 保存：故事只在项目还没有当前故事版本时创建 DRAFT 版本（同一事务记录到运行上）；已有人工故事 → `conflict`，生成结果保留在运行中。分集剧本保存在运行中，故事通过人工审核后由「写入剧本草稿」写入还没有剧本的分集；已有剧本的集记为冲突，不覆盖。从不改审核状态。
8. 密钥只从 API 进程环境读取，不进浏览器、日志或响应。端点由服务端固定；用户只能在服务端白名单中选 Provider 和模型。

### API（均在项目范围内，响应 `Cache-Control: private, no-store`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/v1/writing/title-runs/options` | 可用 Provider、模型、默认值、缺失配置项名称、限额。不含密钥。 |
| POST | `/api/v1/projects/:projectId/title-runs` | 启动。体 `{ title, providerKey?, model?, settings? }`，需 `Idempotency-Key` 与 `X-Operator-Token`。 |
| GET | `/api/v1/projects/:projectId/title-runs/latest` | 最近一次运行（刷新后恢复）。 |
| GET | `/api/v1/projects/:projectId/title-runs/:runId` | 运行状态、各步结果、调用记录（无密钥、无原始响应）。 |
| POST | `/api/v1/projects/:projectId/title-runs/:runId/cancel` | 请求取消。 |
| POST | `/api/v1/projects/:projectId/title-runs/:runId/resume` | 续跑，体 `{ confirmUncertain?: boolean }`，需 `X-Operator-Token`。 |
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

## 验收状态（2026-10-08，分支 feat/title-driven-ai-writing，基线 origin/main eeb359d）

| 项 | 状态 |
| --- | --- |
| 三家适配器请求映射、输出解析、错误分类 | 单元测试（`packages/providers/src/text-writing.spec.ts`），可控 transport 替身 |
| 顺序、上下文、幂等、并发、取消、恢复、限额、冲突、剧本落入 | 引擎测试（`title-writing-engine.spec.ts`），内存存储 + 可控替身 |
| 访问门禁、缺配置提示、密钥不外泄、续跑确认 | API 服务测试（`apps/api/src/studio/title-writing.service.spec.ts`） |
| 开始页、进度页、刷新恢复、结果展示 | 组件测试（`apps/web/src/components/title-writing.spec.tsx`，模拟 fetch） |
| 桌面 1280 与手机 390 布局 | 真实 Chromium + 已构建网页 + **桩 API**（只验证布局与交互，不是项目 API）：六个阶段按服务端状态显示，无横向溢出，刷新后恢复 |
| PostgreSQL 存储 | `title-writing-store.integration.spec.ts` 已写好，需授权隔离库且 `TITLE_WRITING_DRAFT_SQL_AUTHORIZED=true`；**未执行**（本机无 PostgreSQL，草案未授权） |
| 真实项目 API + 真实浏览器全流程 | **未执行**：依赖草案表 |
| 真实模型调用（千问 / OpenAI / DeepSeek） | **未执行**，Paid calls = NO |

补验命令（授权后、隔离库）：

```bash
psql "$DATABASE_URL" -f packages/database/prisma/drafts/20261008000100_title_writing.sql   # 仅隔离库
TITLE_WRITING_DRAFT_SQL_AUTHORIZED=true pnpm --filter @ai-drama/database integration
```
