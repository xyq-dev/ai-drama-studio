# Provider 就绪清单

更新：2026-11-01。本文件区分 Adapter 代码、账号/价格/许可就绪和真实质量验收。当前真实媒体 Adapter 与平台接线已实现，默认关闭；**本轮真实付费调用 0、业务 SQL 0、部署 0**。启用与密钥轮换见 [`REAL_MEDIA_RUNBOOK.md`](REAL_MEDIA_RUNBOOK.md)。

> 当前文本支持 OpenAI、Claude 与重新接入的 DeepSeek（[`OPENAI_CLAUDE_WRITING.md`](OPENAI_CLAUDE_WRITING.md)、[`DEEPSEEK_WRITING.md`](DEEPSEEK_WRITING.md)）。千问文本已退役；下面该小节保留为历史记录。`DASHSCOPE_MEDIA_*` 是新增独立媒体配置，不恢复旧文本入口。

## 已退役：文本（千问 / 阿里云百炼 OpenAI 兼容接口）

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

## 当前媒体代码与外部就绪

| 能力 | 代码固定选择 | 已编码的工程边界 | 真实验收 |
| --- | --- | --- | --- |
| 图片 | 百炼北京 `qwen-image-3.0` | 一次提交、task ID 查询、受限下载、格式/尺寸/SHA-256/S3 注册 | 未执行 |
| 视频 | 百炼北京 `wan2.6-i2v-flash` | 已生成首帧、显式参数、一次提交/原任务查询、实测 metadata | 未执行 |
| 逐句 TTS | 百炼北京 `qwen3-tts-flash` | Cherry/Ethan/Serena 目录、版本化选声、neutral/语速 1、同步加密收据、逐句选用 | 未执行；未证明真实人声质量 |
| 音乐 | ElevenLabs `music_v2` | 纯伴奏、固定时长、同步私有输出收据、MP3 规范化 WAV、S3 | 未执行 |
| 合成 | 既有 FFmpeg + 新 `local-ffmpeg-voice-v1` | 逐句时长/VTT、超时拒绝、ducking、精确 SC 字体、既有审核/导出 | synthetic 技术测试；真实短片/听感仍待验收 |
| ComfyUI / 自托管 | 仍为 stub / 设计候选 | 未实现真实 GPU 推理与模型部署 | 不可记作已接通 |

收到供应商回执不等于素材已入库或实际费用已结算。无码 UNKNOWN 不自动重发；有 ID 恢复只查询原任务。usage 只作为用量，ACTUAL 仍未知。下面条件仍需在实际启用前由负责人逐项核实，不能由离线测试替代：

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

## 配音选型历史与当前范围

[`VOICE_OPEN_SOURCE_RESEARCH.md`](VOICE_OPEN_SOURCE_RESEARCH.md) 是 2026-10-07 的 CosyVoice 候选调查，保留原有事实与日期。当前首接代码采用百炼北京 `qwen3-tts-flash`，不声称自托管 CosyVoice 已实现。账号、模型资格、预置音色权利与现价仍待独立核验。

角色声音版本、逐句计划/选用、发送前持久化、UNKNOWN、长台词阻断和新 profile 已编码，见 [`CHARACTER_VOICE_DESIGN.md`](CHARACTER_VOICE_DESIGN.md)。云端与开源能力合同分别验证；Mock 配音保留固定静音素材与原守卫。没有真实试听就不宣称角色声音、发音或情绪质量通过。
