# @ai-drama/domain

The M1-B domain core owns the documented `GenerationJob` transition graph and derives
`WorkflowRun` status from its child jobs. It remains independent of NestJS, PostgreSQL,
Redis, and provider SDKs so API and Worker code use the same rules.
