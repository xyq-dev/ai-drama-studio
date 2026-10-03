# M3-C1 执行单：Mock 视频与配音工作台

【执行工具：Cursor｜模型：Grok 4.7 High Fast】

## 目标与基线

从 `f62764be6722d75eb8d3dc4a6edde5c7a3081d0d`（M3 图片工作台核心真实验收记录）开始，在 `feat/m3-av-workbench` 实现：

**当前且已批准的镜头 → 视频 / 配音 Mock 请求 → 实际 Worker → 不可变 Asset + 零元 Mock 成本 → 同源可播放 MP4 / WAV。**

这是 M3-C 的第一切片。字幕、音乐、图生视频、真实 TTS/视频模型、GPU、付费 API、ComfyUI、成片合成与部署留到后续。本轮仅固定同步 Mock 输出；不把它称为真实 AI 视频或真实对白朗读。

上一图片轮只通过了核心真实闭环；真实隐藏期间完成、Windows/Compose 和完整故障组合仍未全部验证。保留这些限制，不把本轮或前轮标为完整 M3 完成。

## 已核对的事实

- `MockMediaAdapter` 已声明 video.generate、audio.tts，并有固定 MP4/WAV fixture；契约存在不等于队列实现。
- 实际 API、Worker consume、provider loader、专门 lease recovery、开发 provision 都只接了 MEDIA_IMAGE / image.generate。
- `asset` 已支持 VIDEO/AUDIO 与 duration_ms；CreateMediaAssetInput 已写 durationMs，但公开 MediaAssetRecord、ASSET_COLUMNS、mapAsset 尚未返回它。不应为已有字段新建 Migration。
- 当前 MP4 是 mp4v/MPEG-4 Part 2。Codex 用实际 Chrome 154 离线解码收到 MEDIA_ERR_SRC_NOT_SUPPORTED，不能沿用容器标签测试作为可播放证明。现有 WAV 为 100ms 静音 PCM16、单声道、8kHz，实际可播放。
- 通用 consumer / completeMockJob 能对未知非文本 kind 直接标记成功；RuntimeStore 的通用 RUNNING / WAITING_EXTERNAL 查询仅排除 MEDIA_IMAGE。漏接新媒体路由会产生“成功但无 Asset”。
- Asset 的 ACTIVE 与审核 APPROVED 是独立状态。现有数据库只允许 COMPOSITE 批准；本轮 VIDEO/AUDIO 仍为实际 DRAFT。
- CostLedger 已有不可变、幂等与 lineage SQL 约束，但没有应用侧成本落账 helper；现有图片正常路径未消费 Adapter accounting。
- 同步 submit 的 accounting 只有 ACTUAL；现有 inspect 成功会带 supersedesEstimateKey，即使没有 ESTIMATED。恢复不可照抄这个字段并引用不存在的估算。
- services/media-worker 仍是健康检查空壳，不需要为固定 Mock 引入 FFmpeg 服务。

## 实施顺序

### 1. 契约、来源与 API

| 入口 | 请求 | Job / capability | Asset |
| --- | --- | --- | --- |
| POST /api/v1/shot-revisions/:revisionId/generate-video | 严格的 {seed?: string} + Idempotency-Key | MEDIA_VIDEO / video.generate | VIDEO / video/mp4 |
| POST /api/v1/shot-revisions/:revisionId/generate-tts | 严格的 {seed?: string} + Idempotency-Key | MEDIA_TTS / audio.tts | AUDIO / audio/wav |

- 复用事务入队、outbox 与现有幂等；202 只表示受理。同一路由、同 key/同请求重放只有一套 workflow/job/Asset/cost；同一路由同 key 改 seed/body 得到既有 409 幂等冲突。UI 切换 revision 或媒体类型必须换新 key；服务端保留 workspace+actor+method+routeKey+key 的既有独立作用域，不新增跨路由全局冲突。不得允许客户端指定 workspace、任意文本、路径、provider 或 outcome。
- 入队时由服务端在项目锁内读取且冻结已批准 revision：视频来源 promptText，配音来源 dialogue。保存 revisionId、内容 hash、capability、seed、schema 版本与实际来源文本到 inputSnapshot/inputHash。
- TTS 的 dialogue 为 null、空白或不存在时拒绝。不得从 action/promptText 补对白；不得朗读未保存草稿。视频需要非空已保存 promptText。
- 入队、执行前及 Asset 原子提交时均复用镜头/场景/剧本/角色依赖与重算 pending 门禁；APPROVED 不代表当前指针或 CURRENT。保留 Workspace/Project 过滤。
- 本轮视频从已批准镜头文本得到固定视频，不接 imageAssetId，不要求 IMAGE Asset 被批准，也不伪造图生视频来源。
- 列表及内容 DTO 增加 nullable durationMs，从数据库真实字段映射；检查 INSERT RETURNING、所有 list/get 映射与 Web 类型一致。既有 IMAGE 字段和接口保持兼容。

### 2. 媒体消费、恢复和成本

- 建立小型明确白名单：MEDIA_IMAGE→image.generate，MEDIA_VIDEO→video.generate，MEDIA_TTS→audio.tts；共享映射或等效类型约束，避免各层字符串漂移。不实现所有 Adapter 的通用工作流框架。
- 扩展 start-runtime 媒体分发、loadMockImageExecution 或新媒体 loader、listExpiredMockImages 或新媒体 recovery；新 capability 查询必须命中同 Workspace 的正确 provider。
- 通用 consumer、completeMockJob 与通用 lease/WAITING_EXTERNAL 查询必须显式拒绝/排除全部三类媒体。缺配置的媒体明确失败，不能回退 mock.generate。未知 capability/kind 不能默认为 image 或 AUDIO。
- 新两个路径仅支持固定同步成功；不要开放 delayed/outcome 请求、异步回调或自动外部提交。已有异步 Adapter 契约及测试保留，不宣称本轮覆盖它。
- attach providerRequestId 后发生持久化故障，恢复 inspect 已存请求，禁止盲目再次 submit；恢复使用原 attempt、capability、来源与快照。重复 dispatch、恢复重放不能新建第二个 Asset/cost。
- 创建 Asset 与成功 Job/Attempt、零元 ACTUAL cost 同数据库事务，可在 succeedJobWithArtifact.persistArtifact(client) 内调用新成本 helper。落账依据校验过的 Adapter accounting；保留完整 workspace/project/job/attempt/providerRequest lineage、USD 0、request 单位、PROVIDER_REPORTED 和稳定 idempotencyKey。
- 重复成本 key 要核对金额、币种、kind 和完整来源；不同内容必须报冲突，不能默吞或修改旧账。
- 同步恢复 ACTUAL 必须等价于同步 submit，不能伪造 ESTIMATED 来补 supersedesEstimateKey。用持久化同步执行模式区分；若调整 Adapter inspect，保留原 delayed 估算契约测试。本轮不补整个图片费用链、不做费用 UI 或真实计费。
- 取消沿用合法队列/状态机规则；取消与完成竞争不能重开终态或留下有效孤立 Asset。所有三类媒体手工 retry 在 API/UI 均继续禁用，显式再次生成使用新 key。
- 镜头在执行期间换版或变 STALE 时，不产生可用当前 Asset；不得跳过现有末端来源重验。对象文件存在不等于 Asset 成功。

### 3. 固定素材与本地存储

- 用能在目标 Chrome 实际播放的短黑色视频替换不可解码 MP4：预检候选为 H.264 Constrained Baseline、avc1、yuv420p、16×16、1 秒/5 帧、faststart，1552 字节；SHA-256 为 6cbb357d0c5429c415430d0596dfc04417b9fa967eeb34e55186b0a3a9f590e3。保留固定静音 WAV；输出与 seed/对白无实际画面/声音关联。
- 记录生成命令、工具版本、精确字节数、SHA-256 与实际 probe/浏览器宽高和时长；方案附件 M3_AV_PREFLIGHT_REPORT.json 可作为候选参考，候选不等于产品实现。
- fixture 离线生成后静态内嵌或随 providers 打包；服务启动、测试与 pnpm verify 不动态下载 FFmpeg、不依赖 ffmpeg 运行时、不触发模型。
- 对新两个固定 Mock 输出使用严格 fixture 白名单：真实 bytes 必须等于已独立 probe + 浏览器播放验过的标准 fixture；读取和 Worker 均校验 kind/MIME、大小/hash、width/height/durationMs 与标准元数据。不用 ftyp/RIFF 签名替代有效媒体；不宣称是任意 MP4/WAV 解析器。
- LocalMockObjects 只扩明确允许的 MIME/key，例如 mock-videos/<projectId>/<jobId>/<hash>.mp4 与 mock-audio/<projectId>/<jobId>/<hash>.wav；图片仍使用原 mock-images key。
- 扩展 typed object store、key 校验和读取保护；文件 sync、原子 rename、其它平台目录 sync 与仅 Windows directory sync EPERM 兼容边界保留。目录错误、文件 sync/rename 错误不能吞掉。
- 新素材仍只写显式 Mock 本地目录；不写 MinIO、不暴露静态目录、不让客户端传 objectKey 或本地路径。

### 4. 安全内容与可播放响应

在现有 /api/v1/assets/:assetId/content 上按允许的 IMAGE/VIDEO/AUDIO 分派：

- IMAGE 的 PNG IDAT/CRC、1 MiB、路径及生产保护保持。VIDEO/AUDIO 只按新开关启用，并要求对应 kind/MIME/storageProvider、合法来源 key、标准 fixture 元数据/字节。
- 继续 Workspace Asset UUID 查询、真实路径边界、普通文件、符号链接逃逸拒绝、DELETED/FAILED 拒绝。历史 STALE/SUPERSEDED 可以追溯，不能当当前生产输入。
- 新固定 MP4/WAV 明确最大 1 MiB 且不超过记录大小；验证后有界读取，不能先无界读完再查 size。错误不泄露本地绝对路径。
- 1552/1644 字节的固定 AV 首选 GET 全量 200、HEAD 200 空 body，Content-Type/Content-Length 与实际 bytes 一致。当前切片不主动实现 Range，不宣传 Accept-Ranges；收到 Range/If-Range 可以忽略并返回完整 200，HEAD 同样忽略 Range。用测试固定此行为。
- Web 同源代理支持 HEAD，正确传递状态、类型/长度且不返回 body；GET 不把媒体重新编码 JSON。私有 no-store、nosniff 保留。浏览器实际发出 Range 时必须记录，并验证完整 200 仍能完成播放。
- 只有真实同源播放证明完整 200 不满足需求时，才补单 bytes Range/206/416，并补 start-end、start-、suffix、整数溢出、416 Content-Range 与代理传头测试；仍先验证完整有界 fixture 再切片，不能绕过权限或完整性。不实现 multipart/完整缓存协议。
- HTTP 参考 RFC 9110 §§9.3.2、14.2、14.4、15.3.7、15.5.17：https://httpwg.org/specs/rfc9110.html 。离线 data URL 预检没有覆盖 HTTP 内容、HEAD 或 Range。

### 5. 配置与工作台

- 新开关 M3_MOCK_AV_ENABLED 默认 false；只有非 production、true、绝对 MOCK_OBJECT_DIR 才能接受/执行/读取新视频与 TTS。API 和 Worker 都做明确配置检查；production 即使 true 也禁用。
- M3_MOCK_IMAGE_ENABLED 继续只控制既有图片，不能被新开关替代或间接打开。
- 新命令 `pnpm --filter @ai-drama/database mock-av:provision` 只为精确 ACTIVE APP_WORKSPACE_ID 幂等创建/验证 video.generate 与 audio.tts；两项放同事务，任一不兼容时不留下部分初始化。已有 mock-media:provision 仍只初始化 image.generate。
- 不跑 Migration、不自动塞启动流程、不覆盖已有禁用/带凭据或不兼容 provider、不写别的 Workspace。
- 镜头页增加视频和配音入口；共用“已加载且当前且已批准且 CURRENT”来源门禁，但每种提交状态、请求 key 和 202 受理事实独立。
- 提示固定黑色视频与 100ms 静音：配音请求取已保存的审核对白作为审计来源，fixture 不朗读内容。无对白时配音禁用，明确“先保存并审核对白”；已保存 promptText 为空时视频禁用，提示“先保存并审核提示词”。UI 不把未保存草稿当审核来源。
- 任务把 MEDIA_IMAGE/VIDEO/TTS 统一归媒体展示；终态只刷新对应 revision 资产，不重读覆盖正文，包含 reloadBase/恢复可见处理。过期响应、换对象/换 revision、失败和刷新不能串资产。
- Asset 按当前/历史 revision 与媒体类型展示真实状态/审核/来源/字节/hash/时长。PNG 用 img、MP4 用 video controls playsInline preload=metadata、WAV 用 audio controls preload=metadata；默认不自动播放，读取/解码失败明确显示。
- 避免播放器在普通轮询中被无意义卸载或重置进度。390px 不溢出、长 hash/来源换行。保持 M2 原 If-Match、草稿、409 确认、null 清空，以及已验图片行为。

## 必须验证

| 层 | 至少覆盖 |
| --- | --- |
| 契约/API | 两项受理/幂等、strict body、错误 workspace、无对白/无 prompt、DRAFT/旧批准/STALE/重算门禁、默认关闭/production |
| Worker/恢复 | kind→capability 正确、不能进入文本 consume/recovery、重复 dispatch、attach 后崩溃恢复不 resubmit、来源换版/取消竞争不产生有效 Asset |
| 成本/数据库 | Asset+Job+cost 同事务、重复精确重放一笔ACTUAL、不同 lineage/金额冲突、不引用不存在的ESTIMATED、durationMs真实映射 |
| 内容/代理 | 合法PNG/MP4/WAV、伪签名/截断/错误hash/metadata/目录/超限/越界/跨Workspace拒绝、GET/HEAD、忽略Range全量200与同源转发；若确实新增206再补范围负例 |
| Web交互 | 202后查询失败保留受理且只能重新查询、三类媒体终态刷新、草稿与旧基线保留、revision历史归属、读取/解码失败、hidden相关模拟明确标注 |
| 真实浏览器 | 视频 loadedmetadata + 实际 decoded frame + playing/currentTime推进或ended；WAV metadata + play/ended；同源实际请求/Range行为、来源核对、390px；只有URL/class断言不能计通过 |

先跑改动相关 lint/typecheck/test，再在 Node 24.21.0、pnpm 10.17.0 下 `pnpm verify`，不得关闭 engine 检查。替代 Webpack build 不能写成标准 verify 通过。

库集成测试如果会 DROP SCHEMA，只能使用本轮新建、实际核验身份与为空的专用隔离库；禁止对原 M3 验收库或任何既有库重置。可在确认归属的全新专用库应用既有迁移与显式 provision。不要重复安装失败的 Windows 1809 Docker。缺少本机服务时继续完成代码/模拟验证与 push，由 Codex 在独立原生环境做真实验收；不能伪造 Worker/API/浏览器通过。

## Git 与交付

1. 在 `D:\Projects\ai-drama-studio` 先核实 status、branch、HEAD 与已有修改。原文件全部保留；不 reset/clean/stash 或覆盖。使用同名 feature 或独立 worktree；fetch 后从本执行单提交继续，不从 main 丢失 M2/M3 图片代码。
2. 分支为 feat/m3-av-workbench，必须包含祖先 f62764be。本轮 feature commit + 普通 push 已授权；完成相关检查后选择性提交本轮源码/测试/文档并 push，同步 fetch 核对 HEAD/远端 SHA。不要 force/main/PR/merge/应用 pack/deploy。
3. 先输出你的实际起点和范围，随后直接实施上述工作。不只输出方案或要求用户重复批准。遇到局部环境阻碍继续完成不依赖它的实现与测试。
4. 更新 README/.env.example，新增 docs/M3_AV_WORKBENCH_IMPLEMENTATION_REPORT.md；分清已有契约、实际实现、模拟/真实测试、固定 fixture 与 AI、LocalMockObjects 与 MinIO。
5. 返回 M3_AV_WORKBENCH_REPORT：目录/分支/基线/最终SHA、实际改动、命令/exit/测试数、真实执行与未执行项及原因、Migration范围、GitHub提交URL与fetch核验。不要宣称完整 M3/ComfyUI/成片已完成。

本文件是已审查的执行方案。此方案提交只包含文档与离线素材预检查证据，M3-C1 的业务代码尚未实现；Cursor 完成并推送后，Codex按精确 SHA 审查并执行真实闭环验收。
