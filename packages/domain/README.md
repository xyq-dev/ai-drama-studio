# @ai-drama/domain

The M1-B domain core owns the documented `GenerationJob` transition graph and derives
`WorkflowRun` status from child job states and criticality. Terminal jobs never reopen,
and completed runs containing cancellations preserve a `CANCELED` outcome instead of
being misclassified as critical failures.

The package stays independent of NestJS, PostgreSQL, Redis, and provider SDKs so API
and Worker code can share the same state rules.
