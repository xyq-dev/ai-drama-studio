# OpenAI 图片适配器（`gpt-image-2.5-sunburst`）

更新：2026-11-04。这是独立脚手架，**不是**默认图片供应商，也 **不是** 已完成的实付费验收。合并与上线都要另行确认。本变更不部署、不跑业务库 migration、不在仓库写入密钥。

## 不会自动替换百炼

`image.generate` 在未显式选择时仍是百炼北京 `qwen-image-3.0`。只配置 OpenAI 相关变量、或进程里碰巧有写作用的 `OPENAI_API_KEY`，都不会把图片切到 sunburst。

只有进程环境 `REAL_MEDIA_IMAGE_PROVIDER=openai-media` 时，图片报价才使用本适配器。此时模型固定为 `gpt-image-2.5-sunburst`，正式请求体带官方参数 `quality=max`、`size=1024x1536`、`output_format=png`、`n=1`，发往 `{base}/v1/images/generations`。`gpt-image-2.5-flare`、`qwen-image-3.0`、`dall-e` / `dall-e-3` 以及其他模型在构造时直接 `MEDIA_CONFIGURATION_UNSUPPORTED`，不会静默改打百炼或 flare 并声称 sunburst 已接通。

选择了 `openai-media` 但缺少媒体 key、已核对单价或受保护 base URL 时，`image.generate` 关闭（报价不可用）。**不会**退回 DashScope。视频 / TTS 仍只走各自原有的百炼配置；音乐仍是 ElevenLabs。

## 受保护环境变量

密钥、base URL 和图片供应商选择 **只读进程环境**，不从 `.env` 文件补齐，也不要写入仓库或聊天。

| 变量 | 作用 |
| --- | --- |
| `REAL_MEDIA_IMAGE_PROVIDER` | `openai-media` 才启用本适配器。未设置或 `dashscope-media` 保持百炼图片。其他值（含 flare / qwen / dall-e）拒绝启动。 |
| `OPENAI_MEDIA_API_KEY` | 媒体独立 key。**不要**拿写作用的 `OPENAI_API_KEY` 充当付费媒体授权。入库引用只有 `env:openai-media`。 |
| `OPENAI_MEDIA_CREDENTIAL_VERSION` | 默认 `v1`。轮换时另配 `OPENAI_MEDIA_PREVIOUS_API_KEY` 与不同的 `OPENAI_MEDIA_PREVIOUS_CREDENTIAL_VERSION`，只给原任务恢复。 |
| `OPENAI_BASE_URL` 或 `OPENAI_API_BASE` | 合规 HTTPS 源站，无路径、查询、账号或非常规端口。两者都设置时必须是同一个源站，否则拒绝。未设置则不发明 `https://api.openai.com`，图片能力保持关闭。 |
| `OPENAI_MEDIA_PRICE_IMAGE` | 操作者核对后的 USD 单价。未配置不开放。另需既有 `REAL_MEDIA_PRICE_VERSION`、`REAL_MEDIA_ENABLED`、收据密钥，以及 `REAL_MEDIA_MAX_SINGLE_USD`（默认 2，只是应用门槛）。 |

仍沿用报价 → 单次授权 → 密封收据。同步成功要有 `x-request-id`（或 `request-id`）才记 ACKNOWLEDGED，并把 PNG 放进与音乐相同的 data URI 收据。超时、断连、5xx 或没有可靠请求 ID 的 200 记 UNKNOWN，**不自动重发**。`inspect` 不会再打 generations。明确的 4xx（含区域 403 `unsupported_country_region_territory`）是拒绝，不是换模型重试。

## 编辑路径还不是产品

`/v1/images/edits` 只留了未发送的脚手架（参考图 / mask / prompt，模型与 `quality=max` 同样钉死）。调用会 `MEDIA_EDIT_NOT_PRODUCTIZED`，传输层不会发出。Provision 允许列表只增加 `openai-media:image.generate`，没有 edit 能力，也没有删掉百炼或 ElevenLabs 的原门。

## 实付费验证还不能在这台默认环境做

默认 Cursor VM / 当前工程环境访问 `api.openai.com` 会得到区域网络 403（`unsupported_country_region_territory`），这不是密钥错误。本 PR 只跑未付费的假传输测试，**不要**从这台 VM 发起 sunburst 生成，也不要改打 flare、qwen 或 DashScope 来冒充连通。

实连要等其中之一：

1. 调用方在受保护进程环境写入上面的媒体 key，以及自己提供的合规 `OPENAI_BASE_URL` / `OPENAI_API_BASE`（用来绕过默认 VM 到 `api.openai.com` 的区域封锁）；或
2. 在用户自己的机器上跑（带 machineId 的用户机），而不是这台默认 VM。

OpenAI 侧还可能要求 Org Verification。即使 key 和 base URL 都齐了，本分支也 **不会** 自动合并或部署。
