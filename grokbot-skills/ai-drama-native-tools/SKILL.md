---
name: ai-drama-native-tools
description: >-
  When the user wants to create, list, continue, or check an AI Drama Studio
  (红果短剧) project, save a script, or run the local ElevenLabs eleven_v4
  scene-dialogue director flow through GrokBot without opening the website.
  Not for paid media generate, deploy, or DB migrations unless the user
  explicitly authorizes one scene submit.
---

# AI Drama Studio — GrokBot native tools

## Can do (local store)

1. `create` / `list` / `continue` projects  
2. `save-script` then human `approve-script --approved-by user:…`  
3. `set-characters` / `set-storyboard` / `approve-scene --approved-by user:…`  
4. `voice-plan` counts **one** ElevenLabs `eleven_v4` scene operation. It does not plan per-line qwen submits.  
5. `performance-plan`, `voice-candidates`, `pick-voice` (placeholder catalog until a live key)  
6. `tts-quote` → human `tts-authorize --authorized-by` → `tts-generate`  
7. `tts-preview`, `tts-select`, `tts-redo`, `tts-resume`, `tts-subtitles`, `tts-export`  
8. `status` with blockers  

`tts-generate --mock` is unpaid and refuses a live `ELEVENLABS_TTS_API_KEY`. A real submit needs that speech key, `ELEVENLABS_TTS_PRICE_CHARACTER`, authorization, and `--execute`. Never reuse `ELEVENLABS_MEDIA_*` music key or per-second price. `pcm_44100` / `wav_44100` need ElevenLabs Pro or higher; do not downgrade the model or the format. See `docs/ELEVENLABS_TTS.md`.

Reproduce 《末班车暗号》：

```sh
bash scripts/grokbot-native-tools/fixtures/moban-che-anhao/repro.sh
node scripts/grokbot-native-tools/elevenlabs-tts.test.mjs
```

## Must not pretend

- No ai-drama MCP unless `GetMcpServerStatus` shows one.  
- No paid generate/authorize/auto-runs; no forge APPROVE without user `--approved-by`.
- Do not call `gpt-image-2.5-sunburst` or `/v1/images/generations` from this CLI. That model is an explicit real-media provider only (`docs/OPENAI_IMAGE_SUNBURST.md`), not a Bot shortcut and not a DashScope fallback.  
- No secrets in chat; live ADS_* via `--env-file` only.  
- `approve-*` / `voice-plan` are **local-only** in this skill revision.

## Steps

1. Resolve checkout with `scripts/grokbot-native-tools/cli.mjs` (often `/workspace/ai-drama-studio`).  
2. Prefer local store (`ADS_LOCAL_STORE` stable path).  
3. Map NL → CLI; for APPROVE ask user to confirm actor string then pass `--approved-by`.  
4. After `voice-plan`, show `dialogueLines` and `plannedTtsCalls` (one scene call) and point to `docs/ELEVENLABS_TTS.md` plus `docs/FIRST_REAL_SHORT_ONE_SHOT.md`.  
5. Reply with title, stage, blockers, next human step — not raw IDs/cookies.

## Install

Repo draft. Parent with `UpdateSkill` should write name `ai-drama-native-tools` from this body.
