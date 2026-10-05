# 千问网页调用

本机 `qwen:writing` 仍生成 `candidate.json`，由创作者粘贴到编剧助手。网页默认没有调用入口。服务端路由 `POST /api/v1/writing/qwen-candidates` 在生产环境强制关闭，开发环境默认关闭。存储迁移尚未执行，所以即使打开开关，路由也在发请求前返回存储不可用，不会调用模型。

规则实现和假凭据测试在 `packages/providers/src/qwen-web-writing.ts`。它不是 `REPLAY_SAFE_SYNC`，也不替换 `MockTextAdapter`。

## 仍然不能做成开放按钮

工作台默认不传入 `requestCandidate`，所以页面上看不到「向工作区请求候选」。组件只有在调用方显式传入该函数时才显示按钮。按钮把候选放进预览，不调用采纳，也不保存。

1. V1 仍是单工作区、单操作者。没有登录。路由校验操作者令牌；生产强制关闭，开发默认关闭。存储草案未执行时，路由在发请求前返回存储不可用。
2. [`PROVIDER_CONTRACTS.md`](PROVIDER_CONTRACTS.md) 规定，只有 `REPLAY_SAFE_SYNC` 能进入现有文本 Job。千问的 `providerResult=unknown` 不能标成可重放，也不替换 `MockTextAdapter`。
3. 官方 chat completions 仍按「不支持凭请求 ID 恢复结果」处理。`unknown` 不自动再 POST。

## 审查通过后的请求身份

建议的持久化记录先叫写作模型请求。它不是故事或剧本修订。

字段至少包括：工作区、操作者幂等键、模式（故事或分集）、分集号、已校验输入的 SHA-256、请求模型、状态、服务商请求 ID、候选是否通过网页同一套解析、费用状态。费用金额保持空，状态保持未知。不保存 API Key、Authorization 或原始错误正文。

状态只有：`reserved`、`submitted`、`completed`、`rejected`、`unknown`。

规则：

1. 发出网络请求之前，在同一事务里占用幂等键并写入 `reserved`。同一键再次出现时返回原记录，不再调用模型。
2. 请求离开进程后才记为 `submitted`。一次操作最多一个请求。
3. 只有 `finish_reason=stop`，并且 `parseWritingImport` 与 `formatWritingImport` 都通过，才记为 `completed`。候选可以被人导入，不会自动写成已保存版本。
4. 认证失败、拒绝、工具调用、非 stop、校验失败记为 `rejected`。不自动第二次请求。
5. 超时、断连、重定向、响应超限，以及请求发出后的 5xx，记为 `unknown`。文案说明可能已经产生费用。不自动重试，不自动换模型。新的调用必须使用新的幂等键，并要操作者明确确认。
6. 采纳候选仍走现有草稿和「保存新版本」。If-Match、409 和审核状态机不变。

## 已确认的决定

1. V1 仍是单工作区、单操作者。入口默认关闭，生产强制关闭。服务端校验操作者令牌，并限制请求数量、并发和 `max_completion_tokens=4096`。没有匿名代理，也没有会员或支付。
2. 在核实服务商查询能力之前，不支持凭请求 ID 恢复结果。`unknown` 不自动重投。相同幂等键配不同输入会被拒绝。
3. 网络发送前先写入 `reserved`，再写成 `submitted`。崩溃留下的 `reserved` 或 `submitted` 按 `unknown` 处理，不能自动再次调用。
4. 通过校验的小型候选使用数据库设计，绑定工作区、项目和冻结输入。开发默认保留 7 天。过期只清除候选正文，幂等和审计行保留。不保存密钥或原始错误正文。费用金额保持空。
5. Migration 草案在 `packages/database/prisma/drafts/`，不在已执行目录。执行仍未授权。
6. 页面候选仍须人工比较、采纳到草稿、手动保存。If-Match、409、版本历史和审核状态机不变。

真实付费调用仍未授权。假凭据和可注入 transport 覆盖了上述状态规则。
