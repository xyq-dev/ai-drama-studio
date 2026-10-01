# M3 AV 四项修复 Codex 审查

日期：2026-10-01。源码：`2e7dfb9c437aa56540a073eb49b25975535c780c`；起点：`6afa6345f8f7a99565b672e678059ffa5f2170df`；分支：`feat/m3-av-workbench`。GitHub 与 git fetch 均确认分支与该 SHA 一致，相对起点 1 个提交、11 个文件、+783 / -62，没有 Migration。

结论：**R1–R4 四项修复代码审查通过，可以进入真实 AV 验收。真实 API / Worker / PostgreSQL / 同源播放尚未通过，完整 M3 未完成。**

## 修复核对

| 原问题 | 本轮源码与验证 |
| --- | --- |
| R1 永久恢复错误保持 RUNNING | `mock-media-failure.ts` 按 PersistenceError 错误码分类，正常 AV 与 recovery 共用；永久错误失败原 attempt，暂时故障仍可恢复，终态 / superseded 竞争不失败较新 attempt。Worker 模拟覆盖 VIDEO / TTS 的三类永久错误、磁盘 / 重算暂时故障及取消 / attempt 竞争。 |
| R2 AV 恢复绕过开关 | startQueueRuntime 总是提供收尾 recovery，显式传图片与 AV 各自开关；关闭类型或无对象目录时配置失败 / 取消，不 inspect / put / 提交 Asset。接线测试直接启动实际 startQueueRuntime，替换数据库 / 队列 / 存储依赖。 |
| R3 旧 revision 的迟到提示串版本 | 单调 revisionEpoch 防住 A→B→A，切换清三类 notice / error / busy / pending；提交、查询与 finally 校验世代，旧成功仍可安全触发全局任务重读。 |
| R4 重新查询给未提交媒体显示受理 | 渠道 requery 只回写该渠道，acceptedEpoch 仅记实际 202；公共列表失败使用媒体中性文案，不再重新 POST。 |

本轮没有发现新的具体阻断回归。原有播放器读取失败后缺乏重试入口仍属非阻断改进，本轮未修改。

## Codex 实际验证

Node 24.21.0、pnpm 10.17.0，frozen lockfile 依赖安装成功，API / Worker 与其 workspace 依赖 7 项 build 成功。重新执行：

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @ai-drama/worker exec vitest run src/runtime/mock-av-generation.spec.ts src/runtime/mock-media-recovery.spec.ts src/runtime/mock-media-consumer-guard.spec.ts src/runtime/start-runtime-media.spec.ts src/runtime/local-mock-objects.spec.ts` | exit 0；5 files / 25 tests |
| `pnpm --filter @ai-drama/web exec vitest run src/components/workbench.review.spec.tsx src/lib/asset-content-proxy.spec.ts` | exit 0；2 files / 41 tests |

合计 7 files / 66 tests。Worker 选择文件包含 local-mock-objects 的 6 项；与提交方另一组定向文件的 21 项不同，不把不同集合的数字混用。Web 的 happy-dom ECONNREFUSED 日志仍是模拟环境连接，套件通过，不是真实 API 验收。

独立 React / happy-dom / 受控 fetch 回放 13/13 通过，覆盖三类媒体各自的二次查询失败、A→B→A 迟到 202 / 旧 finally / 新请求 busy 与幂等键、迟到写入失败、旧 requery 失败、公共中性错误。同一 harness 对 `6afa634` 仅 1/13 通过，exit 1 为检出了旧问题。主审独立重跑当前与旧版，结果一致。只在 scratch 源码副本导出私有组件用于测试，没有修改仓库组件。

本次未重跑全仓 `pnpm verify`；提交方在本源码报告的全仓 exit 0 是其本机结果。部分新增组件断言未严格等待旧异步完成，独立回放补充了受控等待，此项不阻断当前修复。

## 真实环境核验与阻断

上一轮原生验收运行目录已回收，本轮不复用或重置旧库。当前执行沙箱实际核验：

- 进程为 UID/GID 0，uid_map 与 gid_map 均仅 `0 0 1`，setgroups 为 deny。
- `runuser -u nobody -- id` exit 1，`cannot set groups: Operation not permitted`。没有可正常执行 PostgreSQL 的真实非 root 身份，因此没有运行 initdb 或数据库服务。
- 原生 PostgreSQL 16.15 / Redis 7.0.15 仅取得包并检查版本，未启动。Chrome 154 下载校验一致，但解包后的文件出现异常，headless 尝试 exit 139；重新提取只验证版本，未验证启动或 H.264 解码。
- 没有使用身份伪装、占位数据库 / S3 服务或权限升级，没有执行 Migration / provision。

这些是本轮环境限制，不是已确认的产品故障；不能把下载二进制或打印版本算作真实验收。结构化结果见 [M3_AV_FIX_CODEX_REVIEW_EVIDENCE.json](M3_AV_FIX_CODEX_REVIEW_EVIDENCE.json)。

## 下一步

首选复用仓库现有 Compose，在 GitHub Actions 的 Linux 临时 runner 上跑真实 API / Worker / Web / PostgreSQL / Redis / MinIO / 浏览器。这不依赖 Windows 本机 Docker，也不需要部署或合并 main。

Cursor 按 [M3_AV_E2E_CI_EXECUTION.md](M3_AV_E2E_CI_EXECUTION.md) 只落地验收脚本、测试依赖、独立 feature CI 与文档；普通 push 自动触发。Codex 按运行 SHA、Job 日志与 artifacts 核对真实结果。未取得真实运行证据前，不能写成 AV 验收通过。

本轮 Codex 只提交审查结果、模拟 / 环境证据和下一步执行单，不修改产品源码、原有 workflow、main 或部署配置。Migration：NO。
