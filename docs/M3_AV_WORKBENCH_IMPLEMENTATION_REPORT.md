# M3 Mock 视频与配音工作台实现报告

目录：`D:\Projects\ai-drama-studio`  
分支：`feat/m3-av-workbench`，跟踪 `origin/feat/m3-av-workbench`  
起点：`5c8ff0322ecdd5cfeddcdd0a3eb9d9016f4c8459`（`docs(m3): define mock video and TTS workbench slice`）  
祖先：`f62764be6722d75eb8d3dc4a6edde5c7a3081d0d`（M3 图片核心真实验收记录，本分支已包含）  
本报告与本轮实现在同一次提交。提交 SHA 以该提交的 `git rev-parse HEAD` 为准。

这是 M3-C 的第一切片。固定黑色视频和 100ms 静音不是真实 AI 视频或真实朗读。字幕、音乐、图生视频、ComfyUI、付费模型和成片合成未做。

## 已有契约与本轮实现

`MockMediaAdapter` 原先已声明 `video.generate` 与 `audio.tts`。API、Worker、恢复、provision 和内容读取此前只接通 `MEDIA_IMAGE` / `image.generate`。旧 MP4 是不可在 Chrome 154 播放的 mp4v。本轮换成预检候选中的 H.264 Constrained Baseline 片段，并接上队列、Asset、成本和镜头页。

- `POST /api/v1/shot-revisions/:revisionId/generate-video` 与 `generate-tts` 复用既有 `{seed?: string}` 体和 `Idempotency-Key`。202 只表示受理。幂等范围仍是 workspace、actor、方法、路由和 key；视频与配音是不同路由，不新增跨路由全局冲突。客户端不能指定 workspace、正文、路径、provider 或 outcome。
- 入队在项目锁内冻结已批准镜头。视频来源是已保存 `promptText`，配音来源是已保存 `dialogue`。空白或缺失则拒绝，不回退到 action、提示词或未保存草稿。快照写入 revision、capability、seed、`executionMode: "sync"`、来源文本和来源哈希。不接收 `imageAssetId`，也不要求已批准图片。
- 白名单只有 `MEDIA_IMAGE`→`image.generate`、`MEDIA_VIDEO`→`video.generate`、`MEDIA_TTS`→`audio.tts`。通用 consumer、`completeMockJob` 和通用 RUNNING / WAITING_EXTERNAL 查询排除这三类。缺配置失败为 `MOCK_MEDIA_NOT_CONFIGURED`，不回退 `mock.generate`。未知 capability 的 inspect 返回 UNKNOWN，不默认成 IMAGE 或 AUDIO。
- 同步请求 id 为 `mock-media|sync|<capability>|<clientRequestKey>`。inspect 的 ACTUAL 与 submit 一致，且没有 `supersedesEstimateKey`。原 delayed 估算契约仍保留。恢复读取已存请求，不再次 submit。
- Asset、成功的 Job/Attempt 与 0 美元 ACTUAL 成本在同一事务。成本为 USD、`request`、`PROVIDER_REPORTED`，并带 workspace、project、job、attempt、provider request。同一 key 内容不一致时报冲突。图片路径不写这笔成本。VIDEO/AUDIO 审核状态保持 DRAFT。`durationMs` 从已有列映射，没有新 Migration。
- 对象只写入显式 Mock 目录：`mock-videos/<projectId>/<jobId>/<hash>.mp4`、`mock-audio/...wav`。图片仍是 `mock-images`。不写 MinIO。文件先落盘，事务失败可能留下没有 Asset 的对象；对象存在不等于成功。
- `GET`/`HEAD /api/v1/assets/:assetId/content` 按 IMAGE/VIDEO/AUDIO 分派。图片仍走 PNG IDAT/CRC。视频和音频必须等于标准 fixture 的 kind、MIME、尺寸、时长和字节。GET 200 返回全量，HEAD 200 空 body，不设置 `Accept-Ranges`。Range 被忽略并仍返回完整 200。未实现 206。
- `M3_MOCK_AV_ENABLED` 默认 false。只有非 production、值为 true、且 `MOCK_OBJECT_DIR` 为绝对路径时，API 与 Worker 才受理、执行和读取视频/配音。`M3_MOCK_IMAGE_ENABLED` 仍只控制图片。
- `pnpm --filter @ai-drama/database mock-av:provision` 在一个事务里为当前 ACTIVE workspace 写入 `video.generate` 与 `audio.tts`。任一行不兼容则回滚。`mock-media:provision` 仍只写 `image.generate`。启动时不自动插入。
- 镜头页视频和配音各自有提交状态、幂等键和 202 文案。无已保存提示词时按钮为“先保存并审核提示词”；无已保存对白时为“先保存并审核对白”。文案说明是固定黑屏和 100ms 静音，对白只作审计来源。MP4 用 `video controls playsInline preload=metadata`，WAV 用 `audio controls preload=metadata`，不自动播放。三类媒体任务终态只刷新该 revision 的资产。媒体手工 retry 在 API 和任务抽屉中保持禁用。

## 固定素材

来源是 `docs/M3_AV_PREFLIGHT_REPORT.json` 的候选 `candidate-H264-baseline-faststart-5frames`，静态内嵌在 `packages/providers`。预检记录 ffmpeg/ffprobe 6.1.1 与 Chrome 154 的 data URL 播放，不是本轮内容 API 的播放证明。

| 素材 | 字节 | SHA-256 | 元数据 |
| --- | --- | --- | --- |
| H.264 Constrained Baseline，avc1，yuv420p，faststart，无音轨 | 1552 | `6cbb357d0c5429c415430d0596dfc04417b9fa967eeb34e55186b0a3a9f590e3` | 16×16，1000 ms，5 帧 |
| 既有静音 WAV，PCM16，单声道，8 kHz | 1644 | `c726d333dd159a31423f3480dbb1c5c4a9dfcd30efe1f7e12ade390dc92e8908` | 100 ms |

seed 和对白不改变这两段字节。verify、测试和启动都不调用 ffmpeg，也不下载模型。

## 验证

Node 使用 `C:\Users\Administrator\Tools\node\node-v24.21.0-win-x64`，pnpm 10.17.0。未关闭 engine 检查。

代理 HEAD 断言改为比较 `arrayBuffer().byteLength === 0` 后：

```text
pnpm --filter @ai-drama/web exec vitest run src/lib/asset-content-proxy.spec.ts
```

结果：1 file / 1 test 通过。

随后在仓库根目录执行：

```text
pnpm verify
```

exit 0。顺序为 lint、typecheck、test、build。lint 9/9，typecheck 14/14，test 14/14，build 9/9。未改包复用 turbo 缓存。测试计数：

| 包 | 结果 |
| --- | --- |
| `@ai-drama/api` | 7 files / 13 tests |
| `@ai-drama/worker` | 12 files / 26 tests |
| `@ai-drama/web` | 7 files / 51 tests |
| `@ai-drama/database` | 5 files / 13 tests |
| `@ai-drama/providers` | 1 file / 15 tests |

Web 日志中的 `ECONNREFUSED 127.0.0.1:3000` 与 `::1:3000` 来自 happy-dom 模拟请求，套件仍通过。这不是真实 API 结果。

这些测试覆盖：标准 fixture 字节与同步 inspect 不计估算；成本精确重放与冲突；provision 假事务回滚；视频任务写入 fixture 与零元成本、恢复不 submit、已被占用的 attempt 不建 Asset；媒体任务不能走文本成功；内容拒绝伪签名、错误时长、错误类型和目录；控制器 GET/HEAD 与忽略 Range；同源代理转发；镜头页在缺少已保存提示词或对白时禁用按钮，视频 202 使用独立幂等键，以及解码失败文案。

没有针对 Nest 路由的测试覆盖幂等 409、错误 workspace、DRAFT/旧批准/STALE、production 关闭，也没有 PostgreSQL 上的 Asset 与成本同事务测试。成本与 provision 用的是内存假客户端。

## 未执行

- 真实 API、真实 Worker 进程、真实浏览器播放。没有 `loadedmetadata`、解码帧、`currentTime` 推进、WAV `ended`，也没有 390px 视口。happy-dom 只检查元素、文案和请求键。
- 预检 JSON 里的 Chrome 154 结果是离线 data URL，不是本轮 `GET /api/v1/assets/:id/content` 的播放。因此没有新增 206。
- PostgreSQL 集成测试、Migration、对真实库执行 `mock-av:provision`。集成脚本会 `DROP SCHEMA public CASCADE`，本轮没有新建并核验专用空库，也没有对既有库执行。
- Docker、Compose、MinIO。Windows 10 1809（build 17763）上此前 Docker 安装失败，本轮没有重试。素材写入 LocalMockObjects 指定目录，不进入 MinIO。
- 图片费用链、费用 UI、真实计费、ComfyUI、付费模型和成片。

Migration 范围：无。

## 审查修复

在 `6afa6345f8f7a99565b672e678059ffa5f2170df` 上修了四项审查问题。永久恢复错误按持久化错误码进入终态；图片和视频开关分别控制恢复；迟到的 revision 响应不再改写当前提示；重新查询只保留实际受理渠道的文案。固定 fixture、零美元 ACTUAL、LocalMockObjects 和全量 200 未改。详情与本轮模拟验证见 [M3 AV 审查修复报告](M3_AV_REVIEW_FIX_REPORT.md)。真实 API、Worker 和浏览器仍未执行。
