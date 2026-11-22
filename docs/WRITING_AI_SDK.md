# Writing AI SDK adapters

Vercel AI SDK packages (`ai`, `@ai-sdk/alibaba`, `@ai-sdk/deepseek`) are dependencies of `packages/providers` only. They are not imported by `apps/web`.

- Bailian writing uses `qwen-plus` through `bailian.ai-sdk.v1`. The client is created with base URL `https://dashscope.aliyuncs.com/compatible-mode/v1`. The SDK default international host is not used. There is no Token Plan and no Vercel AI Gateway.
- DeepSeek feature-config runs use `deepseek.ai-sdk.v1` and the official host `https://api.deepseek.com`. Runs still marked `deepseek.chat-completions.v1` keep the existing HTTP adapter. Unmarked historical DeepSeek runs stay legacy and are not sent.
- Historical `qwen` tasks stay readable. They reserve nothing and send nothing.
- `sendAiSdkWriting` sets `maxRetries` to 0. A timeout or an unclear result is `unknown` and is not sent again.
- The admin probe default remains `networkRefusingFeatureProbe()`. These adapters are for writing tasks, not for the probe.
- Postgres cannot store `provider_key = 'bailian'` until `packages/database/prisma/drafts/20261122000100_writing_provider_bailian.sql` is authorized, copied into `prisma/migrations`, and applied with `--only`. Do not execute that draft as part of a normal migrate.
