# M3 同步 Mock 图片入账报告

## 范围

目录 `D:\Projects\ai-drama-studio`，分支 `fix/m3-mock-image-accounting`。起点是 `origin/feat/m3-subtitle-music-workbench` 的 `eb49f41908389ba603aea97745d836b4c984b2e9`，其中包含已验收源码 `d17a0b9056761bb4e0eb24ba77391175a10ee9f2`。fetch 后工作区干净，目标分支原先不存在，因此从该 feature HEAD 新建分支，没有 reset、clean、stash 或合并 main。

本轮只让新的同步 Mock 图片在同一事务里保存 IMAGE Asset、ACTUAL USD 0，以及 attempt、job、workflow 成功。API、`m3.mock.image.v1`、请求 ID `mock-media|image.generate|jobId:attemptNo` 和固定 PNG 保持不变。没有升级 snapshot，没有新开关，没有改通用 `Adapter.inspect` 的异步契约，也没有改 `assertSyncActualCost`。历史 `SUCCEEDED`、`FAILED`、`CANCELED` 任务不补账、不重开。

## SHA

- 起点：`eb49f41908389ba603aea97745d836b4c984b2e9`
- 本轮真实通过的验收 SHA：`1b01b0b684513ab63ae14430bcc39971d75f3782`
- 报告提交与该验收 SHA 分开。最终仓库 SHA 在报告 push 之后由 fetch 核对。

同一分支上先有一次失败运行，不能算通过：`91ceb7452b73e0193fda6a00334671b35923ead6`，run `36839764533`，job `110295807276`，artifact `11150936171`。失败点是字幕/音乐阶段的播放器计数 `player counts speech 2 music 2`。页面主栏本身也是 `section`，宽松定位器在配音和音乐元素都出现后把两个播放器同时算进两个频道。验收 SHA 改为只数标题所在的最近 `section`。这是 harness 计数，不是字幕/音乐产品行为。

## 是否需要 Migration

不需要。没有新 Migration，没有历史补账，没有 `DROP SCHEMA`。

## 行为与影响

正常 submit 只接受真实 receipt 上的一条 ACTUAL：`provider=mock-media`、`model=mock-v1`、`component=request`、`usage.requests=1`，幂等键为 `${providerRequestId}:request:actual`，USD 0、一个 request、零单价，且没有 supersedes。缺字段或值不对时拒绝，不自行写成零成本。

恢复传入数据库冻结的 `inputSnapshot`。只接受合法 `m3.mock.image.v1`、`outcome=success`、`shotRevisionId` 一致、且没有 `executionMode` 或其他额外字段的固定图片任务。只有当恢复 receipt 的 `supersedesEstimateKey` 正好是 `${providerRequestId}:request:estimated` 时，才构造一条不含该字段的候选成本。原始 observation、`responseHash`、`normalizedEventKey` 先写入 ProviderEvent。其他引用、错 provider/model/key、额外成本行、非 ACTUAL 或非零金额都拒绝。

`MediaAssetStore.completeAttemptWithAsset` 在已有的 job/最新 attempt 锁内，仅当 `kind=IMAGE` 且传入 `actualCost` 时重读并核验 MEDIA_IMAGE、workspace/project/job/attempt/source revision、`mock-media/image.generate`、两份 snapshot 一致且为合法 v1、`provider_client_request_key` 与 `providerRequestId`。当前 attempt 或同一 provider request 上的任何 ESTIMATED 行，以及同一 provider scope 里被占用的预期 estimated key，都会 `COST_CONFLICT` 并回滚 Asset、成功状态和成功事件。已有完全一致的 ACTUAL 键可以重放；不一致同样回滚。不删除、不覆盖旧账本。磁盘文件不算 Asset 成功。此前独立写入的 ProviderEvent 可以留下。

图片普通执行复用 `classifyMediaFailure`。`COST_CONFLICT` 和确定性 accounting 错误使原 attempt 永久失败。磁盘、数据库暂时错误和 `STALE_RECALCULATION_PENDING` 保留已绑定 attempt/request。`JOB_TERMINAL` 与 `ATTEMPT_SUPERSEDED` 不改旧终态或较新 attempt。恢复只 inspect。

字幕/音乐迟到用例改为真正返回迟到 202，并等旧请求完成后再断言。Mock 字幕/音乐恢复的 submit spy 改为监视传入恢复函数的实例。没有改这两类产品 UI。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`，没有关闭 engine 检查。

| 命令 | 结果 |
| --- | --- |
| `pnpm m3-av-e2e:check` | exit 0 |
| `pnpm m3-av-e2e:outcome` | exit 0，13 tests passed |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9 |

`pnpm verify` 的 web 测试仍会打印模拟 API 的 `ECONNREFUSED 127.0.0.1:3000` / `::1:3000`，61 个测试通过。本机没有 `DATABASE_URL`，也没有 Docker，因此没有执行会连接 PostgreSQL 的 integration 套件。那些套件里的图片守卫用例留在仓库中，本轮真实库证据来自下面的 Actions 运行。

## 真实 CI

验收 SHA `1b01b0b684513ab63ae14430bcc39971d75f3782`。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36840396896
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36840396896/job/110297895142 （`110297895142`，success）
- Artifact：`m3-image-accounting-e2e-evidence`，id `11150558958`，2210945 bytes，expires `2026-10-08T09:13:20Z`
- `results.ok=true`，fatal、cleanupError、restoreError 均为 null，compose down 成功
- 21 个必需阶段全部 passed。原有 19 个阶段仍在，并增加 `image-recovery` 与 `image-cost-guard`
- 新建库 `m3av_36840396896a1`，迁移前 public table count 0，只应用既有 migration。MinIO 对象数保持 0
- `viewport-390.png` 457613 bytes，视口 390×844，横向溢出 0，未保存草稿 `unsaved-draft-m3-av-e2e`

### 页面图片成本

Job `0e52c995-f8d9-4c71-a78f-608c99910179`，attempt `8d0a6087-0bab-4a2a-8457-e100f0db75d2`，request `mock-media|image.generate|0e52c995-f8d9-4c71-a78f-608c99910179:1`，asset `03cde5c0-2764-4c19-b8bb-9b176e9aa2c7`，cost `e924c5ea-ecab-40fe-a0b9-e1580989229c`。ACTUAL USD `0.00000000`，model `mock-v1`，幂等键以 `:request:actual` 结尾，`supersedes_estimate_key` 与 `supersedes_cost_id` 都是 null。页面 PNG 解码为 1×1。`finishedAt` `2026-10-01T09:06:46.831Z`。

AV 关闭后的新图片同样有一条零元 ACTUAL：job `707114b3-4cd8-47c5-b296-36e5a3313a90`，attempt `ad387c54-4f27-483a-b524-bd5cef3fad19`，asset `c212d31a-41a0-4c84-b90a-d4576cef5728`，cost `fc358822-259f-48d3-b317-b6e7e42d12ff`。

### 目录失败后的同一次恢复

Job `3a6729f3-8f95-46a9-89cc-3bd9c5435858`。写失败时绑定的 attempt `e897ad02-8d4f-42ed-9764-6801d694a5bc` 与 request `mock-media|image.generate|3a6729f3-8f95-46a9-89cc-3bd9c5435858:1` 在停止并重启 Worker、恢复目录、等待租约之后仍然是这一条。成功后 asset `1d509765-d8fe-4c1c-a855-541b6317c4d4`，cost `0eefdcb1-9651-4233-b3f2-6d182b2b1d29`，同样是一条 ACTUAL USD 0，无估算、无 supersession。内容 GET 为 PNG 签名，69 bytes。`finishedAt` `2026-10-01T09:12:13.805Z`。attempt 数保持 1。这次证据没有测量 adapter submit 调用次数，因此不把“没有再次 submit”说成已在真实进程里计数。

### 冲突回滚

三条负例都在本次新建库插入 `model=m3-image-accounting-negative` 的账本行。恢复后原行 id、kind、金额、幂等键和 model 未变；没有新 Asset，没有 `job.succeeded`；原 attempt 以 `MOCK_IMAGE_OUTPUT_INVALID`、`retryable=false` 永久失败。

- 其他 key 的 ESTIMATED：job `83d4b2c2-9bb8-47c6-8510-3079ef425b49`，attempt `83b0d7a4-653f-4307-b04c-ad7cc17ceb02`，账本 `c1d295f3-84e3-4487-8c1b-121a32d2cfd5`
- 预期 estimated key 被占用：job `54a4fced-8f61-42eb-899f-f6b95638850e`，attempt `2a65f550-085b-4fe3-a6f7-1fb8c2db3fc0`，账本 `091310e4-633f-48ad-910c-03216dc3a47b`
- 同一 actual key 金额冲突：job `408d8639-61d0-48f0-bc91-05ccc4cb55b8`，attempt `c6c2a453-045e-40d2-b2cf-9681060bf137`，账本 `b04a3d88-e884-48e4-80b4-2ae17d5f4a02`

## 历史兼容

恢复只处理租约已过期且仍为 `RUNNING` 的媒体任务。`SUCCEEDED` 的图片不会进入这条路径，完成事务在终态检查时直接 `JOB_TERMINAL`，守卫和入账都不会执行。因此已成功但没有成本行的历史图片保持原样。本轮验收库是新建空库，没有旧的终态图片可补。

通用 delayed 路径仍由 `MockMediaAdapter.inspect` 返回估算替代引用，`assertSyncActualCost` 继续拒绝带 supersedes 的成本。视频、配音、字幕、音乐的同步入账路径没有改执行语义，本轮 19 个原阶段在同一运行里通过。

## 未执行

本机 Docker 不存在，没有在本机跑真实页面闭环。没有新 Migration、历史补账、`DROP SCHEMA`、生产数据、付费 Provider、ComfyUI、成片或部署。没有向 main push，没有 force push，没有开 PR 或 merge。

## 推送核对

实现提交 `91ceb7452b73e0193fda6a00334671b35923ead6` 与验收提交 `1b01b0b684513ab63ae14430bcc39971d75f3782` 已普通 push 到 `origin/fix/m3-mock-image-accounting`。报告提交的 fetch 核对写在该提交之后。
