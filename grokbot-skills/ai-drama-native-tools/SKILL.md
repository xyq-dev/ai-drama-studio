---
name: ai-drama-native-tools
description: >-
  When the user wants to create, list, continue, or check an AI Drama Studio
  (红果短剧) project, or save a script revision through GrokBot chat without
  opening the website. Use for short-drama text workflow entry (create/query/
  continue/save-script/status). Not for paid media generate, deploy, or DB
  migrations.
---

# AI Drama Studio — GrokBot native tools (first loop)

## What this skill can do

Drive the **first complete text loop** via CLI in the repo checkout:

1. Create a short-drama project (title / premise / genre / audience / 1–6 episodes).
2. List and continue the current project (persists across chat turns via local store or live API).
3. Save an immutable script revision (DRAFT) for an episode.
4. Show status and blockers (e.g. script not APPROVED yet).

## What this skill must NOT pretend

- There is **no** dedicated MCP connector named “ai-drama” unless `GetMcpServerStatus` / `SearchPlugins` shows one. Do not invent MCP tools.
- Do not call paid paths (auto-runs, real-media generate/authorize, speech generate, provision `--execute`).
- Do not auto-APPROVE reviews or invent market data.
- Do not paste `ADS_SESSION_COOKIE` / CSRF / API keys into chat. Use `--env-file` on a protected path or local mode.

## Prerequisites

- Repo checkout on box or machine, typically `/workspace/ai-drama-studio`.
- Node.js available (`node`).
- Default backend: **local JSON store** (works if the website is down).
- Optional live backend: env file with `ADS_API_BASE`, `ADS_ORIGIN`, `ADS_SESSION_COOKIE`, `ADS_CSRF_TOKEN`. Live writes also need `--execute` or `ADS_LIVE_WRITES=1`.

## Steps

1. Resolve repo root. Prefer existing clone; else shallow clone `https://github.com/xyq-dev/ai-drama-studio` into `/workspace/ai-drama-studio` on the branch that contains `scripts/grokbot-native-tools/cli.mjs`.
2. Choose backend:
   - No credentials → omit `--live` (local store). Set `ADS_LOCAL_STORE` to a stable path under the bot store if you need persistence across agents.
   - Credentials available via vault/env file → `--live --env-file <path>`; for writes add `--execute` only after the user confirmed the write.
3. Map user intent:
   - “创建一部…短剧” → `create`
   - “有哪些项目 / 列表” → `list`
   - “继续昨天的 / 继续这个项目” → `continue` (pass `--project-id` if known)
   - “保存这段剧本 / 改这一段并保留历史” → `save-script` (prefer `--text-file` for long text)
   - “进度 / 阻塞 / 状态” → `status`
4. Run via Shell from repo root, for example:

```sh
node scripts/grokbot-native-tools/cli.mjs create \
  --title "雨夜站台" \
  --premise "两个陌生人在末班车误点后交换秘密" \
  --genre "悬疑" --audience "年轻观众" \
  --store "${ADS_LOCAL_STORE:-.grokbot-drama-store.json}"
```

5. Reply to the user with **title, project id (short), stage, blockers, next human step** — not raw cookie/CSRF dumps. Keep technical IDs in a short appendix if needed.
6. After `save-script`, remind that review APPROVE is still a **human** gate (local store marks DRAFT; live API uses existing review endpoints — do not forge APPROVE).
7. If the user asks for voice/video/export, point to `docs/GROKBOT_ORCHESTRATION.md` quote/progress commands and stop before paid calls until authorization exists.

## Install note

This file is the **repo draft**. To register it as a user skill in GrokBot Settings, the parent agent with `UpdateSkill` should `write` name `ai-drama-native-tools` using this body (or a trimmed copy). Executor subagents may lack `UpdateSkill`.
