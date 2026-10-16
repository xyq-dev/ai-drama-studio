# OpenAI 与 Claude 文本创作

2026-10-16 起，所有在线文本创作入口（标题一键创作、剧本拆解）、编剧流程和模型后台只提供两家供应商：

| 供应商 | 内部 key | 界面名称 | 官方端点（固定，服务端校验） | 认证 |
| --- | --- | --- | --- | --- |
| OpenAI | `openai` | OpenAI | `POST https://api.openai.com/v1/responses` | `Authorization: Bearer` |
| Claude | `anthropic` | Claude | `POST https://api.anthropic.com/v1/messages` | `x-api-key` + `anthropic-version: 2023-06-01` |

千问（`qwen`）与 DeepSeek（`deepseek`）已退役。媒体处理、Mock 媒体、FFmpeg 等非文本业务不受影响。

## Claude 的接入方式

- 只用网站自己的 Anthropic API Key（Anthropic 控制台创建），经服务端白名单 `TITLE_WRITING_ANTHROPIC_MODELS` 或模型后台配置。**不**使用 Claude Code CLI、个人订阅登录令牌、浏览器会话或本地会话；缺少 API Key 时显示“未配置”。
- 模型 ID 用官方 Claude API ID，不用 `opus` 之类的 CLI 别名。2026-10-16 核对 <https://platform.claude.com/docs/en/about-claude/models/overview>：`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`、`claude-fable-5-1`（均为固定快照）。开发本功能时 Claude Code 运行的模型是 `claude-opus-5-5`，它正好也是有效的 Claude API ID；两者只是同名，网站不通过 Claude Code 调用。
- 请求体（`packages/providers/src/text-writing.ts`，只在适配器边界做格式适配，提示词、集数规则和内容协议不变）：
  - `system` + 一条 `user` 消息；`max_tokens` = 共用输出预算 4096 + 思考余量 4096（思考计入 `max_tokens`）。
  - `thinking: {type: "adaptive", display: "omitted"}`：当前模型思考为自适应，Claude Opus 5.5 不能关闭思考；思考内容不返回、不保存。
  - `output_config: {effort: "low", format: {type: "json_schema", schema}}`：结构化输出不需要 beta 头。Claude 不接受 `minLength/maxLength/minimum/maximum/maxItems` 和大于 1 的 `minItems`，这些在发送副本中去掉；本地 zod 校验和领域校验仍是唯一权威，限制一条都没放宽。
  - 不发送预填、工具、`temperature/top_p/top_k`、流式。
- 解析：只接受 `stop_reason: "end_turn"` 且恰好一个 `text` 块（可前置 `thinking`/`redacted_thinking`，被跳过）。`refusal` → 拒绝；`max_tokens`/`model_context_window_exceeded`/`pause_turn` → 截断；`tool_use`、多个文本块、引用、空文本、非 JSON → 无效输出。思考文本、拒绝文本和不完整 JSON 永远不会被当成剧本。
- 用量：输入 = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`；输出 = `output_tokens`（已含思考，不重复加）；缺失或异常时用量为未知，不写 0。费用仍是 `unknown`。
- 错误：401 认证（`auth`）；403 权限（`permission`）；Workspace 缺失（400 `anthropic-workspace-id is required…`）→ `workspace_required`；Workspace 无效、不存在或无权访问（400 `…must be a valid workspace ID.` / 404 ``Workspace `<id>` not found.``）→ `workspace_invalid`；402 `billing_error` 或 400 `credit balance is too low` → 额度/余额；429 限流（含花费上限）；400/404/413/422 请求无效；500/504/529 及 3xx、超时、断线、超大响应 → 结果未知（可能已计费，不自动重发）。请求 ID 取 `request-id` 头或错误体 `request_id`。
- 安全边界与 OpenAI 相同：服务端固定并校验端点（配置的 URL 不等于官方端点时一律不发送）、密钥只在请求头、日志和错误响应不含密钥、响应 1 MiB 上限、120 秒超时、手动重定向不跟随、每次调用只发送一次、不自动重试/换模型/换供应商。未使用 SDK（因此没有 SDK 默认重试）。
- OpenAI 保持原有 Responses API 请求与解析不变。
- 请求总会带 `output_config.effort` 与自适应思考：白名单只应填写支持二者和结构化输出的当前模型（上面列出的四个）。填写不支持的旧模型（例如 Claude Haiku 4.5）时，每次调用会被 400 拒绝并记为 `bad_request`，不会循环重发。

## 只填写 Claude API Key（2026-10-16 第二轮）

- 后台 `/admin/models` 顶部「Claude 快速配置」只有一个输入框：Claude API Key。保存时服务端：
  - 只接受 Claude Console 创建的 API Key（规则见下文「Claude API Key 的格式与 Workspace」）；不适用的凭据与不支持的格式在保存前分别以 `ADMIN_CONFIG_KEY_KIND` / `ADMIN_CONFIG_KEY_FORMAT`（400）拒绝，不写入任何内容。服务端运行时用同一规则读取，也不会用这类凭据发送。
  - 没有模型列表时写入默认模型 `TITLE_WRITING_DEFAULT_MODELS.anthropic = ["claude-opus-5-5"]`（2026-10-16 核对官方模型页，支持结构化输出、effort、自适应思考）；环境变量方式只设 `ANTHROPIC_API_KEY` 也得到同一默认模型。OpenAI 仍需显式模型列表，不猜测。
  - 尚未保存默认供应商时，同一次写入把 Claude 设为默认；已选的默认不被替换。没有可用默认时按 `TITLE_WRITING_PROVIDER_PREFERENCE`（Claude 优先）选择。失败后从不换模型或供应商。
- 状态（`claudeSetupState`）逐项区分，从不显示 READY：尚未配置 Claude API Key → 已保存、等待 API 重启后生效 → 应用已推迟（有任务在跑）→ 配置项未齐全 → 功能开关未开启 → 没有调用授权 → 数据库迁移未执行（列出迁移名）→ 可以创作（并注明不代表真实调用验证）。配置生效机制不变：保存只写 vault，API 重启时（空闲才）应用；重启由部署流程（Hermes）负责，网页不提供重启或执行命令的能力。
- 模型、端点等仍在下方「高级设置」中，可不操作。在高级设置里保留密钥、清空模型列表即可让 Claude 不就绪；只有填写新密钥时才自动补默认模型。
- 发布注意：只用环境变量配置、没有 `TITLE_WRITING_DEFAULT_PROVIDER` 时，若环境里有 `ANTHROPIC_API_KEY`，升级后 Claude（默认模型）就绪并成为默认，新任务不再默认用 OpenAI。环境变量与后台输入使用同一个密钥规则（2026-10-17 起）。

## Claude API Key 的格式与 Workspace（2026-10-17）

依据：[Authentication](https://platform.claude.com/docs/en/manage-claude/authentication)（2026-10-17 核对）与官方 TypeScript SDK 0.135.0。官方文档把 API Key 分为个人密钥、服务账号密钥和（旧）Workspace 密钥，三者都可调用 Messages API；文档示例只写出 `sk-ant-api…` 形式，SDK 不检查前缀，统一以 `x-api-key` 发送。此前本项目把 `sk-ant-api` 当成唯一格式，导致 Console 新建的个人密钥（`sk-ant-usr-…`）被误拒。

- 接受（`anthropicKeyProblem` 返回 null，前端、后台 API、环境变量、vault 读取后的运行时配置共用同一函数）：`sk-ant-api…`（旧格式，含 `sk-ant-api03-`）、`sk-ant-usr…`（个人密钥，用户在 Console 创建的真实密钥即此前缀）、`sk-ant-svc…`（服务账号密钥；前缀依据是修复同一误判的第三方工具，官方文档未列出前缀）。形状为 `sk-ant-(api|usr|svc)[数字]-` 后接至少 8 个 `[A-Za-z0-9_-]`，总长不超过 256。密钥原样保存和发送，不修剪、不改写中间内容。
- 拒绝为「不适用的凭据类型」（`not_api_credential` → `ADMIN_CONFIG_KEY_KIND`）：订阅 / Claude Code OAuth 与 setup-token（`sk-ant-oat…`）、OAuth 刷新令牌（`sk-ant-ort…`）、Admin API 专用密钥（`sk-ant-admin…`）、浏览器会话（`sk-ant-sid…`）、JWT（`eyJ….….…`）。
- 拒绝为「格式不支持」（`unsupported_format` → `ADMIN_CONFIG_KEY_FORMAT`）：其他厂商密钥、未知的 `sk-ant-` 种类、空白 / 换行 / 控制字符 / 非 ASCII、过短或超过 256 字符。不会放行任意 `sk-ant-*` 或任意非空字符串。
- 格式通过只表示「允许作为 API Key 保存」，不代表密钥有效、余额充足或有模型权限；这些只有服务商能回答，调用时分别记为 `auth`（401）、`permission`（403）、`quota`、`workspace_required` / `workspace_invalid`。
- 请求认证不变：`x-api-key`（官方仍支持）+ `anthropic-version`；不发送 `Authorization: Bearer`、OAuth beta 头、Claude Code user-agent 或 `x-app`；不读取或复用开发工具的订阅会话。端点固定、不重试、不跟随重定向、不换供应商。
- Workspace：限定了 Workspace 的密钥可省略；未限定 Workspace 的个人 / 服务账号密钥必须在每个请求携带 `anthropic-workspace-id`。
  - 快速配置默认只填 Key；「高级设置（可不填）：Workspace ID」可填写 Console 工作区页面 ID 列的 `wrkspc_…`（`^wrkspc_[A-Za-z0-9_-]{4,100}$`，非法值以 `ADMIN_CONFIG_WORKSPACE_FORMAT` 拒绝）。页面说明：「通常只需填写 API Key。若密钥未限定 Workspace，请在高级设置填写 Workspace ID，或创建限定 Workspace 的密钥。」
  - 不从密钥猜 Workspace，不自动选择任何 Workspace，不调用 Admin API。未配置时不发送该头；配置后标题创作与工作台在线候选的每个 Claude 请求都携带。OpenAI 从不发送。
  - 保存语义（`workspaceAction`）：省略 = 保留，但填写新 Key 或清除 Key 时一并清除（新 Key 不继承旧 Key 的 Workspace）；`replace` + `workspaceId` = 设置；`clear` = 清除；新 Key 配 `keep` 被拒绝。只改 Workspace 时保留已保存的 Key。与 Key 一样保存后需重启 API 生效（saved / active 分别显示）。
  - vault：`workspaceId` 是 Claude 条目的可选字段，只在有值时写入；旧 vault 没有该字段照常读取，不删除、不重建、不更换主密钥。回滚到本版本之前：若设置过 Workspace，先在后台清除它再回滚，否则旧版本读取 vault 会失败。
  - 环境变量：`ANTHROPIC_WORKSPACE_ID`（与官方 SDK 同名，只从进程环境读取）。环境变量直配时格式错误 → Claude 不就绪（缺 `ANTHROPIC_WORKSPACE_ID`），不会静默丢弃；首次初始化 vault 时若该值格式错误，Claude 密钥也不写入（后台显示尚未配置，由管理员在后台填写），避免「看似就绪、每次调用都失败」；vault 已存在后环境变量不再生效。
  - 服务商答复「缺少 Workspace」「Workspace 无效 / 不存在 / 无权访问」时，页面分别提示，不再统一报为密钥格式或余额问题。不需要数据库迁移（`error_code` 是文本列）。

## 调用授权：管理员登录即操作者

- 站点登录开启（`SITE_AUTH_ENABLED=true`）时，站点只有一个账号——同时掌管模型后台的管理员。带有效会话、精确站点 Origin 和会话 CSRF 令牌的写请求（由站点登录自己的 `authorizeWrite` 在控制器里再次校验）就是付费调用的操作者；页面不再显示操作者令牌输入框，也不发送 `X-Operator-Token`。服务端的 `TITLE_WRITING_OPERATOR_TOKEN` 不会下发给浏览器。
- 站点登录未开启（本地开发、隔离验收）时仍需操作者令牌（定长比较）。没有取消付费调用鉴权，也没有把匿名访问升级为操作者；按钮禁用不是鉴权。
- 适用于标题创作、剧本拆解（仍关闭）和工作台在线候选（`apps/api/src/studio/operator-access.ts`）。

## 工作台在线候选（故事 / 单集）

- 编剧助手新增「在线生成候选」：故事（三集作品）与第 1–3 集剧本。手工复制指令、粘贴/导入 JSON、比较、采纳的流程保留。
- 流程：读取可用供应商与默认模型 → 用户填写要求后点击生成（按钮锁定、双击只发一次）→ 服务端校验并冻结输入、供应商、模型、目标实体（作品/集）和基础版本（来源版本 + If-Match），写入 `reserved` → 后台发送一次 → 结果用与手工导入相同的 `parseWritingImport`/`formatWritingImport` 校验 → 页面轮询，显示候选和差异 → 用户点击「采纳到草稿」→ 用原有「保存新版本」保存。不自动生成、采纳、覆盖或加版本。
- 接口：`GET /api/v1/writing/candidates/options`、`POST /api/v1/projects/:projectId/writing/candidates`（需 `Idempotency-Key`）、`GET /api/v1/projects/:projectId/writing/candidates?mode=story|episode[&episodeId=]`（该对象最近 10 条）、`GET /api/v1/projects/:projectId/writing/candidates/:requestId`。响应不含幂等键、操作者、执行者、密钥；费用恒为 unknown。
- 规则：同键同内容返回原请求、不重发；同键不同内容 409 `IDEMPOTENCY_KEY_REUSED`；同一对象同时只允许一个进行中的请求（409 `WRITING_CANDIDATE_ACTIVE`）；最近一次结果未知时，新请求必须带上该请求 id 的确认（409 `WRITING_CANDIDATE_NEEDS_CONFIRMATION`）；目标集/基础版本不属于该作品时 409 `WRITING_CANDIDATE_TARGET_INVALID`；每日调用次数与标题创作共用一个滚动 24 小时上限（同一 advisory lock）；与标题创作的调用记录一样，按记录条数计，没有发出就被关闭的请求也计入（保守）。超时、断线、5xx、重定向记为 unknown，不自动重发；租约过期：未发送 → rejected（executor_lost_before_send），可能已发送 → unknown（executor_lost）。
- 页面：请求在发送前写入本标签页 sessionStorage；刷新或回执丢失后只读取原请求或用同一键重放；切换作品/集或迟到的回答不会写到其他对象；输入或编辑基线变化后候选仍可查看，但 `canAdopt` 拒绝覆盖新草稿。历史记录可只读查看已生成的候选。
- 旧工作区千问：其服务端表只存在于未执行的草案（`prisma/drafts/20261005000100_qwen_web_writing.sql`），任何数据库都没有服务端历史；本标签页的旧请求记录仍只读说明，不发送、不查询、不删除。

## 退役与历史

- 新建任务、续跑重新发送、后台更新、默认供应商、可执行 registry（`WRITING_ADAPTERS`、`titleWritingProviderConfigs`）只有 `openai`、`anthropic`。不会把旧供应商的请求改投 OpenAI 或 Claude。
- 删除：千问/DeepSeek 适配器，`qwen-chat`、`qwen-text-trial`、`qwen-writing`、`qwen-web-writing` 模块，`qwen:trial`/`qwen:writing` 命令，工作区千问网页路由（`/writing/qwen-candidates`）、其服务、存储和网页客户端，以及对应环境变量的读取。通用 HTTP、限长读取、UTF-8 解码和密钥脱敏移到中立的 `packages/providers/src/http-transport.ts`。
- 历史可读：`TITLE_WRITING_STORED_PROVIDER_KEYS` 仍包含 `qwen`、`deepseek`。历史任务、冻结输入、输入哈希、模型、调用身份、请求 ID、token、费用未知状态、审计都原样保留并按真实供应商显示（“千问（已退役）”“DeepSeek（已退役）”）。没有改标、清空或补零。
- 旧的未确认请求：
  - 页面保存的 pendingStart（含 `providerKey: "qwen"`）仍能解析，不会被当成损坏丢弃。重试时服务端先按原请求标识查找已有任务：找到就原样返回（200，不新建、不发送）；没找到才以 `TITLE_WRITING_PROVIDER_RETIRED`（409）拒绝，此时没有创建任何任务，也没有发出调用，页面说明并保留请求标识，由人决定放弃。
  - pendingResume：已受理的续跑按回执重放；新的续跑如果需要重新发送调用，旧供应商永远不就绪，store 在同一事务里拒绝（不重置步骤、不预约、不发送），返回 `TITLE_WRITING_PROVIDER_RETIRED`。只需保存已存答案的续跑不需要供应商，照常保存。
  - 工作区千问的本页请求记录（sessionStorage）只读显示“已退役，不会再发送、重放或查询；结果未确认时费用可能已经产生”，不删除。
- 旧任务收敛（引擎、维护、领取）：旧供应商任务没有配置也没有适配器，在预约前停为 `needs_attention / provider_unconfigured`，因此不会一直 running 占用唯一索引和活跃名额（没有通过从统计中排除来绕过）。有效租约不抢占；未发送的预约按原规则关闭；已提交的调用保留未知结果和费用；取消优先；全部步骤已完成的任务按原有保存逻辑完成，不发新调用、不重复保存、不增加版本。

## 数据库迁移 `20261016000100_writing_provider_anthropic`

`title_writing_run`、`title_writing_call` 的 `provider_key` CHECK 只允许 `qwen/openai/deepseek`。这次迁移只做扩展：按定义找到这两个 CHECK（每表必须恰好一个，否则整体失败回滚），换成 `('qwen','openai','deepseek','anthropic')`。旧值保留，不放宽为任意字符串，不改数据；应用层仍只允许两家新建。它只依赖基础七迁移，不依赖、不应用、不开启剧本拆解（`20261012000100_script_breakdown` 也不碰这两个 CHECK，两者顺序无关）。没有 down 迁移。

未应用时：`providerStorageReady("anthropic")` 为假（要求迁移账本有记录且两个 CHECK 都含 `anthropic`），Claude 在后台/创作页显示缺少 `WRITING_PROVIDER_MIGRATION`，启动请求在任何写入、预约、发送之前以 `TITLE_WRITING_PROVIDER_STORAGE_UNAVAILABLE`（503）拒绝。不会把 Claude 冒充成 openai。

### 只执行这一个迁移

默认 `migrate` 会应用全部未执行迁移（包括尚未上线的拆解迁移），**发布时不要用它**。使用受保护的单迁移命令（同一事务、advisory lock、checksum、迁移账本）：

```bash
DATABASE_URL=<业务库连接串，只在进程环境中> \
  pnpm --filter @ai-drama/database migrate -- --only 20261016000100_writing_provider_anthropic
```

它会先检查：账本存在；七个基础迁移全部有记录；所有已记录迁移的 checksum 与文件一致；目标未记录或已用相同 checksum 记录。任一不满足就在执行任何语句前退出（非 0）。成功输出 `Applied 1 migration(s).` 和 `{"applied":[...],"alreadyApplied":[],"leftPending":["20261012000100_script_breakdown"]}`（只输出迁移名）。再次执行输出 `Applied 0 migration(s).`，什么也不做。`--only` 只接受白名单中的这一个迁移。

执行前后只读核验（不含密钥）：

```sql
SELECT name FROM schema_migration ORDER BY name;
SELECT conrelid::regclass, pg_get_constraintdef(oid) FROM pg_constraint
 WHERE conrelid IN ('title_writing_run'::regclass, 'title_writing_call'::regclass) AND contype = 'c'
   AND pg_get_constraintdef(oid) LIKE '%provider_key%';
-- 发布前核对旧供应商仍在运行或调用未结束的任务（应为 0 行；有则先等待或按维护规则收敛，不手工修库）：
SELECT r.id, r.provider_key, r.state, r.lease_until FROM title_writing_run r
 WHERE r.provider_key IN ('qwen', 'deepseek') AND r.state = 'running';
SELECT c.id, c.provider_key, c.state FROM title_writing_call c
 WHERE c.provider_key IN ('qwen', 'deepseek') AND c.state IN ('reserved', 'submitted');
```

锁：两表 ACCESS EXCLUSIVE，持续到该迁移事务结束，新 CHECK 各扫描一次表，请在空闲窗口执行。业务库/测试站执行仍需单独授权。

## 数据库迁移 `20261016000200_writing_candidate`

只新建 `writing_candidate_request` 表及其索引（含「每个对象最多一个进行中请求」的唯一部分索引），不改任何已有表、约束或数据。只依赖基础七迁移，与剧本拆解、供应商迁移互不依赖。锁：建表的两个外键对 `project`、`episode` 取 SHARE ROW EXCLUSIVE 直到事务结束（阻塞写、不阻塞读），不扫描数据。没有 down 迁移；旧代码忽略此表。未执行时：在线候选显示未就绪，请求在任何写入/发送前 503 `WRITING_CANDIDATE_STORAGE_UNAVAILABLE`；标题创作和手工导入不受影响。

只执行这一个迁移：

```bash
DATABASE_URL=<业务库连接串，只在进程环境中> \
  pnpm --filter @ai-drama/database migrate -- --only 20261016000200_writing_candidate
```

两个受保护迁移各自单独执行（推荐顺序：先供应商迁移，再候选迁移），都不会带上 `20261012000100_script_breakdown`。验证：`writing-candidate.acceptance.spec.ts`（七迁移库 / 已有拆解库、失败回滚、幂等、后续默认迁移）与 CI 中按发布顺序执行两个真实命令的步骤。

## 模型后台配置（vault）升级与回滚

- 新格式 v2（`ai-drama-studio.admin-model-vault.v2`）只含 `openai`、`anthropic`。读取旧 v1（三家）文件时用同一主密钥、各自的 AAD 解密并在内存中转换：OpenAI 的密钥、模型顺序、端点保留；Claude 未配置；千问/DeepSeek 设置不再生效；若原默认是千问/DeepSeek，默认改为“未指定”（不静默切换）；saved/active 版本号不变，待重启状态不变；审计历史原样保留并追加 `format_upgraded`。
- 只读、启动不会写盘。第一次写入（保存配置，或启动时空闲应用待生效配置）前，先把原 v1 文件按字节复制到 `<配置文件>.v1-retired-providers.bak`（600、独占创建、绝不覆盖；已存在且内容不同则拒绝写入并保持原文件），然后原子替换为 v2。替换失败时原 v1 文件不变，重试复用同一备份。不会删除 vault、重新初始化、回退到旧环境密钥或撤销远端密钥。
- 后台只显示“是否已配置”和模型名，并提示“千问与 DeepSeek 已退役 / 原默认已取消 / 原配置已备份”，不显示密钥、前缀或密文。

## 发布顺序与回滚

1. 用已审查、主线 CI 通过的完整 SHA 构建；保留现有代码目录、`models.enc`、`.initialized`、主密钥和环境文件的回滚点。
2. 只读核对上面的旧供应商 running/reserved/submitted 任务。
3. 迁移（需授权）：用上面的两个 `--only` 命令（供应商迁移、候选迁移）。未授权时可以先发布代码：Claude 标题创作与在线候选显示未就绪并拒绝，OpenAI 标题创作不受影响。
4. 先停旧 API，再启新 API（不要两个 API 同时运行），再切换 Web。`NODE_ENV` 保持 `development`，标题创作开关不变，`SCRIPT_BREAKDOWN_ENABLED` 保持关闭。Worker 和媒体服务不需要因此切换。
5. 管理员在后台「Claude 快速配置」只填 API Key（模型等由系统提供），保存后由部署流程受控重启 API 生效；重启后后台状态应从「等待 API 重启」变为「可以创作」或指出缺少的迁移/开关。

回滚兼容性（不能笼统“一键回滚”）：

- 代码回滚前，如果 vault 已写成 v2，旧 API 读不了 v2（会拒绝启动）：先停 API，再用 `.v1-retired-providers.bak` 覆盖配置文件（会丢弃升级后在后台做的修改），再启动旧版本。
- 迁移不回滚。旧代码可以读取含 `anthropic` 的行；对这类任务，旧引擎会在 `this.deps.providers["anthropic"]` 上读到空值而出错（不会发送，但每次维护都重复出错并让任务保持 running），因此回滚前应确认没有 running 的 Claude 任务，或回滚后保持 `TITLE_WRITING_ENABLED=false`，以前向修复处理。禁止删除新任务或降级数据库来制造兼容。
- 旧代码不接受 `TITLE_WRITING_DEFAULT_PROVIDER=anthropic`（启动时环境校验失败），也不读取 `ANTHROPIC_*`：回滚代码时同时把该变量恢复为旧值或删除。
- 旧代码仍能发起千问调用；如果回滚，确认是否继续允许，必要时在旧版本关闭标题创作开关。

## 验证

- 适配器：两家的真实协议形状、认证头、结构化结果、拒绝、截断、余额不足、限流、超时、断线、异常/超大响应、usage 缺失、重定向、端点固定、密钥脱敏（`packages/providers/src/text-writing.spec.ts`）。
- 退役：引擎在各状态下零预约零发送（`title-writing-retired-provider.spec.ts`）；服务层新建拒绝、回执重放、续跑不重发、历史可读、Claude 迁移门槛（`apps/api/src/studio/writing-provider-retirement.spec.ts`）；网页 pending 保留与提示、无旧入口。
- 迁移：单元测试覆盖仅应用目标、幂等、前置条件、checksum、回滚、未来默认迁移（`packages/database/src/migrations-only.spec.ts`）；真实 PostgreSQL 隔离验收覆盖七迁移库和已有拆解迁移库（`writing-provider-migration.acceptance.spec.ts`，CI 一次性库）以及真实命令。
- vault：v1 读取、首次写入备份、回滚还原、空闲激活、失败恢复、拒绝覆盖不同备份（`model-config-vault.spec.ts`，Linux CI）；真实 StudioRuntime 读取 v1 vault 只提供两家（`admin-runtime.spec.ts`）。
- 所有自动验收都使用桩，CI 把 `api.anthropic.com` 等供应商主机解析到回环地址，阻断真实外呼。
