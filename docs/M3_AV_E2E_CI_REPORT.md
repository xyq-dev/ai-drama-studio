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

## 尚未执行

- 真实页面、API、Worker、PostgreSQL、MinIO 和同源播放。本机没有 Docker。
- Migration。只允许在 CI 新建且已核验为空的隔离库上执行，本机未执行。
- 成本冲突、全部暂时故障与取消竞争、隐藏标签页，以及 Windows 和其余 Compose 故障组合。
- GitHub Actions run、job 和 artifacts。本节在 push 之后按实际查询补记。文件落地不是 CI 通过。

## Git

最终 SHA、commit URL、workflow run 和 artifacts 链接在 push 与 Actions 查询后写入下一节。
