# M3 字幕与音乐工作台实现报告

## 范围

目录 `D:\Projects\ai-drama-studio`，分支 `feat/m3-subtitle-music-workbench`。起点是 `origin/feat/m3-av-workbench` 的 `3d3f759e17db4b8b294d4750bf2c1c33d37159d5`，其中包含补强验收 SHA `8b08c259e78a9925f13e48297d8e588cc8afe024`。工作区当时干净，因此没有另开 worktree。目标分支原先不存在。

本轮只做已批准且 CURRENT 的镜头上的 Mock 字幕和 Mock 音乐。输出是固定 `text/vtt` 与既有 100ms 静音 WAV，kind 为 `SUBTITLE` 和 `MUSIC`。它们不是真实字幕或音乐生成。没有改图片不写成本行的行为，没有新 Migration，没有改既有 fixture bytes 或 `infra/compose.yaml`。

## SHA

- 起点：`3d3f759e17db4b8b294d4750bf2c1c33d37159d5`
- 本轮真实通过的验收 SHA：`d17a0b9056761bb4e0eb24ba77391175a10ee9f2`
- 报告提交与该验收 SHA 分开。最终仓库 SHA 在报告 push 之后由 fetch 核对。

## 是否需要 Migration

不需要。`asset.kind` 已允许 `SUBTITLE` 和 `MUSIC`。`generation_job.kind` 没有限制这两类任务的检查约束。

## 行为

新增 `POST /api/v1/shot-revisions/:revisionId/generate-subtitle` 与 `generate-music`。请求仍是 `{ seed?: string }` 和 `Idempotency-Key`。202 只表示受理。

映射：

- `MEDIA_SUBTITLE` → `subtitle.generate` → `SUBTITLE` → `text/vtt`
- `MEDIA_MUSIC` → `audio.music` → `MUSIC` → `audio/wav`

字幕要求已保存的非空对白。音乐要求已保存的非空提示词。两者都沿用镜头、场景及依赖的审核与 CURRENT 门禁，并冻结已保存的 `sourceText`、`sourceHash`、`revisionId`、capability、seed 和同步执行模式。

独立开关 `M3_MOCK_SUBTITLE_MUSIC_ENABLED` 默认 false，production 强制关闭，并要求绝对 `MOCK_OBJECT_DIR`。它不改变图片开关或 AV 开关。`mock-sm:provision` 只补本 workspace 的 `subtitle.generate` 与 `audio.music`，幂等、无凭据，不在启动时自动执行。

成功时 Asset、Job 和 ACTUAL USD 0 在现有事务里一起保存。对象路径是 `mock-subtitles/` 与 `mock-music/`。已绑定请求的恢复只 inspect。关闭新开关后，原 attempt 以 `MOCK_MEDIA_NOT_CONFIGURED` 终结，视频仍可生成。手工媒体重试仍然拒绝。

镜头页有独立的 Mock 字幕和 Mock 音乐区块。字幕以纯文本预览。音乐使用独立 `<audio>`，不进入配音 AUDIO 列表。

## 本机命令

| 命令 | 结果 |
| --- | --- |
| `node --test scripts/m3-av-e2e/outcome.test.mjs` | exit 0，13 tests passed |
| `node --check` 与 `node scripts/m3-av-e2e/check.mjs` | exit 0 |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9。该次 verify 在阶段顺序修正之前；修正只改了 `outcome.mjs` 的阶段顺序，随后 outcome 测试与 harness check 再次 exit 0 |
| 本机 Docker | 没有 `docker` 命令。真实服务只在 Actions 上运行 |

## 通过的 CI

验收 SHA `d17a0b9056761bb4e0eb24ba77391175a10ee9f2`。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36818644095
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36818644095/job/110229175936
- Artifact：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36818644095/artifacts/11142488135 ，id `11142488135`，2195939 bytes，到期 2026-10-08

`results.json`：`ok` true，`fatal`、`cleanupError`、`restoreError` 都是 null。`outcome.missing` 与 `outcome.notPassed` 都是空。19 个必需阶段全部 passed，其中包括原有 AV 阶段和 `subtitle-music`、`subtitle-music-gates`、`subtitle-music-recovery`。

普通 push：`3bc1deb..d17a0b9`。`git fetch` 后该 SHA 与 `origin/feat/m3-subtitle-music-workbench` 一致。没有 force push、main、PR、merge。

## 账本与恢复

字幕 job `dd5ef219-0066-4a17-bc06-3385f38fa40f`，attempt `c1ef3d17-fbaf-4811-9950-41da998543b3`，asset `f2dd75d6-9212-4863-b1a1-2005440b22d5`，request `mock-media|sync|subtitle.generate|dd5ef219-0066-4a17-bc06-3385f38fa40f:1`，provider `2ff4c67d-7819-4791-b036-de36478506b4`，ACTUAL USD 0。

音乐 job `aed38db3-9eab-461c-9960-6bf773ea63c2`，attempt `ab13405c-905a-4c1d-9c37-889e377860ba`，asset `83e00bff-76ae-4fe5-bb90-656db2508b45`，request `mock-media|sync|audio.music|aed38db3-9eab-461c-9960-6bf773ea63c2:1`，provider `f84aa54d-2f6f-4fc0-8218-48622e5d61a7`。该阶段通过了同一套成本关联断言。`submitCallsMeasured` 为 false。

同源 VTT 正文等于固定 fixture，页面可见 `Mock subtitle`。音乐 WAV 为 1644 bytes、SHA-256 `c726d333dd159a31423f3480dbb1c5c4a9dfcd30efe1f7e12ade390dc92e8908`。HEAD body 为空，Range 仍返回 200。播放推进到 ended。

音乐恢复原 attempt `78366cc6-2ba5-406b-a6d3-1f35227aeacf` 的 `finishedAt` 是 `2026-10-01T05:15:20.443Z`，`error_json` 为 `MOCK_SM_OUTPUT_INVALID` 且 `retryable` false，无 Asset/cost。关闭新开关后，字幕原 attempt `0b2846eb-5e87-4eb7-a694-02fd7c07ba39` 的 `finishedAt` 是 `2026-10-01T05:16:22.679Z`，`error_json` 为 `MOCK_MEDIA_NOT_CONFIGURED` 且 `retryable` false。随后视频 job `e472a23a-f736-40e1-9a3a-9798d0fa6d38` 仍然成功。

默认关闭删除了 `M3_MOCK_SUBTITLE_MUSIC_ENABLED`，`unsetPresent` false。字幕和音乐都返回 `CONFIGURATION_ERROR`。显式 false 与 production 同样拒绝。MinIO 对象数保持 0。本地对象 8 个，包含 `mock-subtitles/` 与 `mock-music/`。

`viewport-390.png` 在视口仍为 390×844 时保存，455847 bytes，在上述 artifact 内。document/body/hash 溢出为 0。草稿仍是 `unsaved-draft-m3-av-e2e`。

## 同分支未通过的运行

`3bc1deb0a6933f45a8f80e3175520fb3445317aa` 的 Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36818299989 、Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36818299989/job/110228109851 结论 failure。必需阶段顺序把 `subtitle-music` 放在 `playback` 之后，harness 在调用时立即失败，`results.ok` 不是 true。这不是本轮通过。

## 尚未执行

- 字幕编辑、转写、混音、视频叠字幕、成片、真实 Provider、ComfyUI、真实模型。
- 图片任务补写成本行。
- 成本冲突、全部暂时故障与取消竞争、隐藏标签页、Windows 与其余 Compose 故障组合。
- 既有 integration 套件、新 Migration、DROP SCHEMA、应用 pack、部署、付费 Provider。
- 本机真实 PostgreSQL、Redis、MinIO、API、Worker、Web 和浏览器。
