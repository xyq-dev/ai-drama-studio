# Provider 契约（接口草案，非实现）

## 共同语义

Provider 只实现能力，不接触领域表。Adapter 将领域输入映射到 Provider 请求，并把响应标准化；业务表保存 `providerKey`、能力、参数快照和请求 ID，不保存厂商特有列。`submit` 可同步返回结果，也可返回远程 request id；异步结果经 `query` 或 API 回调到达。所有 Adapter 必须传递 `idempotencyKey`，在安全的情况下实现 cancel，并将未知状态明确为 `UNKNOWN` 而非猜测失败。

标准错误为：`VALIDATION`、`AUTH`、`POLICY`、`QUOTA`、`RATE_LIMITED`、`TIMEOUT`、`TEMPORARY`、`UNAVAILABLE`、`CANCELED`、`REMOTE_FAILED`、`UNKNOWN`；字段含 `retryable`、`providerCode`、安全 `message` 和 `retryAfterMs?`。耗时和货币金额以 Provider 实际回执为准，估算值必须标为 `estimated`。

```ts
export type ProviderCapability = 'text' | 'image' | 'video' | 'speech' | 'music' | 'render';
export type ProviderStatus = 'SUCCEEDED' | 'RUNNING' | 'WAITING_EXTERNAL' | 'FAILED' | 'CANCELED' | 'UNKNOWN';
export interface ProviderError { code: string; providerCode?: string; message: string; retryable: boolean; retryAfterMs?: number; }
export interface ProviderCost { amount: string; currency: string; estimated: boolean; units?: Record<string, number>; }
export interface SubmitContext { jobId: string; attemptId: string; idempotencyKey: string; timeoutMs: number; callbackUrl?: string; callbackSecretRef?: string; }
export interface ProviderResult<T> { status: ProviderStatus; providerRequestId?: string; output?: T; progress?: number; error?: ProviderError; cost?: ProviderCost; rawResponseRef?: string; }
export interface CapabilityDescriptor { capability: ProviderCapability; providerKey: string; parameterSchema: object; supportsCallback: boolean; supportsCancel: boolean; supportsSeed: boolean; outputConstraints: object; }
export interface AsyncProvider<I, O> { discoverCapabilities(): Promise<CapabilityDescriptor[]>; submit(input: I, context: SubmitContext): Promise<ProviderResult<O>>; query(providerRequestId: string, context: Pick<SubmitContext, 'timeoutMs'>): Promise<ProviderResult<O>>; cancel(providerRequestId: string, context: Pick<SubmitContext, 'timeoutMs'>): Promise<ProviderResult<never>>; }
```

## 能力接口草案

```ts
export interface TextRequest { prompt: string; systemPrompt?: string; model?: string; temperature?: number; maxTokens?: number; responseSchema?: object; }
export interface ImageRequest { prompt: string; negativePrompt?: string; model?: string; width: number; height: number; seed?: string; referenceAssetIds?: string[]; }
export interface VideoRequest { prompt: string; model?: string; width: number; height: number; durationSeconds: number; seed?: string; sourceImageAssetId?: string; referenceAssetIds?: string[]; camera?: object; }
export interface SpeechRequest { text: string; voice: object; language: string; speed?: number; }
export interface MusicRequest { prompt: string; durationSeconds: number; loop?: boolean; }
export interface RenderRequest { timelineAssetIds: string[]; subtitleAssetId?: string; width: 1080; height: 1920; format: 'mp4'; }
export interface MediaOutput { assets: Array<{ uri: string; mimeType: string; contentHash?: string; durationSeconds?: number }>; metadata?: object; }
export interface TextProvider extends AsyncProvider<TextRequest, { text: string; structured?: object }> {}
export interface ImageProvider extends AsyncProvider<ImageRequest, MediaOutput> {}
export interface VideoProvider extends AsyncProvider<VideoRequest, MediaOutput> {}
export interface SpeechProvider extends AsyncProvider<SpeechRequest, MediaOutput> {}
export interface MusicProvider extends AsyncProvider<MusicRequest, MediaOutput> {}
export interface RenderProvider extends AsyncProvider<RenderRequest, MediaOutput> {}
```

## Adapter 类型

- **Mock Provider**：确定性、无外部网络；按 inputHash 生成可预测的状态/测试资产引用，支持故障脚本和回调重复测试，不能伪装真实成本。
- **Local ComfyUI Provider**：通过独立 HTTP API 提交经批准的工作流模板、传入参数和可选 seed；保存 ComfyUI prompt/workflow id，轮询历史/输出；不连接 Core 数据库，不执行任意用户工作流 JSON。
- **Commercial API Provider**：将能力 schema 映射为厂商 API，使用密钥引用、厂商请求幂等键、签名回调和查询兜底；模型名属于 Adapter 配置/参数快照，非 Project/Shot 数据列。

Adapter 必须设置每能力 submit/query/cancel 超时，不可丢弃原始安全响应（加密/受限引用保存）；回调验证是 API 责任，Adapter 负责解析。Provider 配置停用后，已有远程任务仍可 query/cancel，新的 submit 被拒绝。

## 审查后安全与归一化补充（本节优先）

ProviderConfiguration 的 API DTO 只能返回 `id, provider, enabled, capabilities, model policy, timeout/retry policy, secretConfigured`；`encrypted_credential_ref`、API key、webhook secret 与原始 Provider header 永不返回。数据库只保存加密 secret 引用或密钥管理器引用，运行时解密仅限 Adapter 进程。Adapter 将原始响应作脱敏后、加密且访问受限的审计引用保存；不得把 token、签名或可下载的长期 URL 写入 Job、Asset 或日志。

厂商无关的持久化字段固定为 `provider, model, providerRequestId, externalStatus, capabilities, outputAssets, normalizedError, usage, estimatedCost, actualCost`。不得新增 `doubaoTaskId`、`klingVideoUrl`、`openaiImageId`、`wanStatus` 等厂商列。`MediaOutput.assets` 是 Adapter 到受控下载/上传管线的短寿命内部交接，而非最终业务 URL；Core 校验并创建含 `storageKey` 的 Asset。所有 input asset ID 在调用前解析为内容 SHA-256 并进入 inputHash。

同步 Provider 的 `submit` 可返回终态输出；异步 Provider 返回 request id 与 `WAITING_EXTERNAL`，必须实现 `query`，可取消时实现 `cancel`，回调时由 API 使用每个配置的 webhook secret 验签、限流和去重。能力发现返回可用模型、输入/输出限制及参数 schema，Adapter 在 submit 前验证 schema。Mock Provider 与相同接口运行，支持同步、异步、重复回调、可重试/不可重试错误和可控 usage；它不声称真实成本或媒体质量。业务模块只依赖 contracts 包，不能直接导入厂商 SDK。
