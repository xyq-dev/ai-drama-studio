---
name: ai-drama-native-tools
description: >-
  When the user wants to create, list, continue, or check an AI Drama Studio
  (红果短剧) project, or save a script revision through GrokBot chat without
  opening the website. Use for short-drama text workflow entry. Not for paid
  media generate, deploy, or DB migrations.
---

# AI Drama Studio — GrokBot native tools

## Can do (local store)

1. `create` / `list` / `continue` projects  
2. `save-script` then human `approve-script --approved-by user:…`  
3. `set-characters` / `set-storyboard` / `approve-scene --approved-by user:…`  
4. `voice-plan` (counts planned TTS only; **never** calls provider)  
5. `status` with blockers  

Reproduce 《末班车暗号》：

```sh
bash scripts/grokbot-native-tools/fixtures/moban-che-anhao/repro.sh
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
4. After `voice-plan`, show plannedTtsCalls + point to `docs/FIRST_REAL_SHORT_ONE_SHOT.md` for one-shot auth.  
5. Reply with title, stage, blockers, next human step — not raw IDs/cookies.

## Install

Repo draft. Parent with `UpdateSkill` should write name `ai-drama-native-tools` from this body.
