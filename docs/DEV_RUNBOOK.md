# 开发运行手册

本文只说明现有源码的本地开发路径。它不新增功能，不改变开关默认值，也不表示环境已经部署或业务闭环已经通过。完整 M4 和完整生产成本仍未验收。

Linux Ubuntu 24.04 是现有 GitHub Actions 的真实运行系统。Windows 只记录本仓库能在 Windows 上检查的命令和限制。没有 Docker 时，不能把 Linux CI 写成 Windows 启动验收。

## 1. 准备工具

需要：

- Node.js `>=24.21.0 <25`。仓库用 `24.21.0` 作为开发和 CI 版本。
- pnpm `10.17.0`。
- 一个明确选定的 Python 3.11 或更高版本，以及该解释器里的 pytest。
- `ffmpeg` 和 `ffprobe`。Ubuntu 24.04 CI 固定 `ffmpeg=7:6.1.1-3ubuntu5`，并要求 `libx264` 与 `subtitles` 滤镜。Windows 需要自行提供这两个命令，本文不要求重装 Docker，也不把该 apt 版本写成 Windows 已安装。

三个 Python 用途不同：

| 变量或命令 | 作用 |
| --- | --- |
| `MEDIA_WORKER_PYTHON` | 只给 `pnpm verify` 里的 `scripts/run-media-worker-tests.mjs`。未设置时 Windows 用 `python`，其他系统用 `python3`。空字符串不会改选另一个解释器。 |
| `M4_COMPOSE_PYTHON` | Worker 调用 `media_worker.compose_cli` 和 `media_worker.episode_compose` 的解释器。变量不存在时 Worker schema 默认 `python3`。 |
| `python -m media_worker` | Python HTTP health 进程。`/health/live` 和 `/health/ready` 不执行合成。 |

只读检查：

```powershell
corepack pnpm run doctor
corepack pnpm run doctor -- --env-file .env
```

pnpm 10.17.0 把 `pnpm doctor` 保留给它自己的安装检查。本仓库的只读检查是 `pnpm run doctor`。

`doctor` 只探测选定解释器和配置字段。它不安装软件、不启动服务、不建目录、不连数据库、不改 env 文件。工具通过只表示命令和字段可检查，不表示 API ready 或页面闭环通过。开关保持 false 是正常结果。

## 2. 配置环境

```powershell
Copy-Item .env.example .env
```

```sh
cp .env.example .env
```

`.env` 不进入 Git。所有 Mock、样片和合成开关在示例里都是 `false`。可选目录只写在注释里。不要把 `MOCK_OBJECT_DIR`、`M4_COMPOSE_WORK_DIR`、`M4_COMPOSE_OBJECT_DIR` 或 `M4_COMPOSE_PYTHON` 设成空字符串；对应 schema 是 `z.string().min(1).optional()`，空值会导致 API 或 Worker 拒绝启动。`COMFYUI_BASE_URL` 是 adapter schema 允许的空字符串，不要照这个写法去清空上面的可选路径。

`pnpm infra:config`、`infra:up`、`infra:down` 和 `infra:logs` 固定使用 `--env-file .env.example`。本轮不改变这些命令。API、Worker 和 Web 读取仓库根目录 `.env`，进程环境里已经存在的同名变量优先，包括空字符串。因此 `.env` 里的数据库主机、端口、库名和用户要与 `.env.example` 的 `POSTGRES_HOST`、`POSTGRES_PORT`、`POSTGRES_DB`、`POSTGRES_USER` 一致，应用才会连到 Compose 创建的库。

API 与 Worker 的读取代码是 `loadApiEnv(process.env, readEnvFile(仓库根/.env))` 和 `loadWorkerEnv(process.env, readEnvFile(仓库根/.env))`。Web 的 `loadWebPublicEnv()` 只合并 `NODE_ENV`、`WEB_PORT`、`NEXT_PUBLIC_API_BASE_URL`。

数据库命令并不都读 `.env`：

| 命令 | 实际输入 | 写入 |
| --- | --- | --- |
| `pnpm --filter @ai-drama/database migrate` | 只读进程环境的 `DATABASE_URL` | 写入 schema。对 `DATABASE_URL` 指向的库应用已有 migration。 |
| `pnpm --filter @ai-drama/database workspace:provision` | 进程环境优先，缺失时读仓库根 `.env` 的 `DATABASE_URL` 与 `APP_WORKSPACE_ID` | 写入一行 workspace。已存在且不是 `ACTIVE` 时失败。 |
| `mock-media:provision`、`mock-av:provision`、`mock-sm:provision` | 只读进程环境 | 写入当前 workspace 的 provider 配置。默认路径不执行。 |

下面这段 PowerShell 只把 `.env` 载入当前进程，不打印值。migrate 和 mock provision 需要它；API 和 Worker 自己会读文件，不依赖这段。

```powershell
Get-Content .env | ForEach-Object {
  $line = $_.Trim()
  if ($line.Length -eq 0 -or $line.StartsWith("#")) { return }
  if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }
  $separator = $line.IndexOf("=")
  if ($separator -le 0) { return }
  $name = $line.Substring(0, $separator).Trim()
  $value = $line.Substring($separator + 1).Trim()
  if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
    $value = $value.Substring(1, $value.Length - 2)
  }
  Set-Item -Path "Env:$name" -Value $value
}
```

```sh
set -a
. ./.env
set +a
```

## 3. 启动基础设施

```powershell
corepack pnpm infra:config
corepack pnpm infra:up
```

Compose 项目名是 `ai-drama-studio`。它启动 PostgreSQL、Redis、MinIO 和一次性 bucket 初始化，不执行 Migration。`infra/compose.yaml` 里的镜像名是 `postgres:16.15-alpine`、`redis:7.4.11-alpine`、`quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z` 和 `quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z`。

MinIO 的已知限制：匿名拉取 `quay.io`、Docker Hub 和 `mirror.gcr.io` 上的这两个 tag 在 CI 中失败过。CI 的处理在 `scripts/m3-av-e2e/run.mjs`：下载 GitHub Release 二进制，校验 SHA-256 后在 runner 本地打上 Compose 使用的 tag。minio 为 `7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f`，mc 为 `01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891`。这个本地 tag 没有上游 OCI RepoDigest，不能写成正式上游镜像。`compose.yaml` 没有改成镜像站地址。PostgreSQL、Redis 和 Alpine 在 CI 中来自 `mirror.gcr.io` 后再 tag 回 Compose 名称。本机 `pnpm infra:up` 仍按 Compose 文件里的名称拉取，本文不改该命令。

专用库是空 volume 第一次由 `.env.example` 的 `POSTGRES_DB` 创建出来的 `ai_drama`。不要把 `DATABASE_URL` 指到已有业务库。不要对这个库执行 `pnpm --filter @ai-drama/database integration`，该套件会重置 `public` schema。

## 4. 显式初始化和 provision

这两步都会写入专用开发库。本文只给出命令，不在编写手册时执行它们。

载入进程环境后：

```powershell
corepack pnpm --filter @ai-drama/database prisma:validate
corepack pnpm --filter @ai-drama/database prisma:generate
corepack pnpm --filter @ai-drama/database migrate
corepack pnpm --filter @ai-drama/database workspace:provision
```

`migrate` 写入已有 migration。`workspace:provision` 写入 `APP_WORKSPACE_ID` 对应的 ACTIVE workspace。两者都不删除持久化卷。

图片、视频、字幕和样片的 provision 命令仍是可选写入。开关保持 false 时不要执行。打开某一项时，先在进程环境里把对应开关设为 `true`，并把目录设成已存在的绝对路径，再执行对应的一条：

```powershell
corepack pnpm --filter @ai-drama/database mock-media:provision
corepack pnpm --filter @ai-drama/database mock-av:provision
corepack pnpm --filter @ai-drama/database mock-sm:provision
```

样片没有单独的 provision 命令。它要求 `M4_MOCK_SAMPLE_VIDEO_ENABLED=true`、`M3_MOCK_AV_ENABLED=true` 和绝对 `MOCK_OBJECT_DIR`，并且不是 production。单镜合成要求 `M4_LOCAL_COMPOSE_ENABLED=true`、绝对 `MOCK_OBJECT_DIR`、绝对 `M4_COMPOSE_WORK_DIR` 和绝对 `M4_COMPOSE_OBJECT_DIR`。集级合成再要求 `M4_LOCAL_EPISODE_COMPOSE_ENABLED=true` 和这两个合成目录；它不读取 `MOCK_OBJECT_DIR`。production 强制关闭这些开关。启动进程不会自动 provision。

## 5. 启动应用并检查 ready

在三个终端启动：

```powershell
corepack pnpm --filter @ai-drama/web dev
corepack pnpm --filter @ai-drama/api dev
corepack pnpm --filter @ai-drama/worker dev
```

Worker 日志包含 `worker runtime` 和 `queue consumer enabled`。需要 HTTP health 时，另用选定的虚拟环境执行 `python -m media_worker`。该进程不是合成 CLI。

检查：

- Web: http://127.0.0.1:3000
- 状态页: http://127.0.0.1:3000/status
- API live: http://127.0.0.1:3001/api/v1/health/live
- API ready: http://127.0.0.1:3001/api/v1/health/ready
- Worker live: http://127.0.0.1:3002/health/live
- Worker ready: http://127.0.0.1:3002/health/ready

API ready 检查 PostgreSQL、Redis 和 MinIO bucket。失败时 HTTP 503，响应只有 `ok` 或 `down`。`pnpm doctor` 的工具通过不能代替这次 HTTP 检查。

页面操作从首页的「创建项目」开始，提交后进入 `/projects/<projectId>`。创建项目会写入专用开发库。开关仍是 false 时，页面不会打开 Mock 生成或本地合成。

## 6. 正常停止

在 Web、API 和 Worker 终端使用 Ctrl+C。然后：

```powershell
corepack pnpm infra:down
```

`infra:down` 是 `docker compose down`，不带删除 volume 的参数。命名卷 `ai-drama-postgres` 和 `ai-drama-minio` 保留。正常停止不删除数据，不执行 Migration，也不执行 provision。

## 7. Windows 与 Linux

Ubuntu 24.04 CI 已经跑过集成 workflow 和 52 阶段验收。那些结果属于对应 Run，不属于本机 Windows。

Windows 上可以执行 `pnpm doctor`、`pnpm verify` 和本文的命令语法检查。`verify` 里的 Python 合成测试在没有符号链接权限或没有 Linux `PR_SET_PDEATHSIG` 时会跳过对应用例。没有 Docker 时，不执行 `infra:up`、migrate、provision、ready 或页面操作，也不把它们记成通过。
