# 配音开源项目调查与选型

调查日期：2026-10-07。仅阅读项目官方仓库、LICENSE与服务官方文档；没有安装模型、下载权重、运行试听或调用付费API。以下适配结论是架构判断，不是效果跑分，也不是商业许可批准。

## 结论

红果是“从剧本生产短剧”，已有对白，不需要先建设搬运、转写、翻译平台。借鉴分句、声音选择、对齐与局部重做，保持红果自己的审核/任务/费用/来源链。首批优先云端百炼CosyVoice系预置音色；开源CosyVoice作为独立服务的后续选择。不要将整个外部应用直接嵌入。

## 候选比较

| 项目 | 适合借鉴的能力 | 调查到的许可证标识 | 本项目决定 |
| --- | --- | --- | --- |
| [CosyVoice](https://github.com/QwenAudio/CosyVoice)（旧FunAudioLLM地址重定向） | 中文、多语言、声音条件与表演控制、独立服务接口 | 代码仓库Apache-2.0；具体权重/声音/依赖另核 | 自托管候选首选；首期不向现有服务器安装推理栈 |
| [VideoLingo](https://github.com/Huanshere/VideoLingo) | 分段、字幕对齐、流程可恢复、TTS后端边界 | 当前仓库Apache-2.0 | 借鉴交互/流水线；当前README明确不自动逐说话人分配声音，不可直接当多角色导演 |
| [open-dubbing](https://github.com/Softcatala/open-dubbing) | 以片段组织文本、声音与时间，替换TTS服务 | Apache-2.0 | 方法参考；仓库自述实验性，翻译已有视频的主流程不直接移入红果 |
| [WhisperX](https://github.com/m-bain/whisperX) | 词时间戳、强制对齐、说话人分离 | 当前仓库BSD-2-Clause；所加载模型另核 | 无Provider时间戳时的对齐候选；不是TTS，数字/重叠语音/语言模型有限制 |
| [IndexTTS](https://github.com/index-tts/index-tts) | 情感、音色控制与可控语速 | bilibili Model Use License Agreement，自定义协议 | 第二梯队验证；不把源码公开等同Apache/MIT，也不先作商用已批准声明 |

以上五项足以确定当前设计方向，暂不继续堆叠引擎。首版只接一个服务，统一台词/音色/receipt合同后再增加Provider。

## 版本与来源记录

GitHub API在调查时返回的仓库HEAD（用于追踪，不代表已下载或验收该版本）：

| 仓库 | HEAD |
| --- | --- |
| QwenAudio/CosyVoice | `074ca6dc9e80a2f424f1f74b48bdd7d3fea531cc` |
| Huanshere/VideoLingo | `01f843492759be9bbfd1a5cb697b799cc9de1609` |
| Softcatala/open-dubbing | `bff534d3accafb02a84f1356dd02585929e436fd` |
| m-bain/whisperX | `771b4a14a9486f8fd5aef18ef49e35d639523dd3` |
| index-tts/index-tts | `d9e41aac89fd00b3d71497fddb287b7f24613712` |

能力与许可证描述依据调查时官方README/LICENSE页面；实施引入代码前必须重新核对所选精确commit的文件、依赖和权重卡，并保留必要LICENSE/NOTICE。此提交未复制任何第三方实现代码或权重。

官方来源：

- [CosyVoice README](https://github.com/QwenAudio/CosyVoice/blob/main/README.md) / [LICENSE](https://github.com/QwenAudio/CosyVoice/blob/main/LICENSE)
- [VideoLingo README](https://github.com/Huanshere/VideoLingo/blob/main/README.md) / [LICENSE](https://github.com/Huanshere/VideoLingo/blob/main/LICENSE)
- [open-dubbing README](https://github.com/Softcatala/open-dubbing/blob/main/README.md) / [LICENSE](https://github.com/Softcatala/open-dubbing/blob/main/LICENSE)
- [WhisperX README](https://github.com/m-bain/whisperX/blob/main/README.md) / [LICENSE](https://github.com/m-bain/whisperX/blob/main/LICENSE)
- [IndexTTS README](https://github.com/index-tts/index-tts/blob/main/README.md) / [LICENSE](https://github.com/index-tts/index-tts/blob/main/LICENSE)
- [百炼CosyVoice音色与能力列表](https://help.aliyun.com/zh/model-studio/cosyvoice-voice-list)
- [百炼非实时语音合成](https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide)

## 必须避免的错误推论

- CosyVoice开源模型与百炼同名服务不是同一个运行合同；voiceId、可用地域、模型版本和时间戳能力分别核实。
- 官方音色列表说明：每个模型只支持特定音色；emotion/instruction/SSML/时间戳按音色有差别。UI必须按实际能力显示。
- IndexTTS当前仓库包含2.5更新；2的精确时长控制曾注明未开放，2.5的duration_factor也不代表任意精确时长或无损对口型。不得据论文宣传承诺固定秒数的自然台词。
- VideoLingo当前README不自动为每个speaker分配不同音色，且速度调整不保证自然同步。红果必须自己维护显式角色映射。
- WhisperX可能无法为数字/特殊字符提供时间戳，重叠语音和说话人分离也有误差。已知台词优先对齐，不通过重新识别悄悄改台词。
- 开源代码许可与权重、预置声音、用户克隆样本、生成内容和服务条款分别成立。本次没有完成上述商业分发审查。
- 没有核实服务商按requestId查询/幂等能力；第一期按“不能依赖该能力”设计UNKNOWN，不能因拿到了requestId就自动重发。

## 本次研究不做的事

不运行README中的安装命令，不下载用户未知来源素材，不调用任何推荐中转API，不将密钥交给第三方demo。不根据星数选择效果最好，不报未经测量的GPU配置、速度或费用。后续用同一组经授权的双角色台词做有限A/B试听，再决定固定模型版本。
