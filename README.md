# AI Drama Studio

M2 文本 Scene/Shot 生成已通过厂商无关的同步 Adapter 边界运行；契约、恢复限制和验收证据见
[`docs/M2_TEXT_ADAPTER_ACCEPTANCE.md`](docs/M2_TEXT_ADAPTER_ACCEPTANCE.md)。

AI Drama Studio 是一个面向短剧创作的本地优先工作台。当前仓库包含 M1 persistence/job core、M2 文本版本链与创作工作台，以及镜头页上的 Mock 图片入口。公开 API 可分页发现 Character、Location、Scene、Shot，并从历史响应恢复 aggregate 并发版本。Mock 图片是确定性 1×1 PNG 测试图。Mock 视频是固定 16×16 黑色 1 秒 H.264 测试片，Mock 配音是 100ms 静音 WAV。它们按 Asset ID 同源读取，写入显式本地 Mock 目录，不写入 MinIO，也不是真实 AI 视频、对白朗读或付费模型。

文本集合 GET 使用 `limit`（默认 20、最大 100）及不透明 `cursor` 并返回 `nextCursor`；
revision 历史的 `aggregate` 提供 entity/父 scope、`rowVersion` 和 current/approved 指针。
Mock 图片切片是确定性测试路径。开发环境需要显式设置 `M3_MOCK_IMAGE_ENABLED=true` 和绝对路径 `MOCK_OBJECT_DIR`，并在已有 ACTIVE workspace 上执行 `mock-media:provision`。视频和配音另需 `M3_MOCK_AV_ENABLED=true` 与 `mock-av:provision`。这些命令不运行 Migration，也不在 API 或 Worker 启动时自动插入配置。生产环境保持关闭。图片开关不能打开视频或配音。

## 目录

```text
apps/web                 Next.js 创作工作台与状态页
apps/api                 NestJS Core API：健康检查 + M1 项目/Mock 工作流/SSE
apps/worker              NestJS Worker：BullMQ consumer / outbox dispatcher / reconciler
services/media-worker    Python FastAPI 健康检查
services/comfyui-adapter ComfyUI Adapter stub
packages/contracts       健康检查共享类型
packages/database        Prisma + PostgreSQL M1-B persistence/job core
packages/domain          Job 状态机与 WorkflowRun 汇总规则
packages/providers       M1 deterministic Mock Provider
infra/compose.yaml       PostgreSQL、Redis、MinIO
docs/                    已冻结的 V1 架构文档
```

## 前置要求

- Node.js **24.21.0 LTS**（推荐开发和验证环境；由 `.nvmrc`、`package.json#engines` 固定）
- Corepack，以及 package.json 中精确固定的 pnpm 10.17.0
- Python 3.11 或更高版本
- Docker Engine 与 Docker Compose，仅在启动本地 PostgreSQL、Redis、MinIO 时需要

## 环境变量

复制示例文件后再启动服务。PowerShell 使用：

```powershell
Copy-Item .env.example .env
```

Linux/macOS shell 使用：

```sh
cp .env.example .env
```

`.env` 不进入 Git。`.env.example` 只包含本地开发占位值。Web 只读取 `NODE_ENV`、`WEB_PORT` 和 `NEXT_PUBLIC_API_BASE_URL`，不会把数据库或对象存储凭据放进页面。

占位密码需要保持 URL 安全，因为 MinIO 初始化使用 `MC_HOST_local`。

## 默认端口

| 服务 | 端口 | 覆盖变量 |
| --- | --- | --- |
| Web | 3000 | `WEB_PORT` |
| Core API | 3001 | `API_PORT` |
| Worker health | 3002 | `WORKER_HEALTH_PORT` |
| ComfyUI Adapter | 3003 | `COMFYUI_ADAPTER_PORT` |
| Media Worker | 8001 | `MEDIA_WORKER_PORT` |
| PostgreSQL | 55432 | `POSTGRES_PORT` |
| Redis | 56379 | `REDIS_PORT` |
| MinIO API | 59000 | `S3_API_PORT` |
| MinIO Console | 59001 | `S3_CONSOLE_PORT` |

应用默认只绑定 `127.0.0.1`。基础设施端口也只绑定到 `127.0.0.1`。

## Node 与 pnpm

本机 Node 23 的测试结果不代表目标 Node 24.21.0 验收；Node 24.21.0 与 Docker 的集成验证将在 Linux 开发服务器执行。Node 版本不符合 `engines` 时，pnpm 会拒绝执行，不能通过关闭 engine 校验绕过。

```powershell
corepack pnpm install
corepack pnpm dev
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm verify
```

`pnpm verify` 按 lint、typecheck、test、build 的顺序执行。

单独启动：

```powershell
corepack pnpm --filter @ai-drama/api dev
corepack pnpm --filter @ai-drama/worker dev
corepack pnpm --filter @ai-drama/comfyui-adapter dev
corepack pnpm --filter @ai-drama/web dev
```

Worker 启动日志写明 `worker runtime` 和 `queue consumer enabled`。PostgreSQL 仍是业务状态真相；BullMQ payload 保留 `jobId + dispatchSeq`，自定义 queue job ID 使用不含冒号的 `${jobId}__${dispatchSeq}` 编码。

## 数据库 Schema 与 Migration

M1-B Prisma Schema 位于 `packages/database/prisma/schema.prisma`，Migration 位于 `packages/database/prisma/migrations/`。在 PostgreSQL 启动后可执行：

```sh
corepack pnpm --filter @ai-drama/database prisma:validate
corepack pnpm --filter @ai-drama/database prisma:generate
corepack pnpm --filter @ai-drama/database migrate
corepack pnpm --filter @ai-drama/database workspace:provision
corepack pnpm --filter @ai-drama/database mock-media:provision
corepack pnpm --filter @ai-drama/database mock-av:provision
```

首次初始化数据库时，必须在 Migration 后执行 `workspace:provision`。该命令读取服务端配置的 `APP_WORKSPACE_ID`（以及可选 `APP_WORKSPACE_NAME`），只创建该固定 Workspace；已存在但非 `ACTIVE` 时会失败，不会从名称或“第一条记录”推断 Workspace。

`mock-media:provision` 只补当前 workspace 的 `mock-media` / `image.generate`。它要求进程环境中的 `DATABASE_URL`、非生产 `NODE_ENV`、`M3_MOCK_IMAGE_ENABLED=true` 和绝对路径 `MOCK_OBJECT_DIR`。`mock-av:provision` 在同一事务里补 `video.generate` 与 `audio.tts`，要求 `M3_MOCK_AV_ENABLED=true`，不会改图片配置。已有禁用配置或已写入凭据引用时会失败且不覆盖。页面不读取这些服务端变量。

自定义 Migration runner 使用单个 PostgreSQL `PoolClient` 持有 advisory lock，并在该同一会话上执行每个事务；已应用 migration 的 SHA-256 会记录并校验。数据库特有 CHECK、partial index、复合 FK 与 outbox 约束保留在 SQL Migration 中。

真实 PostgreSQL 集成测试会重置目标数据库的 `public` schema，只能指向隔离测试库：

```sh
DATABASE_URL=postgresql://... corepack pnpm --filter @ai-drama/database integration
```

## Python Media Worker

见 `services/media-worker/README.md`。Windows PowerShell 从仓库根目录：

```powershell
python -m venv services/media-worker/.venv
services/media-worker/.venv/Scripts/python -m pip install -e "services/media-worker[dev]"
services/media-worker/.venv/Scripts/python -m pytest services/media-worker/tests
services/media-worker/.venv/Scripts/python -m media_worker
```

Linux 开发服务器使用：

```sh
python3 -m venv services/media-worker/.venv
services/media-worker/.venv/bin/python -m pip install -e "services/media-worker[dev]"
services/media-worker/.venv/bin/python -m pytest services/media-worker/tests
services/media-worker/.venv/bin/python -m media_worker
```

## 基础设施

```powershell
corepack pnpm infra:config
corepack pnpm infra:up
corepack pnpm infra:logs
corepack pnpm infra:down
```

Compose 项目名是 `ai-drama-studio`。它只启动 PostgreSQL、Redis、MinIO 和一次性的 Bucket 初始化。它不部署 ComfyUI，不下载模型，也不自动执行 Migration。

## 健康检查

- Web: http://127.0.0.1:3000
- API live: http://127.0.0.1:3001/api/v1/health/live
- API ready: http://127.0.0.1:3001/api/v1/health/ready
- Worker live: http://127.0.0.1:3002/health/live
- Worker ready: http://127.0.0.1:3002/health/ready
- ComfyUI Adapter: http://127.0.0.1:3003/health/live
- Media Worker: http://127.0.0.1:8001/health/live

API ready 会检查 PostgreSQL、Redis 和 MinIO Bucket。依赖不可用时返回 HTTP 503，响应只包含 `ok` 或 `down`，不包含连接串、密码或堆栈。Web 在 API 不可达时显示 `unavailable`，页面不会崩溃。

## 测试

```powershell
corepack pnpm test
services/media-worker/.venv/Scripts/python -m pytest services/media-worker/tests
```

M1-B GitHub Actions 还会在隔离 PostgreSQL 16 上执行 Prisma validate/generate、真实数据库集成测试、`pnpm verify` 和既有 Python 测试。

## 本阶段明确没有实现

- 真实 AI Provider、视频生成和付费模型
- ComfyUI Workflow 调用
- FFmpeg 合成
- Story/Script/Character/Scene/Shot 等 M2 生产模型
- 登录
- 媒体任务手工 retry
