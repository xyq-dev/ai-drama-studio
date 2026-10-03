# M3 AV Linux CI 真实闭环验收执行单

【执行工具：Cursor｜模型：Grok 4.7 High Fast】

## 工作目录与目标

在 `D:\Projects\ai-drama-studio`、`feat/m3-av-workbench` 工作。先核实实际 status / branch / HEAD、fetch 远端，保留所有原有未提交改动，不 reset / clean / stash / 覆盖。源码基线为 `2e7dfb9c437aa56540a073eb49b25975535c780c`，从包含该源码与本执行单的 feature 最新 HEAD 继续，不从 main 重开。

四项修复已通过 Codex 代码审查与模拟回归。现在最重要的是证明：**实际页面提交视频 / 配音 → API 202 → Redis / Worker → PostgreSQL 的 Asset + Job + ACTUAL 成本 → 同源浏览器解码播放。** 当前 Codex 沙箱不能启动非 root PostgreSQL，Windows 本机 Docker 也不可用，直接使用仓库已有基础设施，在 GitHub Actions Linux 临时 runner 上执行。不要再做架构分析或重装本机 Docker。

## 允许范围与权限

- 允许新增 `.github/workflows/m3-av-e2e.yml`、`scripts/m3-av-e2e/` 的验收 / 启停 / 取证脚本，必要的根目录测试 scripts / devDependencies / pnpm-lock.yaml，以及验收说明和报告。优先小型 Node / Playwright harness，不引入新的生产框架。
- 产品 API / Web / Worker / database 源码与固定 fixture 先保持本审查结果；不顺带重构，不修改原有 workflow 或 infra/compose.yaml。若真实验收暴露明确产品缺陷，记录请求 / 错误 / 源码位置，反馈 Codex 后再定修复范围。
- 本轮选择性 commit + 普通 push 当前 feature 已授权。允许只在本次 CI 新建、身份和为空均已验证的隔离库应用既有 Migration、运行 workspace:provision / mock-media:provision / mock-av:provision。没有新 Migration，不执行 DROP SCHEMA 或全库重置。
- 不操作 main、force push、PR、merge、应用 pack、部署、生产数据、付费 Provider、ComfyUI 或真实模型。CI 证据压缩 / artifacts 上传属于测试取证，不是应用发布包。

## 1. 仅为当前 feature 自动触发的 CI

- 新 workflow 只 `push` 到 `feat/m3-av-workbench` 时自动运行，可保留 `workflow_dispatch`；不增加 main / PR 自动执行。设置 paths 覆盖本 workflow、验收 scripts、package / lockfile 与相关 apps / packages 代码，纯报告更新不再重跑。
- 使用 `ubuntu-24.04`、Node 24.21.0、pnpm 10.17.0，`permissions: contents: read`；不读取 repository secrets，不加入发布权限或生产环境。设置约 30 分钟总超时，等待 API / 任务 / 播放均有明确上限。
- 复用 `infra/compose.yaml`，使用含 runId / runAttempt 的独立 Compose project name 与 RUNNER_TEMP 下生成的私有 env。运行 PostgreSQL、Redis、真实 MinIO 和 minio-init；记录实际镜像版本 / digest。绝对 MOCK_OBJECT_DIR 位于本次 RUNNER_TEMP，图片和 AV 开关显式开启，API / Worker 用非 production 配置；Web build / start 使用其正常构建配置。
- 不改既有 volume。清理只能针对本次 project / PID / 临时目录；结束或失败都采集诊断，并终止本次应用进程与 down 本次 Compose project。不得对其它 project 全局 prune 或删除。
- 使用本次唯一测试库和 Workspace。迁移前以实际连接记录 current_database / current_user / 地址与端口、public 表数 0；拒绝非 loopback 或非预期 CI 测试库。若需要 app 角色，只在该新实例创建最小权限角色，不借用现有数据库凭据。
- 在该新库应用仓库既有迁移，然后运行 workspace:provision、mock-media:provision、mock-av:provision；后者重复运行一次并只读核对配置幂等、workspace 与 capability。不要运行会重置 schema 的既有 integration 套件来替代本闭环。
- frozen lockfile 安装，正常 build 后启动实际 API、Worker、Web。健康 ready 应验证 postgres / redis / objectStorage / queue，不能放一个固定 200 服务代替依赖。镜像拉取 / 启动失败要如实失败取证。

## 2. 通过实际 HTTP 建立合法来源链

使用真实 HTTP 创建项目、故事、第一集剧本、角色、场地、场景、镜头，并通过实际 review 接口提交和批准，读取真实 rowVersion / revisionId / CURRENT 状态。不 SQL 伪造审核、成功 Job、Asset 或成本。

镜头包含非空已保存 promptText、非空 dialogue，并具有正确的已批准当前来源。fixture 仍为固定黑色视频与静音，输入文本只进入审计快照。测试请求只使用本轮自建数据。

Workspace 由 API 实例配置决定；错误 Workspace 负例应使用配置为另一已 provision Workspace 的临时真实 API，不能以自造请求头证明隔离。默认关闭和 production 负例也用实际配置的实例。

## 3. 必须取得的真实证据

| 项目 | 必须检查 |
| --- | --- |
| 页面视频与配音 | 实际 Web 镜头页分别点击生成，记录两个同源 POST 的 202、受理文案及 workflow / job。不能拦截 fetch 或伪造 202 / assets。 |
| 队列与落账 | 轮询真实 job 到终态；只读 SQL 核对 MEDIA_VIDEO / MEDIA_TTS、原 attempt / providerRequestId / 来源 revision / inputSnapshot、对应 Asset、ACTUAL USD 0 成本。同一次输出只有一个 Asset / cost，真实请求冻结的是已保存来源。 |
| 视频 | 浏览器从同源 asset/content 读取 MP4，记录 loadedmetadata、16×16、约 1 秒、实际 decoded frame（如 getVideoPlaybackQuality 或 requestVideoFrameCallback）、playing / currentTime 推进或 ended；只有 video 标签 / URL 不算通过。 |
| 音频 | 同源 WAV metadata、约 100ms、用户操作触发 play、播放时间推进 / ended。静音是预期，不称为对白朗读。 |
| 内容与传头 | PNG 回归解码成功；MP4 1552B / WAV 1644B 的真实 bytes、SHA-256、duration 与 fixture / Asset 记录一致。GET 全量 200；HEAD 200 空 body 且类型 / 长度正确；Range / If-Range 忽略并返回完整 200。记录浏览器实际 Range 请求和播放结果，不无故新增 206。 |
| 幂等与门禁 | 同路由同 key / body 返回原 workflow / job，Asset / cost 数不增加；同 key 改 seed 得既有 409。新 key 新任务。DRAFT、旧批准 revision、空对白 / 空 prompt、错误 Workspace、默认关闭 / production 即使 flag=true 均通过真实 API 被拒绝，无新增任务；使用新 key 做门禁负例，避免混入历史幂等重放。 |
| 版本、草稿与视口 | 保存并批准新 revision 后，旧资产只在历史，当前区域与 sourceShotRevisionId 一致；生成不覆盖未保存草稿。实际 390px document/body 无横向溢出，长 hash / 来源可换行。 |
| Mock 边界 | 开始 / 结束只读列举真实 MinIO bucket，对象数不因 Mock 生成增加；对象写在本次 LocalMockObjects。媒体手工 retry 仍被拒绝。 |

使用真正能解码已有 H.264 的 Chrome，可采用 runner 可用的实际 Google Chrome 或官方 Chrome for Testing；记录版本。浏览器下载 / codec 问题作为真实失败报告，不能以离线 data URL、组件测试或 probe 替代同源播放。

核心闭环通过后，再做两个低成本恢复故障检查：

1. 只在本次 Mock 目录临时制造可恢复写失败（例如将目录改名，原路径放普通文件产生 ENOTDIR，不依赖 root 下可能无效的 chmod），使实际 Worker 已 attach 请求的任务保持 RUNNING；观察真实行，再通过 HTTP 将来源换版，恢复目录，等既有 lease recovery。验证原 attempt 明确失败、不再 submit、没有有效 Asset / cost。不要用 SQL 写 RUNNING 或改 lease 来伪造过程；等待有上限，finally 恢复文件。
2. 以同样真实写失败留下已绑定 AV 任务，停本次 Worker，恢复目录，以 image=true / AV=false 重启。验证旧 AV 原 attempt 配置失败、没有新增 Asset / cost，图片仍可正常执行。只读确认 attemptNo / providerRequestId，不从对象文件推断成功。

成本冲突、全部暂时故障 / 取消竞争、隐藏标签页与 Windows / 所有 Compose 故障组合未在此轮实际执行的，单列；不把模拟测试扩大为真实覆盖。若时间或环境确实阻挡恢复两例，保留核心结果与具体未执行原因，报告不能声称所有恢复实测通过。

## 4. 测试、Artifacts 与结果

- 新 harness 检查语法 / lint，配置经实际解析或工作流运行验证；相关回归测试先跑，再跑本机 `pnpm verify`。不关闭 engine 校验，不把替代 Webpack build 写成标准 verify。
- 每个阶段失败应保持非零 exit，不能 catch 后继续报通过。actual passed/failed/skipped/blocked 分开；超时不能当 skip 后整体成功。即便失败仍采集健康、真实 HTTP、进程日志、浏览器 console / pageerror、截图、SQL 只读快照与结构化结果。
- artifacts 保存到本次独立输出目录并上传，retention 约 7 天；内容带 workflow runId / attempt / github.sha、实际测试源码 SHA、工具与服务版本。不上传 env、凭据、DB data directory、依赖或服务二进制。普通测试素材和本次随机 UUID 不算生产数据。
- 本机没有 Docker 时不能测试真实服务，但仍完成脚本、配置检查、模拟回归、verify 与普通 push。push 包含新 workflow 后应自动触发；有 Actions 查询能力就等待并报告实际 run / job / artifacts，无能力则提供最终 SHA 由 Codex 查，不能把文件落地算成 CI 通过。

## 最终交付

更新说明与 `docs/M3_AV_E2E_CI_REPORT.md`。返回 `M3_AV_E2E_CI_REPORT`：实际目录 / 分支 / 起点 / 最终 SHA、改动文件、命令 / exit / 数量、本机与 CI 分别执行情况、真实结果 / 未执行原因、Migration 的隔离范围、GitHub commit / workflow run / artifacts URL、普通 push 和 fetch 远端核验。

完成后直接选择性 commit、普通 push，不要求用户重复批准，也不只输出计划。CI / 产品真实失败留证据给 Codex，不伪造通过、不擅自扩大产品修改范围。
