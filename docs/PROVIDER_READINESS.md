# Provider 就绪清单

本文件只记录事实与待决定项，不选择供应商，不开通服务，不代表真实 Adapter 已完成。

## 已选定：文本（千问 / 阿里云百炼 OpenAI 兼容接口）

已有代码：`packages/providers/src/qwen-chat.ts`（单次非流式请求、官方主机白名单、响应上限、5xx/超时/断连记为 unknown、密钥脱敏）、本机 `qwen:trial` / `qwen:writing`、网页路由（见 [`QWEN_WEB_INVOCATION.md`](QWEN_WEB_INVOCATION.md)）。离线契约测试使用手写响应和可注入 transport，不访问网络。

2026-10-06 对照官方文档 [OpenAI Chat 接口兼容](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope) 核实：

| 事项 | 官方文档 | 代码现状 |
| --- | --- | --- |
| 端点 | 各地域 `.../compatible-mode/v1`（含 `{WorkspaceId}.<region>.maas.aliyuncs.com` 与 `dashscope-us.aliyuncs.com`） | 只接受官方主机与 `/compatible-mode/v1`，拼 `/chat/completions` |
| `finish_reason` | `null`、`stop`、`length` | 只有 `stop` 且通过解析才接受候选 |
| 调用标识 | 响应体 `id` | 读取响应体 `id` 与请求 ID 头，脱敏后保存 |
| 按请求 ID 查询结果 / 幂等 | 文档未提供 | 不声称可恢复；unknown 不自动重发 |

未能在官方页面确认、真实调用前必须确认：

- `max_completion_tokens` 是否被所选模型接受（官方兼容页只列出 `max_tokens`；仅第三方模型目录写明 Qwen3.7 Plus 使用 `max_completion_tokens`）。网页路由当前发送 `max_completion_tokens=4096`。
- 默认模型名 `qwen3.7-plus-2026-05-26` 在所选地域与账号下是否可用。
- 计费口径。费用金额一律保持未知，不写 ACTUAL 0。

## 未选定：图片、视频、配音、音乐、ComfyUI

现有实现只有 Mock Adapter 与本地 FFmpeg 合成。下列每一项都需要负责人决定并提供资料后才能写真实 Adapter：

| 必须确定 | 说明 |
| --- | --- |
| 供应商与模型 | 每个能力的服务商、模型与版本；ComfyUI 需固定版本、工作流模板与自定义节点清单。 |
| 接口形态 | 同步或异步；是否支持回调（验签方式）、按 request id 查询、取消；超时与限流。 |
| 输出约束 | 能否产出 1080×1920、时长上限、帧率、编码格式、音频采样率；是否返回短期下载 URL。 |
| 可复现性 | 是否支持 seed；不支持时记录 `seedSupported=false`。 |
| 凭据 | 密钥类型、存放位置（只放服务端密钥管理或进程环境）、轮换方式。 |
| 配额与费用 | 并发与日配额；单价与计费单位，用于估算与实际成本分开记录。 |
| 许可 | 模型权重与生成内容的商用条款、地域限制；ComfyUI 节点与权重逐项复核。 |
| 数据 | 输入素材是否被留存或用于训练；数据驻留地域。 |

## 本地编码费率

本地 FFmpeg 编码只记录耗时和资源计数，`productionCost` 金额与币种为空、状态 unknown。没有确认的费率前，不定价、不补历史账、不把未知写成 0。

## 配音技术候选（2026-10-07，仅设计）

[`VOICE_OPEN_SOURCE_RESEARCH.md`](VOICE_OPEN_SOURCE_RESEARCH.md) 建议先验证百炼官方 CosyVoice 系预置音色，后续再考虑独立自托管 CosyVoice。它是技术候选，不代表供应商账号、地域、精确模型、费率和许可已经选定或核验，也不表示有可运行的真实 Speech Adapter。

实施遵循 [`CHARACTER_VOICE_DESIGN.md`](CHARACTER_VOICE_DESIGN.md)：角色声音版本、逐句计划、发送前持久化、UNKNOWN 不自动重发、费用与资产可用性分别记录、长台词阻断合成。云端服务与开源模型的能力合同分别验证；现有 Mock 配音保持原样。
