# M4 单镜真实合成报告

## 结论

本轮单镜真实合成闭环已经完成：已通过的单镜预检可以提交合成，服务端重新校验并冻结输入，返回 202，由 Worker 调用 Python 与真实 FFmpeg 产出 1080×1920 的 `COMPOSITE`/`DRAFT`，同源页面可以播放，并可以批准或退回。

这不是完整 M4，不是真实 AI 生成，也不是生产就绪。本地编码成本没有计量。没有做生产分发许可验收。

## 现场

目录 `D:\Projects\ai-drama-studio`。来源分支 `feat/m4-compose-preflight` 的 HEAD 是 `4b67d6a6ad11382c16a80e525859aaab8e379ecd`，与当时的 `origin/feat/m4-compose-preflight` 一致。已验收源码是 `9e457e4962839915fb19eddc6b77020c5a0d9c02`。目标分支 `feat/m4-single-shot-render` 从该来源 HEAD 创建。开始时工作区干净，没有未提交修改需要保留，也没有 reset、clean、stash、覆盖或自动合并。

`origin/feat/m4-compose-preflight` 仍是 `4b67d6a6ad11382c16a80e525859aaab8e379ecd`。`origin/feat/m3-lifecycle-acceptance` 仍是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。

- 实际验收 SHA：`e3cd939171bae75350cb6825ff432c27805974c5`
- 报告提交与该验收 SHA 分开。报告 SHA 是包含本文件的提交，push 后与 `origin/feat/m4-single-shot-render` 核对。

## 修改原因与范围

在已有 M4-A 预检上增加单镜本地合成。新增 `MEDIA_COMPOSE` 任务、`local-ffmpeg-v1` 渲染、`COMPOSITE`/`LOCAL_JOB` 落盘、同源内容读取和成片审核。`M4_LOCAL_COMPOSE_ENABLED` 默认 false，production 强制关闭。原始 Mock 媒体保持 `DRAFT`，只有 `COMPOSITE` 进入本轮审核。

相对来源 HEAD，35 个文件，+2422/−18。主要范围：

- `packages/domain/src/compose-render.ts`：严格请求、固定渲染策略和任务快照。`input_hash` 只覆盖服务端生成的 `input`。
- `packages/database/src/media-assets.ts`、`job-service.ts`、`runtime-store.ts`：冻结输入、本地成片提交、审核、租约续期，以及禁止 `MEDIA_COMPOSE` 手工 retry。
- `apps/api`：`POST /shot-revisions/:revisionId/compose`、`POST /assets/:assetId/review`，以及 COMPOSITE 内容校验。
- `apps/worker`：独立 compose 分发与执行。不走 `mock.generate`。
- `services/media-worker`：`python -m media_worker.compose_cli`。既有 HTTP health 进程仍是 stub，不承担渲染。
- `apps/web`：预检通过后才能开始合成，并展示任务、播放和审核。
- `scripts/m3-av-e2e` 与 `.github/workflows/m4-single-shot-render-e2e.yml`：原 28 个阶段保留，新增 5 个阶段。
- `.env.example`、`docs/API_CONTRACT.md`、`services/media-worker/README.md`。

没有改 Prisma schema、migration、数据库约束、Provider 记账、固定 fixture 或原 Mock 内容校验。没有多镜时间线、整集导出、真实 Provider、ComfyUI 或付费调用。

## Migration

Migration=NO。没有新 Migration，没有改既有 migration、Prisma schema、触发器或约束。CI 只在身份核实且迁移前 `public_tables=0` 的新建隔离库上应用既有 migration。没有 `DROP SCHEMA`。

## Python、FFmpeg 与字体

记录来自通过的 CI 运行，不是未记录的 latest。没有完成生产分发许可验收。

| 项目 | 记录 |
| --- | --- |
| Python | 3.12.3。渲染测试在 venv 中使用 pytest 9.1.1 |
| FFmpeg / ffprobe | 6.1.1-3ubuntu5，gcc 13（Ubuntu 13.2.0-23ubuntu3） |
| libavcodec | 60.31.102 |
| libx264 | 2:0.164.3108+git31e19f9-1 |
| 构建 | `--enable-gpl`、`--enable-libx264`、`--enable-libass`、`--enable-libfreetype`、`--enable-libfontconfig` |
| 字体 | `fonts-dejavu-core` 2.37-8，`/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` |
| 字体 SHA-256 | `ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280` |

固定策略 `local-ffmpeg-v1` 写入任务输入并参与 `input_hash`：1080×1920、25fps、MP4、libx264、yuv420p、CRF 23、veryfast、faststart、居中黑边、SAR=1。配音增益 1，音乐增益 0.25，超长截断、不足补静音、不循环。字幕只按纯文本烧录。字体样式版本 `m4-subtitle-style-v1`。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`。本机没有 Docker，因此没有执行 `scripts/m3-av-e2e/run.mjs`。既有会 `DROP SCHEMA` 的 integration 套件没有执行。

| 命令 | 结果 |
| --- | --- |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9。domain 32、api 19、worker 50、web 66。Web 测试仍打印 `ECONNREFUSED 127.0.0.1:3000` 并通过 |
| `node scripts/run-media-worker-tests.mjs` | 含在 verify 末尾，3 passed |
| `pnpm m3-av-e2e:check` | exit 0 |
| `node scripts/m3-av-e2e/run.mjs` | 本机未执行 |
| 既有 DROP SCHEMA integration | 未执行 |

## Actions

通过运行的 head SHA 是 `e3cd939171bae75350cb6825ff432c27805974c5`。

- Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36910806772
- Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36910806772/job/110532687660 ，id `110532687660`，结论 success
- Artifact `m4-single-shot-render-e2e-evidence` id `11186788127`，4897132 字节，SHA-256 `5b10dc9cfe65f056683cdf1b03b3b956a0c820a566cbfbeb903985896081577f`，expires `2026-10-08T19:13:41Z`
- 下载后的 zip 与上述 SHA-256 一致。`results.ok=true`，`outcome.ok=true`，missing 与 notPassed 为空。没有 fatal、restore、cleanup 或 compose down 失败。
- Chrome `154.0.8037.92`。数据库 `m3av_36910806772a1`，迁移前 public 表数 0。MinIO 对象数 0。
- venv `pytest services/media-worker/tests`：4 passed，1 warning。`node scripts/run-media-worker-tests.mjs`：3 passed。

## 33 个阶段

全部 passed：

`docker`，`compose`，`identity`，`migrate-provision`，`processes`，`source-chain`，`page-submit`，`subtitle-music`，`playback`，`content-headers`，`png-draft-viewport`，`idempotency-retry`，`revision-history`，`gates`，`subtitle-music-gates`，`mock-boundary`，`subtitle-music-recovery`，`recovery-disk`，`recovery-flag`，`image-recovery`，`image-cost-guard`，`media-cancel`，`media-terminal-race`，`media-observation-replay`，`media-shot-isolation`，`compose-preflight-page`，`compose-preflight-gates`，`compose-preflight-readonly`，`compose-render-page`，`compose-render-gates`，`compose-render-lifecycle`，`compose-review`，`compose-provenance-stale`。

### 成片播放

`compose-render-page` 的资产 `d7c540ee-8d9d-429f-8a79-100bd133dd61`，任务 `b1a0d375-ed9b-43fb-9fb0-01e760577fb0`。播放证据：1080×1920，解码帧成功，画面亮像素 9501，播放进度 0.212613 秒，`ended=true`，390px 横向溢出 0。内容读取仍是完整 200；没有宣称 206。

### 门禁

`compose-render-gates`：错误 hash、额外字段、错误素材、来源变化、默认关闭、production、未设置和跨 workspace 都拒绝，且被拒绝的创建没有新增业务行。同键重放任务 `bb5390d7-1d2e-4554-a0b1-8b00e1f49304` 仍是 `SUCCEEDED`，没有第二个任务。

### 取消与恢复

`compose-render-lifecycle` 的时序证据边界：`M4_COMPOSE_HOLD_BEFORE_COMMIT_MS` 只让 attempt 1 在文件发布之后、`commitLocalCompose` 之前停住，并且不续租。大于 30 秒租约时，恢复可以排队新 attempt；迟到提交被丢弃，不能失败新 attempt。

- 迟到恢复：任务 `454d059b-25d7-47ff-a15d-39009662369e`，2 个 attempt，成片挂在最新 attempt `a8b4892d-ba1a-4654-b01a-e49c0a695146`。
- 取消先提交：任务 `3c68a8f8-ba0e-4b42-b982-a2c848a4df0f` 为 `CANCELED`。
- 成功先提交后再取消：`JOB_TERMINAL`。
- 生成期间来源失效：任务 `9571e3b8-0713-4dd6-908b-2b8e190566ac` 失败码 `REVIEW_REQUIRED`，没有成片。
- 缺少输入文件：`COMPOSE_RENDER_FAILED`，没有半成品资产。

### 审核

`compose-review`：批准结果 `APPROVED`，退回结果 `REJECTED`，并发决策只留下 `APPROVED`。原始媒体、已决状态和失效来源都被拒绝。审核不改成片字节。

### STALE

`compose-provenance-stale` 使用真实镜头修订接口。资产 `d7c540ee-8d9d-429f-8a79-100bd133dd61` 变为 `STALE`，审核状态仍是 `APPROVED`。依赖边为 4 条素材边和 3 条 revision 边。页面上该卡显示历史成片，不再显示当前有效。未保存草稿仍在。

## 遗留边界

本地编码成本尚未计量，没有为 `MEDIA_COMPOSE` 写入虚构的 Provider `ACTUAL` USD 0。原有五类 Mock 媒体成本逻辑不变。

产物自己的未执行项：尚未覆盖的其他媒体组合成成本冲突（图片成本冲突已由 `image-cost-guard` 通过）；其余未在本轮触发的暂时故障组合；隐藏标签页；Windows 与其余未在本轮触发的 Compose 故障组合；既有会 `DROP SCHEMA` 的 integration 套件；新 Migration、全库重置、main、force push、PR、merge、应用 pack、部署、付费 Provider、ComfyUI、真实模型。

本轮只完成单镜、最长 90 秒、现有 M3 LocalMockObjects、一条 VIDEO 加选配 AUDIO/MUSIC/SUBTITLE、Linux 开发与隔离 CI 上的真实合成闭环。
