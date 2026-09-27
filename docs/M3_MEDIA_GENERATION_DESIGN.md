# M3 Media Generation Design

## Objective

M3 turns an approved, non-STALE ShotRevision into auditable media assets without coupling Core to ComfyUI or any commercial provider.

The orchestration truth remains PostgreSQL. Queue state and provider state are observations, not authoritative workflow state.

## Capability model

Adapters expose capabilities rather than vendor-specific APIs:

- `image.generate`
- `video.generate`
- `audio.tts`
- `audio.music`
- `subtitle.generate`
- `media.compose_input_validate`

Each request carries:

- workspaceId
- projectId
- shotRevisionId when shot-scoped
- generationJobId / jobAttemptId
- providerConfigurationId
- deterministic clientRequestKey
- canonical input snapshot/hash
- traceId

Each adapter returns one normalized outcome:

- `SUCCEEDED` with output descriptors
- `WAITING_EXTERNAL` with providerRequestId and nextPollAt
- `FAILED` with retryable/error code
- `CANCELED`

Provider-specific payloads stay behind the adapter boundary.

## Asset model

Add an immutable `asset` record for every durable media output.

Required fields:

- id, workspaceId, projectId
- kind: IMAGE | VIDEO | AUDIO | SUBTITLE | MUSIC | COMPOSITE
- storageProvider + objectKey
- mimeType
- byteSize
- checksumSha256
- width/height where applicable
- durationMs where applicable
- sourceJobAttemptId
- sourceShotRevisionId nullable for project-level assets
- providerConfigurationId
- providerRequestId
- metadataJson
- createdAt

Asset content is immutable. Corrections create a new Asset and update explicit current/approved pointers at the owning aggregate where needed.

## Provider callbacks and polling

Every external observation is persisted to `provider_event` before business state changes.

Deduplication key:

`providerConfigurationId + providerRequestId + normalizedEventKey`

Normalized event keys must be deterministic and provider-specific adapters must map raw callbacks/polls to stable normalized states.

Late callback rules:

1. Never reopen terminal JobAttempt/GenerationJob state.
2. Persist the observation when it is new.
3. Mark it ignored in normalized metadata when business state has already advanced.
4. Never create duplicate Asset or CostLedger entries from a duplicate event.

## Cost accounting

Every provider attempt may produce estimated and/or actual cost records.

Rules:

- deterministic cost idempotency key per provider request + cost component
- explicit unit/currency
- `estimated=true` until provider actual usage is known
- later actual usage supersedes estimate by lineage, never by destructive overwrite
- duplicate callbacks/polls cannot duplicate cost
- project/job/attempt lineage must remain internally consistent

## ComfyUI boundary

Core never imports ComfyUI workflow internals.

`services/comfyui-adapter` owns:

- workflow template selection
- node/workflow payload construction
- ComfyUI submit/poll/cancel
- output discovery
- raw provider response normalization

Core sees only the normalized media adapter contract.

## Object storage

M3 stores durable outputs through the configured S3/MinIO boundary.

Before an Asset becomes usable:

1. object exists
2. checksum is computed and stored
3. MIME type is verified
4. image/video/audio metadata is probed
5. size/duration/dimensions satisfy capability rules

Temporary provider objects are not Assets until validation succeeds.

## Shot input gate

A media request is accepted only when:

- ShotRevision is current
- ShotRevision reviewStatus = APPROVED
- ShotRevision freshnessStatus = CURRENT
- referenced Scene/Character dependencies still satisfy M2 approval gates

If the shot becomes STALE while media generation is running, the JobAttempt may finish for audit purposes but the resulting Asset cannot become a valid current production input.

## Recovery

M3 reuses the M1 lease/outbox model.

Recovery sequence:

1. inspect persisted JobAttempt
2. if a providerRequestId exists, audit poll observation first
3. reconcile normalized provider state
4. retry only under provider/job retry policy
5. never blind-resubmit an external request with an existing providerRequestId

## First implementation slices

### M3-A — contracts + schema

- media adapter contract
- Asset schema
- media/cost lineage constraints
- callback dedupe contract
- Mock media adapter

### M3-B — image vertical slice

- POST image generation for approved shot
- Mock sync + async path
- Asset validation/storage
- retry/cancel
- callback/poll tests

### M3-C — video/audio/subtitle/music

Reuse the same orchestration semantics and add capability-specific validation.

### M3-D — ComfyUI adapter

Only after Mock acceptance is green. No production GPU or paid provider activation is required for M3 code acceptance.

## Acceptance gate

M3 is complete when a single approved shot can execute through Mock and, when authorized, ComfyUI/commercial adapters with:

- complete JobAttempt audit
- ProviderEvent history
- validated immutable Assets
- idempotent cost accounting
- duplicate/late callback safety
- timeout/cancel/retry recovery
- no cross-shot corruption
