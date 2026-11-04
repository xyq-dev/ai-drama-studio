# ElevenLabs 场景对白（`eleven_v4`）

更新：2026-11-04。本文件描述 GrokBot 原生导演流程和独立语音适配器。**本轮没有真实付费合成、没有业务库 SQL、没有 `provision --execute`、没有部署。** 账号是否开通 `eleven_v4`、以及 Pro 及以上才能使用的 44.1 kHz PCM/WAV，都还没有用真实密钥核验。

音乐仍是 `elevenlabs-media` / `music_v2` / `ELEVENLABS_MEDIA_PRICE_MUSIC_SECOND`。语音不读取这些名字，也不把音乐单价当成台词单价。网站逐句配音仍是百炼 `qwen3-tts-flash`（Cherry/Ethan/Serena，neutral，语速 1）。`assertRealMediaInput` 会在网站 Worker 发请求之前拒绝 `elevenlabs-tts`，避免整场对白被记成逐句费用，也避免走音乐 MP3→FFmpeg 规范化。

## 环境变量

只放在进程环境或 chmod 600 的文件里，不要写进仓库、聊天或日志。

| 变量 | 作用 |
| --- | --- |
| `ELEVENLABS_TTS_API_KEY` | 语音密钥。不存在时不能真实提交。`ELEVENLABS_MEDIA_API_KEY` 不会被当作替补。 |
| `ELEVENLABS_TTS_CREDENTIAL_VERSION` | 默认 `v1`。轮换时必须换版本。 |
| `ELEVENLABS_TTS_PREVIOUS_API_KEY` / `ELEVENLABS_TTS_PREVIOUS_CREDENTIAL_VERSION` | 只读旧版本。不能和当前版本同名。 |
| `ELEVENLABS_TTS_PRICE_CHARACTER` | USD 每字正数单价。未配置则不能报价。不是音乐的按秒价。 |
| `ELEVENLABS_TTS_OUTPUT_FORMAT` | 只允许 `pcm_44100`（默认）或 `wav_44100`。`mp3_*` 在加载时拒绝，运行时也不会改写成有损格式。 |
| `REAL_MEDIA_PRICE_VERSION` | 既有价格快照版本。语音配置和图片/音乐一样要求它存在，服务端才会露出 `elevenLabsTtsConfiguration()`。 |
| `REAL_MEDIA_MAX_SINGLE_USD` | 一次场景报价上限，默认 2。是应用门槛，不是账号硬限额。 |

`pcm_44100` 与 `wav_44100` 需要 ElevenLabs **Pro 及以上**。账号不够时接口返回 401/402/403/422，适配器原样报告 `eleven_v4` 和所请求的格式，并停止。不会改叫 `eleven_multilingual_v2`、`eleven_v3` 或 `music_v2`。

服务端入口是 `ServerRealMediaRuntime.elevenLabsTtsConfiguration()`，provider key 为 `elevenlabs-tts`，模型字面量 `eleven_v4`。`configurationFor("audio.tts")` 仍返回百炼逐句配置，避免把现有网站报价悄悄换成另一套单价。

## 请求

只调用 `POST https://api.elevenlabs.io/v1/text-to-dialogue/with-timestamps?output_format=pcm_44100|wav_44100`。

正文始终包含 `model_id: "eleven_v4"`。一场对白的多句放在同一次 `inputs[]` 里，用来保持前后文，而不是每句各打一次。可选的场外上下文用对话接口的 `previous_text` / `future_text`（最多 100 字）。不发送 TTS 接口的 `next_text`，也不发送 SSML、`speed`、`style`、`voice_settings`、`audio_effects`。雨声、降噪、加速留到后面的混音，干声本身不处理。

成功时保存原始音频、`voice_segments`、`alignment`、模型、voice id 和输入版本。对不齐每一句的时间就停在 `ALIGNMENT_INSUFFICIENT`：不编造字幕时间，同一幂等键不重发。5xx、断连和没有 request id 的成功包记为 `UNKNOWN` 或 `INTENT`，恢复只读原收据，不自动再提交。

一场是收据里的**一次**外部操作（`component: scene-dialogue`）。从父音频按对齐时间切出的句子是 `parent-window`，`externalSubmitCount: 0`，`cleanSoloStem: false`。时间重叠的对白不会被标成干净的单人干声。

## GrokBot 怎么走

不打开网站。本地 store 复用报价、授权、幂等键、Job、来源版本和收据；`--mock` 不带密钥，结算记为 `UNPAID_MOCK`。真实提交必须同时有 `ELEVENLABS_TTS_API_KEY`、字符单价、`tts-authorize --authorized-by` 和 `--execute`。

```sh
node scripts/grokbot-native-tools/cli.mjs create --title "末班车暗号" --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs save-script --text-file scripts/grokbot-native-tools/fixtures/moban-che-anhao/script.txt --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs approve-script --approved-by user:… --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs set-characters --characters-file scripts/grokbot-native-tools/fixtures/moban-che-anhao/characters.json --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs set-storyboard --scene-file scripts/grokbot-native-tools/fixtures/moban-che-anhao/scene.json --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs approve-scene --approved-by user:… --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs performance-plan --output-format pcm_44100 --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs voice-candidates --voices-file scripts/grokbot-native-tools/fixtures/moban-che-anhao/voices.json --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs pick-voice --character 阿岚 --candidate alan-clear --voices-file scripts/grokbot-native-tools/fixtures/moban-che-anhao/voices.json --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs pick-voice --character 老周 --candidate zhou-low --voices-file scripts/grokbot-native-tools/fixtures/moban-che-anhao/voices.json --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-quote --unit-price 0.0001 --budget-cap 2 --currency USD --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-authorize --authorized-by user:… --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-generate --mock --idempotency-key scene-1 --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-preview --job-id … --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-select --job-id … --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-redo --job-id … --line-index 0 --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-resume --job-id … --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-subtitles --job-id … --store "$STORE"
node scripts/grokbot-native-tools/cli.mjs tts-export --job-id … --out /tmp/moban-audio --store "$STORE"
```

《末班车暗号》四句原文不改写。表演说明（阿岚：年轻女声、略紧、清晰；老周：中年男声、低、短句；雨夜站台）只写在 performance plan 里，不进入合成文本，也不进入 VTT。`voices.json` 里每个角色 3 个占位候选，等有 `ELEVENLABS_TTS_API_KEY` 后再换真实目录。

`voice-plan` 现在把整场算成 **1** 次外部调用（`plannedTtsCalls === 1`），不再建议「句数 × 3」或「再加 4 次」的百炼逐句试点。

未付费测试：

```sh
node scripts/grokbot-native-tools/cli.test.mjs
node scripts/grokbot-native-tools/elevenlabs-tts.test.mjs
```

覆盖同一指令幂等、UNKNOWN/INTENT 不自动重发、收据恢复、字幕只使用返回的对齐、重叠窗口不算单人干声。

## 还缺什么

- 没有可用的 `ELEVENLABS_TTS_API_KEY`，因此没有拉真实 voice catalog，候选 id 仍是 `placeholder-*`。
- 没有对真实账号验证 `eleven_v4` 是否开通。未开通时应看到 HTTP 拒绝，而不是另一模型的声音。
- 没有对真实账号验证 Pro+ 的 `pcm_44100` / `wav_44100`。Creator 或更低套餐会被拒绝；本代码不会改出 MP3。
- 网站逐句 Job、FFmpeg 素材规范化和 `provision --execute` 都还没有接到这条场景语音上。那一步要另批，不能靠删掉付费门来做。
