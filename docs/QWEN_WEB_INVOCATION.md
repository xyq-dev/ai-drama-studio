# 千问网页调用

本机 `qwen:writing` 仍可生成 `candidate.json`，由创作者粘贴到编剧助手。

## 实现状态（feat/v1-remaining-delivery）

网页调用的应用路径已经接通，但**请求表来自未执行的 SQL 草案**，所以在任何现有数据库上服务端都会在发送前拒绝：

- 存储：`packages/database/src/qwen-web-store.ts` 的 `PostgresQwenWebStore`。`storageReady()` 只在草案表及全部列存在时为真；没有内存兜底。`reserve` 用按工作区的事务级 advisory lock 让键查重、请求数上限、并发上限和插入成为一个原子操作。
- 执行者租约：每次发送有 `executor_id` 和 `lease_until`（客户端最长发送时间 60 秒的两倍）。只有持有者能把 `reserved` 改为 `submitted`、把 `submitted` 结束。恢复只处理租约已过期的记录：从未发送的 `reserved` 记为 `rejected`（`executor_lost_before_send`），已发送的 `submitted` 记为 `unknown`（`executor_lost`）。活动租约永远不会被重放或恢复改写；迟到的原执行者被条件更新挡住。
- 草案 `prisma/drafts/20261005000100_qwen_web_writing.sql` 为此补充了 `executor_id`、`lease_until` 和三个索引，仍未执行。
- API：`GET /api/v1/writing/qwen-candidates/status`、`POST /api/v1/projects/:projectId/writing/qwen-candidates`（请求体 `{ input }`，`input` 为 `qwen.writing.input.v1`，需 `Idempotency-Key`）、`GET /api/v1/projects/:projectId/writing/qwen-candidates/:requestId`。都需要 `X-Operator-Token`，响应 `Cache-Control: private, no-store`。原占位 `POST /api/v1/writing/qwen-candidates` 已移除。
- 判定顺序：生产或开关关闭 → 404 `QWEN_WEB_DISABLED`；令牌不符（定长比较）→ 403；服务端密钥、官方端点或模型无效 → 503 `QWEN_WEB_PROVIDER_UNCONFIGURED`；存储未就绪 → 503 `QWEN_WEB_STORAGE_UNAVAILABLE`。这些都在预约和发送之前。前三项不访问数据库：未授权请求不会触发结构探测，也无法得知草案表是否存在。
- 输入字节上限：计量对象是 `input` 的紧凑 JSON 序列化（`JSON.stringify`）的 UTF-8 字节数，上限 256,000（`qwenWritingInputByteLength`，CLI 读取的输入文件与浏览器发送的 `input` 是同一序列化）。网页在准备指令后即提示并禁用发送，且不为超限输入生成请求标识；服务端在维护、预约和发送之前独立返回 413 `QWEN_WEB_INPUT_TOO_LARGE`，不写记录。
- 密钥：`DASHSCOPE_API_KEY`、`BAILIAN_BASE_URL`、`QWEN_WEB_MODEL` 只从 API 进程环境读取，不读 `.env` 文件，不进响应、日志或浏览器。
- 响应只给 `requestId`、状态、错误码、候选正文（未过期时）、过期时间、`billingStatus: "unknown"`；不返回执行者、幂等键、冻结输入或密钥。
- API 每 60 秒（及每次请求/查询前）执行一次租约恢复和候选过期清理。过期只清空 `candidate_json`，幂等与审计行保留。
- 网页：工作台的编剧助手显示「工作区千问」。操作者令牌只在页面内存；先「检查工作区调用」，服务端报告就绪才启用按钮。请求体是与冻结指令指纹一致的输入，输入变化后拒绝发送。同一冻结输入复用幂等键，断线后重试会读取原结果；处理中只提供「查询请求状态」；结果未知或被拒后，只有勾选确认才用新键发起新调用。切换项目、卸载或输入变化后的迟到响应被丢弃。候选仍进入原有预览、比较、采纳到草稿和「保存新版本」，If-Match 与 409 不变。
- API JSON 上限调到 300kb，以容纳 256,000 字节的合法输入。

验收状态：协议、服务、浏览器客户端与组件逻辑有单元和组件测试；真实 API 在既有 migration 的隔离库上验证了缺表时 503 且没有发送。草案表上的存储集成测试 `qwen-web-store.integration.spec.ts` 已写好，只在设置 `QWEN_WEB_DRAFT_SQL_AUTHORIZED=true` 的授权隔离库上运行，目前未执行。真实千问调用未执行，Paid calls=NO。

规则实现和假凭据测试在 `packages/providers/src/qwen-web-writing.ts`。它不是 `REPLAY_SAFE_SYNC`，也不替换 `MockTextAdapter`。

## 仍然不能做成开放按钮

按钮把候选放进预览，不调用采纳，也不保存。服务端未报告就绪时按钮保持禁用。

1. V1 仍是单工作区、单操作者。没有登录。占位路由校验操作者令牌；生产强制关闭，开发默认关闭。草案未执行时，路由在发请求前停止。
2. [`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) 规定，只有 `REPLAY_SAFE_SYNC` 能进入现有文本 Job。千问的 `providerResult=unknown` 不能标成可重放，也不替换 `MockTextAdapter`。
3. 官方 chat completions 仍按「不支持凭请求 ID 恢复结果」处理。`unknown` 不自动再 POST。

## 审查通过后的请求身份

建议的持久化记录先叫写作模型请求。它不是故事或剧本修订。

字段至少包括：工作区、操作者幂等键、模式（故事或分集）、分集号、已校验输入的 SHA-256、请求模型、状态、服务商请求 ID、候选是否通过网页同一套解析、费用状态。费用金额保持空，状态保持未知。不保存 API Key、Authorization 或原始错误正文。

状态只有：`reserved`、`submitted`、`completed`、`rejected`、`unknown`。

规则：

1. 存储必须原子检查工作区配额、并发占位及幂等键，再写入 `reserved`。同一键再次出现时返回原记录，不再调用模型；活动请求不能因重放转为 `unknown` 或释放并发占位。数据库事务实现见上方 `PostgresQwenWebStore`，草案表执行前不可用。
2. 网络请求之前先持久化 `submitted`。一次操作最多一个请求。进程内测试不等于数据库崩溃恢复验收；数据库恢复测试待草案授权后执行。
3. 只有 `finish_reason=stop`，并且 `parseWritingImport` 与 `formatWritingImport` 都通过，才记为 `completed`。候选可以被人导入，不会自动写成已保存版本。
4. 认证失败、拒绝、工具调用、非 stop、校验失败记为 `rejected`。不自动第二次请求。
5. 超时、断连、重定向、响应超限，以及请求发出后的 5xx，记为 `unknown`。文案说明可能已经产生费用。不自动重试，不自动换模型。新的调用必须使用新的幂等键，并要操作者明确确认。
6. 采纳候选仍走现有草稿和「保存新版本」。If-Match、409 和审核状态机不变。

## 已确认的决定

1. V1 仍是单工作区、单操作者。入口默认关闭，生产强制关闭。服务端校验操作者令牌，并限制请求数量、并发和 `max_completion_tokens=4096`。没有匿名代理，也没有会员或支付。
2. 在核实服务商查询能力之前，不支持凭请求 ID 恢复结果。`unknown` 不自动重投。相同幂等键配不同输入会被拒绝。
3. 网络发送前先写入 `reserved`，再写成 `submitted`。普通重放只读取状态。只有独立恢复流程确认原执行者失效并进行条件状态转换后，才能将遗留状态变为 `unknown`；不自动再次调用。所有权由执行者租约表达，恢复执行器随 API 定时运行；真实数据库上的验证待草案授权。
4. 通过校验的小型候选使用数据库设计，绑定工作区、项目和冻结输入。开发默认保留 7 天。过期只清除候选正文，幂等和审计行保留。不保存密钥或原始错误正文。费用金额保持空。
5. Migration 草案在 `packages/database/prisma/drafts/`，不在已执行目录。执行仍未授权。
6. 页面候选仍须人工比较、采纳到草稿、手动保存。If-Match、409、版本历史和审核状态机不变。

真实付费调用仍未授权。假凭据和可注入 transport 只覆盖内存协议，包括真实并发的调用测试。SQL 草案未执行，不能将这些结果写成在线模型闭环已经通过。
