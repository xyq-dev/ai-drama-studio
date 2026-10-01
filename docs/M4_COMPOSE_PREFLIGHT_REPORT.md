# M4-A 单镜合成预检报告

## 结论

M4-A 单镜合成预检完成。预检只检查来源和可用性，并返回清单与 `inputHash`。没有执行 FFmpeg，没有创建合成 Job、COMPOSITE Asset 或成本。预检结果不是任务受理凭证，也不是持久化的合成计划。

下一步才接真实渲染与 COMPOSITE 成片审核。

## 现场

目录 `D:\Projects\ai-drama-studio`。来源分支 `feat/m3-lifecycle-acceptance` 的远端与本地 HEAD 都是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。其中已通过真实生命周期验收的 SHA 是 `67dcb64ad7b6e93f700acf6e3980b95b9f6f210d`。当时工作区干净。目标分支 `feat/m4-compose-preflight` 原先不存在，因此从该来源 HEAD 新建，并取消了对生命周期分支的上游跟踪。没有 reset、clean、stash、合并或覆盖。

- 本轮真实通过的验收 SHA：`67606d3886d7489750ea61c2a82659bf81b5f6c5`
- 报告提交与该验收 SHA 分开。最终仓库 SHA 在报告 push 之后由 fetch 核对。
- 远端核验：实现提交 push 到 `origin/feat/m4-compose-preflight`，没有更新 `feat/m3-lifecycle-acceptance`。

## 修改范围

镜头页选择媒体后，服务端在短事务里复用现有镜头门禁，返回稳定清单和哈希。页面展示预检结果，并在切换版本或选择后丢掉旧结果。

- `packages/domain/src/compose-preflight.ts`：请求规范化、清单和 `canonicalInputHash`。没有放宽 `text-chain.ts` 对 `rowVersion` 等字段的禁止。
- `packages/database/src/media-assets.ts`：同一事务内取项目锁、调用现有 `assertUsableShotWithClient`、按资产 ID 锁定所选资产。资产列表 DTO 增加兼容字段 `rowVersion`。
- `apps/api`：`POST /api/v1/shot-revisions/:revisionId/compose-preflight`，成功 `200`，`Cache-Control: private, no-store`。不走幂等结果缓存，不创建任务、资产、账本、outbox 或领域事件。
- `apps/web/src/components/compose-preflight.tsx`：镜头工作台上的独立“Mock 单镜合成预检”。`workbench.tsx` 只增加挂载。
- `scripts/m3-av-e2e`：原有 25 个阶段保持在前，新增三个阶段。`notRun` 里的成本冲突改为尚未覆盖的其他媒体组合；图片成本冲突已由 `image-cost-guard` 通过。
- `.github/workflows/m4-compose-preflight-e2e.yml`：只在 `feat/m4-compose-preflight` 和 `workflow_dispatch` 上运行。Node 24.21.0，pnpm 10.17.0，真实 Chrome，镜像校验和隔离 Compose 沿用现有 harness。超时 60 分钟。路径不含 `docs/**`。
- `docs/API_CONTRACT.md`：补上这条预检路由。

没有改 Worker 生成或恢复、Provider accounting、M2 状态机、固定 fixture、媒体内容读取、Python 服务、`infra/compose.yaml` 或数据库结构。没有给原始媒体增加审核通过流程，没有修改 `asset_approval_kind_check`。

## Migration

Migration=NO。没有新 Migration，没有改既有 migration、Prisma schema、触发器或约束。仓库已有 migration 和已有 provision 只用于本次新建、身份已核实且迁移前 public 表数为 0 的隔离库 `m3av_36854649492a1`。没有 `DROP SCHEMA`，没有 `TRUNCATE`，没有连接本机已有库，没有用 SQL 伪造业务成功。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`。没有关闭 engine 检查。本机没有 Docker，因此没有执行 `scripts/m3-av-e2e/run.mjs`。既有会 `DROP SCHEMA` 的 integration 套件没有执行。真实页面、API、Worker 和数据库证据来自下面的 Actions。

`pnpm verify` 在实现提交前执行，退出码 0：lint 9/9，typecheck 14/14，test 14/14，build 9/9。

| 命令 | 结果 |
| --- | --- |
| domain `compose-preflight.spec.ts` | 6 passed |
| database `compose-preflight.spec.ts` | 2 passed；database 单元测试合计 18 passed |
| API `compose-preflight.service.spec.ts` | 2 passed；API 单元测试合计 19 passed |
| Web `compose-preflight.spec.tsx` | 2 passed；Web 单元测试合计 63 passed |
| `pnpm m3-av-e2e:check` | exit 0 |
| `pnpm m3-av-e2e:outcome` | exit 0，19 tests passed |
| `pnpm verify` | exit 0 |
| `node scripts/m3-av-e2e/run.mjs` | 本机未执行 |
| 既有 DROP SCHEMA integration | 未执行 |

Web 测试期间有模拟 API 的 `ECONNREFUSED 127.0.0.1:3000`。Worker 单元测试 50 passed。

## Actions

通过运行：

- SHA `67606d3886d7489750ea61c2a82659bf81b5f6c5`
- Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36854649492
- Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36854649492/job/110344146075 ，id `110344146075`
- Artifact `m4-compose-preflight-e2e-evidence` id `11158117791`，4788428 字节，SHA-256 `21ac54e4be29122e5542453b4819ffb8babb4ccfa42171251b2f3871ee061e37`，expires `2026-10-08T11:31:30Z`
- 下载后的 zip 与上述 SHA-256 一致。`results.ok=true`，28 个必需阶段全部 passed。数据库 `m3av_36854649492a1`，迁移前 public 表数 0。MinIO 对象数 0。

## 预检成功

真实页面在当前镜头版本选择 VIDEO、配音、音乐和字幕，调用真实接口。四份原始资产保持 `ACTIVE` / `DRAFT`。返回清单计划为 1080×1920、25fps、MP4，计划时长 1000 ms。`inputHash` 为 `853e9dd89752e59c3c31574fe23756f9377bb385eeda38e65da2e1b7c5ce8a84`。响应 `Cache-Control: private, no-store`，页面请求没有带 `Idempotency-Key`。面板写明“合成尚未执行”，没有“已受理”或“生成成功”。把音乐改回“未选择”后，旧结果和哈希从面板消失。

| 角色 | Asset |
| --- | --- |
| VIDEO | `e5f81c65-ca23-4184-8e72-13e4db6d246f` |
| AUDIO | `b2495c3d-7c02-496f-a195-348345a044a5` |
| MUSIC | `1056ab3a-7a61-47f0-b3f1-4c5b8ef99b38` |
| SUBTITLE | `a5c508a0-62aa-4324-a023-83c0f52f4d55` |

截图 `compose-preflight-page.png` 在 artifact 中。

## 门禁

真实 API 覆盖了错误 kind、跨镜头、跨工作区、旧镜头版本、上游场景被新修订替换，以及 AV 关闭、字幕音乐关闭、production 和默认未设置。相同规范输入的 hash 保持 `853e9dd89752e59c3c31574fe23756f9377bb385eeda38e65da2e1b7c5ce8a84`。换成另一条当前镜头视频 `a2793a18-3952-4b05-bae7-963d0d22a37f` 后，hash 变为 `8a85b38ddab0e30ea6b4dc496a37fc148002c4884cd060257faed4a8c13b14bc`。同一 `Idempotency-Key` 配不同视频没有重放旧的预检通过。

旧镜头版本 `a30b223a-23ad-41df-b49c-720b3edec8f8` 与上游失效后的旁路镜头版本 `31b6aa41-eb5d-4d71-ac1a-c701ffe06f0c` 都返回 `REVIEW_REQUIRED`。旁路场景替换之后，主镜头的同一规范输入仍返回 200。

`REJECTED`、非 `ACTIVE` 和坏元数据没有在真实库里造行。它们由 domain 单元测试里的构造记录覆盖。database 单元测试使用脚本化查询客户端，不打开 PostgreSQL；它检查真实 `assertUsableShotWithClient` 的调用顺序，以及事务里没有 `INSERT`/`UPDATE`/`DELETE`。

## 无写入与浏览器

`compose-preflight-readonly` 在重复预检和负例前后核对了 `generation_job`、`job_attempt`、`workflow_run`、`asset`、`cost_ledger`、`dispatch_outbox`、`domain_event` 的 id 列表，前后相同。当时行数分别是 38、38、38、21、24、38、303。

390px 视口下 `documentOverflow` 和 `bodyOverflow` 都是 0。截图 `compose-preflight-390.png` 在 artifact 中。镜头草稿 `unsaved-draft-m3-av-e2e` 在预检之后仍留在 `#shot-action`。

组件测试覆盖了当前版本选择器、历史资产和 `REJECTED` 不进入选择器、选择改变后立即清空，以及 A→B→A 和请求途中改回原选择时迟到响应不写回。这组测试拦截的是组件单测里的 fetch，不是验收浏览器。

## 模拟测试和真实 API

| 证据 | 做什么 |
| --- | --- |
| domain 构造记录 | 参数负例、哈希稳定性、时长上限、`REJECTED`、非 `ACTIVE`、坏元数据、来源不匹配 |
| database 脚本化查询 | 门禁错误码和事务不写业务行；不是真实 PostgreSQL |
| API service 替身 | 开关关闭和请求形状在进入 store 前拒绝；store 是替身 |
| Web 组件单测 | 选择、清空、迟到响应；fetch 是替身 |
| Actions 真实页面和 API | 成功清单、哈希变化、跨镜头/工作区、旧版本、上游失效、配置关闭、无写入、390px 和草稿 |

## 未执行与遗留

本机没有 Docker，所以本机没有跑完整 harness。没有跑会 `DROP SCHEMA` 的既有 integration 套件。没有安装或重装 Docker。没有改 main，没有 force push、PR、merge、pack 或部署。

`notRun` 仍包括尚未覆盖的其他媒体组合成本冲突、其余暂时故障、隐藏标签页，以及未在本轮触发的 Compose 故障。图片成本冲突不再笼统列为未执行。

预检不解码文件，也不渲染。创建真实合成任务时必须重新验证，并在事务中冻结输入。
