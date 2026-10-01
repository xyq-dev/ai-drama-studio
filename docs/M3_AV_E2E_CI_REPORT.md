# M3 AV E2E CI 报告

## 范围

目录 `D:\Projects\ai-drama-studio`，分支 `feat/m3-av-workbench`。起点 `5470008c6b9b430722f2f9b5d6d0aa7b6151dc18`，其中包含已审查产品源码 `2e7dfb9c437aa56540a073eb49b25975535c780c` 与执行单。产品 API、Web、Worker、database 源码和固定 fixture 未改。

本轮只增加验收脚本、Playwright 开发依赖、feature workflow 和本报告。没有新 Migration。既有 integration 套件未运行。

## 本机命令

| 命令 | 结果 |
| --- | --- |
| `git fetch` + `git merge --ff-only` | exit 0，已在 `5470008` |
| `node --check` 与 `node scripts/m3-av-e2e/check.mjs` | exit 0 |
| `pnpm install`（`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`） | exit 0，增加 `playwright@1.55.1` |
| 相关回归 `turbo run test`（api、web、worker、database） | exit 0。database 5 files / 13 tests，api 7 files / 13 tests，worker 13 files / 41 tests，web 7 files / 56 tests |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9 |
| `docker info` | 本机没有 `docker` 命令，未启动 PostgreSQL、Redis、MinIO、API、Worker、Web 或浏览器 |

Web 模拟测试日志里的 `ECONNREFUSED 127.0.0.1:3000` 来自既有 happy-dom 用例，套件本身通过。这不是真实 API 结果。

## 验收设计

`.github/workflows/m3-av-e2e.yml` 只在 push 到 `feat/m3-av-workbench` 且命中 workflow、验收脚本、package、lockfile、apps、packages 或 `infra/compose.yaml` 时自动运行，另有 `workflow_dispatch`。纯报告更新不在 paths 里。Runner 为 `ubuntu-24.04`，Node 24.21.0，pnpm 10.17.0，`contents: read`，总超时 30 分钟。不读 repository secrets，不使用生产 environment。

`scripts/m3-av-e2e/run.mjs` 使用独立 Compose project，私有 env 放在 `RUNNER_TEMP`。迁移前核对 loopback URL、`current_database`、`current_user` 和 public 表数 0，然后只应用仓库既有 migration，并执行 `workspace:provision`、`mock-media:provision`、两次 `mock-av:provision`。页面点击、同源 202、只读 SQL、Chrome for Testing 播放、幂等、门禁和两例恢复都在该脚本里。失败保持非零退出。证据写入 `m3-av-e2e-output/`，artifact 保留 7 天。清理只 `down -v` 本次 project。

## Actions 第一次运行

验收代码 `7057d43e5d1b4d040c6e5873d82dc20b4f5d64d3`。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36805856314
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36805856314/job/110189910978
- 结论：failure。失败步骤是 “Run real page, API, worker, and database acceptance”，exit 1。
- Checkout、pnpm、Node、frozen install、Chrome for Testing、`pnpm build` 和 harness check 已成功。
- 日志里的失败是 `docker compose up` 拉取 `quay.io/minio/mc` 时返回 `unauthorized`，postgres、redis 和 minio 的 pull 被中断。这发生在应用进程和 Migration 之前。
- Artifact `m3-av-e2e-evidence`：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36805856314 ，artifact id `11137134163`，1702 bytes，到期 2026-10-08。
- 这不是产品缺陷。后续 harness 只把 Docker 配置换成空的匿名配置，避免 runner 凭据被发给 quay.io。`infra/compose.yaml` 未改。

## Actions 第二次运行

验收代码 `f3c0be3609b02a7fbd79895cb1d4be26f04dce43`。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806296139
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806296139/job/110191265251
- 结论：failure。仍停在 `docker compose up`。空的 `DOCKER_CONFIG` 没有避开拒绝。
- 日志：`minio Error unauthorized: access to the requested resource is not authorized`。postgres 与 redis 的 pull 被中断。Migration、API、页面和播放未开始。
- 随后的 harness 从 Docker Hub 拉取同一 MinIO / mc 发行标签，再标记成 compose 文件里的 `quay.io` 名称，并用 `--pull missing` 启动。`infra/compose.yaml` 仍不修改。

## Actions 第三次运行

验收代码 `31012780306e6616659db46dd1555f843cce09c0`。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806545713
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806545713/job/110192042521
- 结论：failure。`docker pull minio/minio:RELEASE.2025-09-07T16-13-09Z` 返回 `pull access denied ... denied: requested access to the resource is denied`。
- Migration、API、页面和播放仍未开始。
- 随后的 harness 改为从 `mirror.gcr.io` 拉取同一标签，再标记成 compose 使用的名称，并用 `--pull missing` 启动。`infra/compose.yaml` 仍不修改。

## Actions 第四次运行

验收代码 `75a4e887a8d0aabf8cb347a7db209c4250261eec`。这是 Actions 实际测试的 SHA。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806846317
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806846317/job/110192983861
- Artifact：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36806846317/artifacts/11137977338 ，id `11137977338`，1646 bytes，名称 `m3-av-e2e-evidence`。
- 结论：failure。Checkout、pnpm、Node 24.21.0、frozen install、Chrome for Testing、`pnpm build`（9/9）和 harness check 已成功。失败步骤仍是 “Run real page, API, worker, and database acceptance”，exit 1。
- `results.json`：docker 阶段 passed。compose 阶段 failed。`docker pull mirror.gcr.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` 返回 `manifest unknown: Failed to fetch "RELEASE.2025-09-07T16-13-09Z"`。拉取按 postgres、redis、minio、mc 顺序执行，失败点是第三个镜像，因此 compose `up` 没有启动。
- `identity` 与 `chrome` 为 null。其后 identity、migrate-provision、processes、source-chain、page-submit、playback、content-headers、png-draft-viewport、idempotency-retry、revision-history、gates、mock-boundary、recovery-disk、recovery-flag 全部 skipped。`composeDown` exit 0。
- 公开镜像源同样拿不到 compose 文件里的 MinIO 发行标签。停止再换 registry，不加入 secrets，不修改 `infra/compose.yaml`。这不是产品缺陷。

## 最终 SHA

Actions 实际测试 `75a4e887a8d0aabf8cb347a7db209c4250261eec`。

- 提交：https://github.com/xyq-dev/ai-drama-studio/commit/75a4e887a8d0aabf8cb347a7db209c4250261eec
- 普通 push：`3101278..75a4e88`，目标 `feat/m3-av-workbench`。没有 force push，没有 main，没有 PR，没有 merge。
- 该次 CI 结论是 failure。镜像拉取之后的报告提交只改本文件，workflow paths 不包含 `docs/**`，不会再触发验收。

## 尚未执行

- 真实页面、API、Worker、PostgreSQL 资产与成本、同源视频/音频播放。四次运行都停在镜像拉取，本机没有 Docker。
- Migration。只允许在 CI 新建且已核验为空的隔离库上执行。四次运行都没有读到 `current_database` 或 public 表数，Migration 未执行，没有 DROP SCHEMA。
- 两次 `mock-av:provision` 幂等核对、页面点击、202、只读账本、Chrome 播放、内容头、PNG、草稿与 390px、幂等与手动重试、版本历史、门禁、MinIO 对象边界、磁盘恢复和关 AV 恢复。
- 成本冲突、全部暂时故障与取消竞争、隐藏标签页，以及 Windows 和其余未触发的 Compose 故障组合。
- 既有 integration 套件、新 Migration、应用 pack、部署、付费 Provider、ComfyUI、真实模型。
