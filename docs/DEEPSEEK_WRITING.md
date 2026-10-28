# DeepSeek 重新接入（2026-10-17）

文本创作的活动供应商现为三家：DeepSeek（`deepseek`）、Claude（`anthropic`）、OpenAI（`openai`）。千问（`qwen`）仍为退役，历史只读。Claude 的内部 key 仍是 `anthropic`，不使用 Claude Code 登录凭据或订阅额度。其余说明（Claude、OpenAI、在线候选、调用授权）见 [`OPENAI_CLAUDE_WRITING.md`](OPENAI_CLAUDE_WRITING.md)。

## 官方依据（2026-10-17 核对）

- <https://api-docs.deepseek.com/>、<https://api-docs.deepseek.com/quick_start/first_api_call>：OpenAI 兼容格式，`POST https://api.deepseek.com/chat/completions`，`Authorization: Bearer <key>`。
- <https://api-docs.deepseek.com/quick_start/pricing/>：模型名 `deepseek-flash`（DeepSeek-V4.1-Flash）与 `deepseek-v4-pro`；两者都支持 JSON Output；上下文 1M，最大输出 384K。文档不再列出 `deepseek-chat`/`deepseek-reasoner`。
- <https://api-docs.deepseek.com/api/create-chat-completion/>：`thinking: {type: "enabled" | "disabled"}`（默认 enabled）；`response_format: {type: "json_object"}`；`max_tokens` 1–393216（非思考默认 8K）；`finish_reason` 为 `stop/length/content_filter/tool_calls/insufficient_system_resource/aborted`；`message.content` 与（仅思考模式）`reasoning_content`；usage 的 `prompt_tokens` = `prompt_cache_hit_tokens` + `prompt_cache_miss_tokens`，`completion_tokens` 已含 `completion_tokens_details.reasoning_tokens`。
- <https://api-docs.deepseek.com/guides/json_mode/>：提示中必须包含 “json”；可能偶尔返回空内容；`max_tokens` 过小会截断 JSON。
- <https://api-docs.deepseek.com/guides/thinking_mode>：思考开关与 `reasoning_effort`；思考模式下 `temperature` 等无效。
- <https://api-docs.deepseek.com/quick_start/error_codes>：400 格式错误、401 认证失败、402 余额不足、422 参数错误、429 限流、500 服务端错误、503 过载。

## 请求与解析（`packages/providers/src/text-writing.ts` 的 `deepseekWritingAdapter`）

- 固定端点 `https://api.deepseek.com/chat/completions`，配置的其他 URL（含 `/v1/...`、代理）一律不发送。认证只有 `Authorization: Bearer`，不发送 Claude 的 `x-api-key`/`anthropic-*` 头，也不借用其他供应商的密钥。
- 默认模型 `deepseek-flash`；只填 Key 即可（服务端补默认模型）。没有恢复旧的 `deepseek-chat`/`deepseek-reasoner` 白名单，也不猜模型名；历史任务的模型名原样显示。
- 请求体：`model`、`messages`（system + user）、`thinking: {type: "disabled"}`、`response_format: {type: "json_object"}`、`max_tokens` = 共用输出预算 4096、`stream: false`。不发送 OpenAI Responses 的 `instructions/input/text/store/max_output_tokens`，也不发送 Claude 的 `output_config` 等参数，不发送工具、`temperature`。
  - 关闭思考的理由：每一步是一次 120 秒内的结构化改写，思考只增加费用和耗时，且官方只在非思考说明中描述 JSON Output 的兼容性；关闭后不会产生 `reasoning_content`。
  - JSON Output 不接受 schema：适配器在冻结的系统提示**之后**追加一段“输出格式（json）”说明和该步骤的 JSON Schema。冻结的提示词文本、提示版本和业务 schema 都没有改动；返回内容仍经过与其他供应商相同的 zod 与领域校验——能解析的 JSON 不等于合格结果。
- 解析：恰好一个 choice；`finish_reason: "stop"` 且 `message.content` 为非空字符串才是回答。`length` → 截断；`content_filter` 或非空 `refusal` → 拒绝；`insufficient_system_resource`/`aborted` → 服务端错误（已回答但无可用内容）；`tool_calls`、未知 finish、空内容、非 JSON 体 → 无效输出。`reasoning_content` 永远不读取、不保存、不展示、不拼接。以上都不会保存为作品，也不会为修复格式追加付费调用。
- 用量：输入 = `prompt_tokens`（已含缓存命中/未命中，不重复相加）；输出 = `completion_tokens`（已含推理 token）；`total_tokens` 必须等于两者之和，缓存命中 + 未命中必须等于 `prompt_tokens`，否则记为未知。缺失时用量未知，费用始终 `unknown`，不写 0。请求 ID 取响应体 `id`（官方未说明请求 ID 头）。
- 错误：401 → `auth`；402 → `quota`（余额不足）；400/422 → `bad_request`；429 → `rate_limited`；500/503 及 3xx、超时、断线、超大响应 → 结果未知（可能已计费，不自动重发）。错误体与结果中的密钥会被脱敏，日志和响应不含密钥、认证头或用户正文。
- 单次发送、无自动重试、手动重定向不跟随、无跨供应商兜底：DeepSeek 失败不会改投 Claude 或 OpenAI。

## 密钥与配置

- 只在 `/admin/models` 的「DeepSeek 快速配置」填写官方 API Key（DeepSeek 开放平台创建）。不需要 URL、Workspace、操作者令牌或模型列表。
- 格式检查不要求任何前缀（官方未公布）：16–256 个可打印 ASCII 字符、无空格/换行/控制字符/非 ASCII。通过只表示“可以保存”，认证与余额以 DeepSeek 实际响应为准。
- **保存 DeepSeek Key 会把 DeepSeek 设为新创作的默认供应商**——快速配置和高级设置的供应商表单都是如此，两处都在保存前写明；在高级设置里清除 DeepSeek Key 会把“默认=DeepSeek”改为暂不指定。只影响新请求，不改变已有任务。OpenAI、Claude 的 Key、Claude Workspace、模型和限额保持不变。
- 供应商表单保存后若服务端默认供应商变了，“默认选择与使用限额”表单随之同步；如果管理员已在该表单里改过默认但未保存，则保留其选择并明确提示，不静默覆盖；其他未保存的限额保持不变。

### 默认供应商规则

- 管理员明确设置的默认供应商，即使因缺 Key、配置待生效或缺迁移而暂不可用，也仍是默认：options 照常返回它，页面显示它不可用的具体原因并阻止按默认发送，不会自动改用 Claude 或 OpenAI。用户在页面上明确选择其他已就绪的供应商后，才按该选择发送；API 请求省略 provider 时同样不替换（503，写明缺项）。
- 没有设置默认供应商时，才按 Claude → OpenAI → DeepSeek 推荐第一个已就绪的供应商；创作页显示“本次发送给：<供应商> · <模型>”，在线候选显示“使用 <供应商> · <模型>”。
- 已创建的请求按冻结的供应商和模型重放，不重新选择。
- options 增加 `configurationPending`：后台已保存、等待 API 重启生效时为 true，页面单独说明，不与“未配置”混淆。
- 与其他供应商一样：保存只改 saved，API 重启（空闲时）才进入 active；后台分别显示“已保存/已生效”，不把保存当成调用验证成功。启动时的空闲判定现在同时等待进行中的标题任务和进行中的在线候选。
- **不读取环境变量中的 `DEEPSEEK_*`**：服务器上可能残留退役前的 `DEEPSEEK_API_KEY`，它不会被读取或复活；DeepSeek 只能在后台配置。环境变量里的 `TITLE_WRITING_DEFAULT_PROVIDER=deepseek` 可以解析，但新建 vault 时因没有 DeepSeek Key 而不作为默认。
- 旧 v1（三家）配置中的 DeepSeek Key 不会被沿用或从 `.v1-retired-providers.bak` 恢复；需要重新填写。

### vault 兼容、备份与回滚

- 格式仍是 v2。`deepseek` 条目（以及 DeepSeek 默认供应商）**只在 DeepSeek 有 Key 时写入**；没有 DeepSeek 的文件与上一版本（`4d52afc`）读取的字段完全一致，读取不写盘。
- 第一次把 DeepSeek 写入“上一版本可读”的文件之前，先保存该文件的字节作为 `<配置文件>.v2-before-deepseek.bak`，再原子替换 live 文件：
  - 备份先写入独占创建的私有临时文件（600）并同步，再用 `link` 发布到最终文件名（不会覆盖已有文件），然后同步目录。任何一步失败都不会在最终文件名留下空或截断的文件，live 文件不变，下次保存会重新写备份。
  - 已有备份只在“完好”时保留并继续：普通文件、非符号链接、单一链接、属主为当前用户、权限 600、大小在 1–256 KiB、v2 信封可用主密钥解密并通过 GCM 校验、内容是上一版本可读的结构（不含 DeepSeek）。保留最早的完好备份，不要求与之后变化的 live 文件逐字节相同。
  - 备份为空、截断、权限不对、是符号链接、无法用主密钥解密或已含 DeepSeek 时，拒绝本次保存（503），不替换 live 文件，也不覆盖该备份；需由管理员人工检查。
- 清除 DeepSeek Key 会同时清空其模型，并把“默认供应商=DeepSeek”改为未指定，使文件回到上一版本可读的形状；DeepSeek 没有 Key 时不能设为默认（后台与服务端都会拒绝）。
- 回滚到上一版本前二选一：
  1. 在后台清除 DeepSeek Key 并保存，等空闲时重启 API 使 active 也不含 DeepSeek（推荐，保留其他修改）；或
  2. 停 API 后用 `.v2-before-deepseek.bak` 覆盖配置文件（会丢弃该备份之后在后台做的所有修改）。
  不这样做时旧 API 读取 vault 会失败并拒绝启动。

## 旧 DeepSeek 任务保护

- 新版本服务端为它创建的每个 DeepSeek 任务（标题与拆解）在冻结输入中写入适配器标识 `providerAdapter: "deepseek.chat-completions.v1"`（`DEEPSEEK_PROVIDER_ADAPTER`）。标识只由服务端写入，启动请求体是严格 schema，客户端不能携带或伪造它。**没有该标识的 DeepSeek 任务就是退役前的旧任务**，不以日期判断。
- 不回填、不修改历史冻结输入、哈希、模型、调用记录或费用。同 key 重放一个无标识的旧启动时，服务端按旧形状（不加标识）重建输入再比较，因此仍返回原任务，不会误判冲突或重复创建；拆解任务按请求哈希比较，不受标识影响。
- 引擎在预约之前把这类任务停为 `needs_attention / legacy_provider_run`：维护、领取、启动恢复都不会因为 DeepSeek 已配置（即使白名单包含其冻结模型）而续跑或发送。已提交的调用保持未知结果与未知费用；有效租约不接管；取消优先；全部步骤已完成的任务按原逻辑保存，不重复保存、不新增修订。
- 显式续跑：需要重新发送调用时，旧任务返回 409 `TITLE_WRITING_LEGACY_RUN`（附冻结的 provider 与 model），不改用 `deepseek-flash` 或其他供应商；只需保存已存答案的续跑照常完成（不发送、只保存一次）。新任务的冻结模型不在当前白名单时返回 409 `TITLE_WRITING_RUN_MODEL_UNAVAILABLE`，不替换模型。
- 带标识的新任务照常参与重启恢复（租约过期后由维护流程继续，只发往 DeepSeek）。
- 运行视图增加 `legacyProviderRun`，页面据此（而不是日期）说明“退役前创建的旧任务”。
- 同键重放（标题任务与候选）先按原身份回答，与供应商当前状态无关，不重复创建、不重复发送。
- 页面把旧任务说明为“DeepSeek 退役前创建的旧任务，不会再发出请求”，不显示为“配置不完整”。
- 旧在线候选不存在（候选表原 CHECK 不允许 deepseek）。

## 数据库

| 对象 | 是否支持 deepseek | 需要迁移 |
| --- | --- | --- |
| `title_writing_run` / `title_writing_call` 的 provider CHECK | 自 `20261008000100_title_writing` 起就包含 `deepseek`，`20261016000100_writing_provider_anthropic` 保留了它 | 否（`providerStorageReady("deepseek")` 仍读取两个实时 CHECK 确认） |
| `writing_candidate_request.provider_key` CHECK | 原为 `('openai','anthropic')` | **是：`20261017000100_writing_candidate_deepseek`** |
| `error_code` 等 | 自由文本 | 否 |

新迁移 `20261017000100_writing_candidate_deepseek`：

- 只扩展：`writing_candidate_request` 上必须恰好有一个提到 `provider_key` 的 CHECK，且其定义必须**完全等于**已发布的 `CHECK ((provider_key = ANY (ARRAY['openai'::text, 'anthropic'::text])))`；否则（复合 CHECK 同时限制其他字段、或还有其他引用 provider_key 的 CHECK）`RAISE` 整体回滚，什么都不删除，不会丢失其他限制。通过后替换为具名 `writing_candidate_request_provider_key_check CHECK (provider_key IN ('openai','anthropic','deepseek'))`。不写任何行，不碰其他表，不放宽为任意字符串（`qwen` 仍被拒绝）。
- 依赖：基础七迁移 + `20261016000200_writing_candidate`（在 `GUARDED_SINGLE_MIGRATIONS` 中声明）；缺少时受保护命令在执行任何语句前退出、零写入。与剧本拆解迁移、Claude 迁移无关，不会带上拆解迁移。
- 锁：`writing_candidate_request` ACCESS EXCLUSIVE 直到事务结束，新 CHECK 扫描该表一次；请在空闲窗口执行。没有 down 迁移；旧代码从不写 `deepseek`，回滚代码时保留此约束。
- 未执行时：DeepSeek 标题创作照常可用；DeepSeek 在线候选显示缺少 `WRITING_CANDIDATE_DEEPSEEK_MIGRATION`，请求在任何写入/预约/发送之前 503 `WRITING_CANDIDATE_PROVIDER_STORAGE_UNAVAILABLE`；后台 DeepSeek 状态显示需要执行的迁移名。
- 只执行这一个迁移（需单独授权；**不要**运行默认 `migrate`，它会带上拆解迁移）：

```bash
DATABASE_URL=<业务库连接串，只在进程环境中> \
  pnpm --filter @ai-drama/database migrate -- --only 20261017000100_writing_candidate_deepseek
```

  成功输出 `Applied 1 migration(s).` 与 `{"applied":["20261017000100_writing_candidate_deepseek"],"alreadyApplied":[],"leftPending":["20261012000100_script_breakdown"]}`（测试站组合）；再次执行 `Applied 0 migration(s).`。

只读核验：

```sql
SELECT name FROM schema_migration ORDER BY name;
SELECT pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid = 'writing_candidate_request'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%provider_key%';
-- 旧 DeepSeek 任务（只读；running 的旧任务在新版本启动后会被停为 legacy_provider_run，不会发送）：
SELECT id, state, model, created_at FROM title_writing_run WHERE provider_key = 'deepseek' ORDER BY created_at;
SELECT id, state FROM title_writing_call WHERE provider_key = 'deepseek' AND state IN ('reserved', 'submitted');
```

## 验证

- 适配器：端点、认证、模型、参数、只取 content、空内容/截断/拒绝/工具调用/错误 JSON、401/402/400/422/429/5xx/重定向/超时/断线/超大响应、无重试、用量口径、密钥脱敏（`packages/providers/src/text-writing.spec.ts`）。
- 引擎：新 DeepSeek 任务只发往 DeepSeek；失败不改投；冻结模型不可用不发送；旧任务在 DeepSeek 已配置（含其模型）时仍零预约零发送（`title-writing-retired-provider.spec.ts`、`apps/api/src/studio/writing-provider-retirement.spec.ts`）。
- 候选：DeepSeek 故事/分集候选、失败不改投、迁移未执行与无 Key 时零写入零发送（`writing-candidate.service.spec.ts`）。
- vault：上一版本可读形状、首次写入备份且只写一次、清除后回到可读形状、DeepSeek 默认需要 Key、v1 旧 Key 不复活（`model-config-vault.spec.ts`、`admin-models.service.spec.ts`、`admin-runtime.spec.ts`，Linux CI）。
- 迁移：单元测试（白名单、前置校验、零写入拒绝、回滚、幂等）与真实 PostgreSQL 一次性库验收（`writing-candidate.acceptance.spec.ts`，CI 中按发布顺序执行真实命令）。
- 真实浏览器（模型全部用桩）：按测试站迁移组合建库，DeepSeek 默认下完成标题创作、分集候选预览/差异/采纳/保存、结果未知不重发、Claude 与 OpenAI 候选，1280×800 与 390×844 无横向溢出（`writing-online.browser-acceptance.spec.ts`）；后台 DeepSeek 快速配置（`scripts/admin-models-browser-acceptance.mjs`）。
- 以上都没有调用真实 DeepSeek；CI 把 `api.deepseek.com` 解析到回环地址。模型桩通过不等于真实 DeepSeek 创作成功。
