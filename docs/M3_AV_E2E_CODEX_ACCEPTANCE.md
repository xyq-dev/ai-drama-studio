# M3 AV 真实 CI 验收 Codex 结论

审查日期：2026-10-01。分支：`feat/m3-av-workbench`。提交方报告 HEAD：`1bf3f362aec56184127447f19df3fe5da5fbe494`。实际通过 Actions 的 SHA：`165319edad445a171213d7ee96e82cd4e93da9a0`。产品源码仍为已审查的 `2e7dfb9c437aa56540a073eb49b25975535c780c`。

**结论：本轮 Mock 视频与配音核心真实闭环通过。完整 M3 尚未完成，可以继续收尾验收脚本，然后进入 M3-C 的字幕、音乐切片。**

## 独立核对

Codex 实际读取 GitHub Run、Job、日志、分支 ref 与提交差异，下载 artifact、校验 ZIP SHA-256、读取结构化结果，并检查精确运行 SHA 上的验收脚本和截图。没有在 Codex 环境重新启动服务，也没有重跑全仓 verify。

- [Run 36809119919](https://github.com/xyq-dev/ai-drama-studio/actions/runs/36809119919)：push 事件，head_sha 为 `165319e`，结论 success。
- [Job 110199990702](https://github.com/xyq-dev/ai-drama-studio/actions/runs/36809119919/job/110199990702)：安装、构建、脚本检查、真实验收及 artifact 上传均成功。
- [Artifact 11139421014](https://github.com/xyq-dev/ai-drama-studio/actions/runs/36809119919/artifacts/11139421014)：1351482 bytes，到期 2026-10-08。下载 ZIP 的 SHA-256 与 GitHub 上传摘要相同：`a2178e339d0673bce90de1bc554846368dde34024f51341bad33eb598d4e326c`。
- `results.json`：16 个阶段全部 passed，fatal、cleanupError 均为 null，composeDown exit 0。原文件摘要：`33cb6c29f4aff42889a94bb55133eaa1beb5ff710b60ceffac19889c198db471`。
- `2e7dfb9..165319e` 仅含独立 workflow、验收脚本、根测试依赖/lockfile、忽略规则和文档；产品源码、fixture 与 infra/compose.yaml 未改。`165319e..1bf3f36` 只更新报告。

原 artifact 的 results.json 内容与独立元数据保存在 [M3_AV_E2E_CODEX_ACCEPTANCE_EVIDENCE.json](M3_AV_E2E_CODEX_ACCEPTANCE_EVIDENCE.json)，以免七天后的 artifact 到期丢失主要结构化结论。截图和完整进程日志仍属于原 artifact，未声称全部已长期归档。

## 本次真实证明的行为

| 行为 | 实际证据 |
| --- | --- |
| 隔离环境 | 新 Compose project、新库 m3av_36809119919a1；迁移前身份一致、public 表数 0；仅应用既有 5 个 migration。两次 mock-av:provision 分别 created、already present。 |
| 实际提交与持久化 | 通过真实 HTTP 建立已审核来源链；页面视频和配音 POST 202；Job 成功，各一个 Asset 和 ACTUAL USD 0 成本，来源 revision、保存的文本和 fixture 元数据核对。 |
| 同源播放 | Chrome 154.0.8037.92：H.264 16×16、1 秒、5 帧、ended=true；WAV 0.1 秒、ended=true。MP4 1552B、WAV 1644B 的完整 bytes 和 SHA-256 与固定 fixture 一致。 |
| 内容协议 | 实际浏览器请求 Range: bytes=0-；GET/HEAD/Range 的完整 200 行为和播放兼容性符合本切片设计。不是 206 实现。 |
| UI 回归 | PNG 1×1 解码；390px document/body/hash 溢出测量均为 0；未保存草稿保留，换 revision 后资产按来源进入历史。 |
| 门禁与幂等 | 实际 VIDEO 幂等重放、改 body 的 409、新 key 新任务；旧 revision、DRAFT、空 prompt/对白、错误 Workspace、显式关闭与 production 拒绝；媒体手工 retry 拒绝。不能扩大为 TTS 全组合覆盖。 |
| Mock 与存储边界 | 实际 MinIO bucket 前后对象数都是 0；输出位于本次 LocalMockObjects，固定黑色视频和静音不是真实模型输出。 |
| 两例恢复 | 磁盘故障后来源换版得到 Job FAILED/MOCK_AV_OUTPUT_INVALID；关闭 AV 后得到 Job FAILED/MOCK_MEDIA_NOT_CONFIGURED，图片仍成功。原 attemptNo/providerRequestId 不变，无 Asset/cost。 |

## MinIO 来源核验与范围

Codex 读取官方 GitHub Release API，独立核对 linux-amd64 asset 的 digest 和长度：

| 二进制 | 发行版本 | SHA-256 | bytes |
| --- | --- | --- | --- |
| minio | RELEASE.2025-09-07T16-13-09Z | 7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f | 110989496 |
| mc | RELEASE.2025-08-13T08-35-41Z | 01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891 | 30535864 |

来源：[MinIO Release](https://github.com/minio/minio/releases/tag/RELEASE.2025-09-07T16-13-09Z)、[mc Release](https://github.com/minio/mc/releases/tag/RELEASE.2025-08-13T08-35-41Z)。harness 实际下载、严格校验后装入 Alpine 本地镜像。是真实 MinIO 服务；不是上游 quay.io OCI 镜像验收，也没有上游 RepoDigest。

## 验收脚本需补强的三项

这三项不推翻本次 fatal=null、16 阶段全部 passed 的实际闭环，但应在扩展该 CI 前修好。

1. **阶段外异常可能假绿。** run.mjs 的最终 failed 只纳入 failed/blocked 阶段、composeDownFailed 和 cleanupError，未纳入 fatal、restoreError、skipped/缺失阶段。Codex 将精确 failed 表达式作隔离回放：仅 fatal、仅 skipped、仅 restoreError 时 failed 都为 false。这是 CI 可靠性问题；需覆盖阶段外异常和清理失败，统一 results.ok 与非零退出。
2. **SQL 关联与原 attempt 终结字段缺少直接断言。** cost 的 provider_request_id/job_attempt_id 已 SELECT 但未比较，job_attempt 只读 attempt_no/provider_request_id。当前证据不能直接证明原 attempt.finished_at/error_json/retryable=false，也不能从请求 ID 未变推断 Provider submit 调用次数。
3. **诊断范围不足。** console.json 三条 404 只记录文本，没有 URL，不能归为 favicon。390px 实际测量通过，但三张截图都是切回桌面后的 1280px；未保存 390px 截图。关闭门禁是显式 false，没有实测 unset 默认值。

下一轮按 [M3_AV_E2E_HARDENING_EXECUTION.md](M3_AV_E2E_HARDENING_EXECUTION.md) 只补验收代码和取证。产品源码与 fixture 维持当前审查基线。

## 尚未验收

成本冲突、全部暂时故障/取消竞争、隐藏标签页、Windows、其它 Compose 故障矩阵；字幕、音乐、完整 M3；真实 AI、付费 Provider、ComfyUI、上游 MinIO OCI 镜像、生产最小权限数据库角色、MinIO 媒体输出与 M4 成片。

Codex 本轮只新增验收结论、结构化证据和下一步执行单；不改产品代码，不操作 main/force/PR/merge/部署，不执行本地 Migration/provision。
