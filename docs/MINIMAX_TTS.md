# MiniMax 语音（`speech-2.8-hd` / `t2a_v2`）

Ticket: `T-TTS-ENG-MM-01`。更新：2026-11-04。

这是一条独立的国内 MiniMax 文本转语音路径，架构与 ElevenLabs `eleven_v4` 相同：先报价，再人工授权，再写收据。`UNKNOWN` 和尚未完成的 `INTENT` 不会自动重发。失败不会改走 ElevenLabs、百炼 `qwen3-tts-flash` 或任何其他 TTS。

网站逐句 Worker 在发请求前拒绝 `minimax-tts`。`configurationFor("audio.tts")` 仍是百炼。`elevenLabsTtsConfiguration()` 仍只看 `ELEVENLABS_TTS_*`。入口是 `ServerRealMediaRuntime.minimaxTtsConfiguration()`，provider key 为 `minimax-tts`，模型字面量 `speech-2.8-hd`。

本文件描述的测试不发起真实付费请求。账号余额不足时接口返回 `base_resp.status_code` **1008**，适配器停止并说明需要充值。**2049** 表示 API key 无效或主机不对（国内默认 `https://api.minimaxi.com`）。这两种都不会重试，也不会换成别的供应商。

## 环境变量

只放在进程环境或 chmod 600 的文件里。不要写进仓库、聊天或日志。`MINIMAX_API_KEY` 只从进程环境读取。

| 变量 | 作用 |
| --- | --- |
| `MINIMAX_API_KEY` | Bearer 令牌。未设置时不能真实提交。`ELEVENLABS_TTS_API_KEY` 不会被当作替补。 |
| `MINIMAX_TTS_MODEL` | 只允许 `speech-2.8-hd`（默认）。其他模型在加载时拒绝。 |
| `MINIMAX_TTS_BASE_URL` | 默认 `https://api.minimaxi.com`。必须是 https 源站，不能指向 ElevenLabs / DashScope / OpenAI。 |
| `MINIMAX_TTS_OUTPUT_FORMAT` | `wav`（默认）或 `pcm`。`mp3` 在加载时拒绝。 |
| `MINIMAX_TTS_SAMPLE_RATE` | 只允许 `44100`。 |
| `MINIMAX_TTS_PRICE_CHARACTER` | CNY 每字正数单价。未配置则服务端不露出配置，也不能在没有 `--unit-price` 时报价。 |
| `MINIMAX_TTS_CREDENTIAL_VERSION` | 默认 `v1`。 |

请求是一次 `POST {base}/v1/t2a_v2`。正文固定 `model: "speech-2.8-hd"`、`stream: false`、`output_format: "hex"`、`audio_setting.format` 为 `wav` 或 `pcm`、`sample_rate: 44100`。响应里的 hex 音频解码成对应容器。不编造字幕时间。不跟随音频 URL 再发一次请求。

5xx、断连、没有 `trace_id` 的成功包、以及读不出的音频记为 `UNKNOWN`。同一幂等键直接返回原收据。另一条指令在 `UNKNOWN` / `INTENT` 未确认前被挡住。`mm-tts-resume` 只读收据，`resubmitted` 始终为 false。

## 未付费命令

```sh
node scripts/grokbot-native-tools/cli.mjs mm-tts-quote --voice-id female-shaonv --unit-price 0.0002 --budget-cap 10 --currency CNY --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs mm-tts-authorize --authorized-by user:… --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs mm-tts-generate --mock --idempotency-key scene-1 --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs mm-tts-resume --store "$STORE"
```

`--mock` 在环境里存在 `MINIMAX_API_KEY` 时拒绝，避免把真实密钥送进夹具。`--execute` 才会带 Bearer 调用国内 `t2a_v2`。CI 和本仓库测试不得使用 `--execute`。

## 验证（无网络、无付费）

```sh
pnpm --filter @ai-drama/contracts build
pnpm --filter @ai-drama/domain exec vitest run src/real-media.spec.ts
pnpm --filter @ai-drama/providers exec vitest run src/minimax-tts-adapter.spec.ts src/real-media-runtime.spec.ts src/elevenlabs-tts-adapter.spec.ts
node scripts/grokbot-native-tools/minimax-tts.test.mjs
node scripts/grokbot-native-tools/elevenlabs-tts.test.mjs
```
