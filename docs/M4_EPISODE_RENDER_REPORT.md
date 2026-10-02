# M4-C2 集级多镜真实合成

本报告只覆盖「预检通过后的集级硬切合成、同源播放、审核和上游失效后的历史成片」。它不表示完整 M4，也不表示生产就绪。

## 目录与提交

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio` |
| 目标分支 | `feat/m4-episode-render` |
| 起点 | `d127a344570224bad8a685121759ad3fc60c406b` |
| 验收 SHA | `58edf8d00c00f113d5af8f3a259b0a89ee2e304c` |
| 报告 SHA | 本文件提交之后单独记录 |
| Migration | NO |

起点来自已核实的 `feat/m4-episode-compose-preflight` HEAD，其中包含验收源码 `b6c5ca148f6daa7ad4cb895c8c9fbb5221685f41`。目标分支此前不存在，从该 HEAD 创建。`main` 与来源分支没有被本轮修改。

## 修改原因与范围

C1 只做集级预检。本轮把通过的预检提交成一个 `MEDIA_COMPOSE` 任务，由 Worker 用真实 FFmpeg 按选定顺序硬切，写出集级 `COMPOSITE` / `DRAFT`，供同源播放、批准或退回；上游失效后保留历史 `STALE` 成片和原来的审核状态。

没有新增 migration，没有改单镜 schema / profile，没有改 M2 草稿、If-Match、媒体生成或通用任务状态机。Job 与 Asset 的 `sourceShotRevisionId` 均为 null。

关键文件：

- `packages/domain/src/episode-compose-render.ts`
- `packages/database/src/media-assets.ts`
- `apps/api/src/studio/studio.service.ts`
- `apps/api/src/studio/studio.controller.ts`
- `apps/worker/src/runtime/compose-job.ts`
- `apps/worker/src/runtime/start-runtime.ts`
- `services/media-worker/src/media_worker/episode_compose.py`
- `apps/web/src/components/episode-compose-job-panel.tsx`
- `scripts/m3-av-e2e/episode-render.mjs`
- `.github/workflows/m4-episode-render-e2e.yml`

契约：

- Job snapshot：`m4.episode.compose.v1`
- Asset metadata：`m4.episode.compose.asset.v1`
- Render profile：`local-ffmpeg-episode-v1`

开关 `M4_LOCAL_EPISODE_COMPOSE_ENABLED` 默认 false，production 强制关闭，并且同时要求 `M4_LOCAL_COMPOSE_ENABLED`。单镜合成不依赖这个新开关。

## 已实现与未实现

已实现：同一 workspace、project、episode 内，2–30 个不同镜头的已批准 ACTIVE 单镜成片，按用户顺序整段硬切，总时长不超过 90000ms。少于 60000ms 仍可提交，并保留原有目标时长提示。可以只选本集部分镜头。各段已混好的音轨和烧入字幕原样保留。输出为 1080×1920、25fps、H.264、AAC、MP4 faststart，单段和输出都限制 64MiB。本地编码成本继续未计量。

未实现：转场、裁剪、倍速、循环、重新混音、重新烧字幕、跨集拼接、集级成片嵌套、真实 Provider、ComfyUI、批量三集交付、导出包、平台发布。

## 本地命令

这些是模拟或本机检查，不是隔离 CI 联调。Web 单测使用 happy-dom，会打印 `ECONNREFUSED 127.0.0.1:3000`，测试仍然通过。本机没有 Docker，没有运行 `scripts/m3-av-e2e/run.mjs`。

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm typecheck` | 0 | 工作区类型检查 |
| domain / API / web / worker 定向测试 | 0 | schema、哈希、服务门禁、丢响应重试、路径与哈希拒绝 |
| `python -m pytest services/media-worker/tests/test_episode_compose.py` | 0 | 真实 FFmpeg，3 passed。用测试颜色和不等时长片段，未改产品 Mock fixture |
| `pnpm m3-av-e2e:check` | 0 | 42 阶段 harness 与 workflow 断言 |
| `pnpm m3-av-e2e:outcome` | 0 | 第一次因 last-15 断言少了一项失败，修正后 23 passed |
| `pnpm verify` | 0 | lint、typecheck、test、build，以及 media-worker 脚本 |
| `node scripts/run-media-worker-tests.mjs` | 0 | 7 passed，2 skipped。skipped 仍是既有单镜用例 |

## 隔离 CI

真实验收只认成功 attempt 的 head SHA `58edf8d00c00f113d5af8f3a259b0a89ee2e304c`。

| 项 | 值 |
| --- | --- |
| 成功 Run | https://github.com/xyq-dev/ai-drama-studio/actions/runs/36974211083 |
| Run ID | `36974211083`，attempt 2 |
| Job | `110738805691` |
| Artifact | `11213732938`，`m4-episode-render-e2e-evidence` |
| 大小 | 4379146 bytes |
| 下载 SHA-256 | `f18b56ef8835523ed78b153b0e5257f112811e822b79aac4d1e9d1cd73a21f3d` |

失败运行保留：

- Run `36972531573`，Job `110729336316`，head `1a4939d653e033ae872b93e9243773f840cdeaa5`。`episode-render-stale` 把成片记录误传给场景替换，读取了不存在的 `sceneId`。随后的修复提交是 `58edf8d`。
- Run `36974211083` attempt 1。既有 `compose-render-lifecycle` 在杀掉 Worker 前没有看到单镜 renderer 进程树。attempt 2 原 SHA 重跑后该阶段通过，没有为此放宽断言。

42 个必需阶段全部 `passed`。`fatal`、`restoreError`、`cleanupError` 均为空。`compose down` 退出码 0。`results.ok` 为 true。

## 关键证据

门禁：错误哈希、额外字段、DRAFT、STALE、跨集和另一 workspace 都没有新增集级合成 Job。开关 false、未设置和 production 返回配置错误。新开关关闭时，单镜任务 `2cb1a340-f4aa-4870-ae2b-783f9b14246c` 仍然 `SUCCEEDED`。同键重放的集级任务是 `63ffe73f-6c1d-47dc-bb6b-9f1ee22eef2b`。

播放与顺序：无字幕来源 `6ee937c4-5dee-4fba-8485-96aba90ae71a`，带烧入 Mock 字幕的来源 `3287cd10-c6b0-4939-8b9d-6843e6943087`。正向成片 `1f80b23f-dcbc-4f78-889a-1c0f74cc0218` 在 0.05s 亮度为 0、1.05s 亮度约 41.67。反向成片 `102c257c-aa25-44e4-b5a6-8d6bdb85280b` 相反。浏览器 `loadedmetadata` 后完成解码，进度超过 0.2，并到达 `ended`；尺寸 1080×1920；390px 横向溢出为 0。这是 Mock 黑帧与烧入字幕的对比，不是真实配音。

审核：正向成片批准为 `APPROVED`，另一份退回为 `REJECTED`。并发 If-Match 只有 1 条 `asset.reviewed`。

生命周期：

- 取消先提交：`da698486-c0f8-41e5-b290-90364c594252`，无成片。
- 已成功任务再次取消返回 `JOB_TERMINAL`。
- 完成前上游失效：`c6e3e3f6-cd94-4d8b-9f23-14b6c78ef463` 为 `FAILED`，无成片。
- Worker SIGKILL 后恢复：任务 `d342b6bf-806e-4614-be5a-ac7b3f5c066f` 有 2 次 attempt，唯一成片属于最新 attempt `f5e647f1-32d3-4a9a-a313-366a00465630`。
- 锁等待后过期 attempt `bd679c65-cae0-434f-b480-da7979749de2` 没有成片；任务 `1d5af2ec-6be8-4b24-8ccc-2d692b477dcb` 的成片属于后续 attempt。
- 成功事务注入失败：`6bedb3a2-d75a-4d32-acef-102ec759c624`，错误 `COMPOSE_COMMIT_INJECTED`，Asset、依赖和成功事件全部回滚。

上游失效：成片 `1f80b23f-dcbc-4f78-889a-1c0f74cc0218` 与其烧入字幕来源都变为 `STALE`，审核保持 `APPROVED`。页面显示历史成片。

隔离：该成片有 2 条来源依赖，与 manifest 一致；镜头来源为 null；没有新增该 Job 的 Provider 成本行；MinIO 对象数保持 0。输出键为：

`compose/e781794d-94d3-4788-9920-c4a8d52e6fd7/7d0414b4-d5d6-45fd-8df2-8fbd8afa6bcc/8a8614d2-949f-4091-a46d-1ca201a628f1/f4a76916-88c0-45bd-8d6b-e8dd76ff116d/a81921ca53e51faa207c14cdde354b40b97ae2f68026fe5638c41800d5c31bc7.mp4`

## 遗留

本机没有执行 Linux/Docker 上的 42 阶段联调，该项只由上面的成功 Run 覆盖。集级编码成本仍未计量。没有转场、跨集拼接、嵌套、真实 Provider、ComfyUI、三集批量、导出或发布。
