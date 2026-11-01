# AI Drama Studio

2026-11-01 当前代码：真实图片/视频/配音/音乐 Adapter、既有 Job/Attempt/Asset 的提交收据与恢复、S3 资产、逐句角色配音及新声音合成 profile、ViMax 单场景规划发送治理已实现并接入 API/Worker/工作台。新能力**默认关闭**；新增 SQL 仍在独立 drafts，业务库未启用。**本轮真实付费模型调用 0、业务库 SQL 0、服务器部署 0**。替身协议和合成素材只证明工程链路，不证明真实 AI 质量。操作入口与验收边界见[运行手册](docs/REAL_MEDIA_RUNBOOK.md)和[接续记录](docs/REAL_PRODUCTION_COMPLETION_PROGRESS.md)。

ViMax 保留 [E1 离线评估](docs/VIMAX_OFFLINE_EVALUATION.md)、[E2-A 只读预览](docs/VIMAX_PLATFORM_PREVIEW.md)和 [E2-B 候选/两段式保存](docs/VIMAX_CANDIDATE_PERSISTENCE.md)，新增一次规划授权、共享写作额度、永久请求身份与 UNKNOWN 保护；真实单场景模型试验仍待授权与验收。角色配音的[设计与当前实现](docs/CHARACTER_VOICE_DESIGN.md)包括声音版本、逐句计划/试听/选用、实测时长 VTT、完整人声混音和原有审核/导出；V1-D 整集补齐已有固定预算、逐句永久身份与取消/显式恢复，新增数据库用例待最终 HEAD CI。保留[原开源调查](docs/VOICE_OPEN_SOURCE_RESEARCH.md)与[设计原型](docs/design/character-voice-preview.html)作为历史依据。

管理员模型配置入口为 `/admin/models`：文本创作支持 DeepSeek、Claude（Anthropic 官方 API）与 OpenAI（千问已退役，历史记录保留可读；DeepSeek 2026-10-17 重新接入，见 [DeepSeek 重新接入](docs/DEEPSEEK_WRITING.md)），密钥加密保存、仅后台配置、API 重启后生效。见 [OpenAI 与 Claude 文本创作](docs/OPENAI_CLAUDE_WRITING.md)。首次由服务器管理员安全初始化；默认不启用，不自动调用模型。见 [管理员配置与部署说明](docs/ADMIN_MODEL_SETTINGS.md)。

站点统一登录：启用 `SITE_AUTH_ENABLED` 后，所有页面与 `/api/v1` 接口由应用自身的账号密码会话保护（`/login`），模型后台不再使用独立令牌。见 [统一管理员登录](docs/UNIFIED_ADMIN_LOGIN.md)。

研发与 Git / 部署权限约定见 [`docs/ENGINEERING_WORKFLOW.md`](docs/ENGINEERING_WORKFLOW.md)：已交办任务验证通过后自动提交、推送、按 PR / CI 集成，并更新已指定测试站点。实际服务器发布结果单独核验。

交付台账见 [`docs/V1_DELIVERY_MATRIX.md`](docs/V1_DELIVERY_MATRIX.md)。本轮开发基线为 `main@0291795029149abcedf7c41bef14c09392ef11bd`；早前 M4 的技术验收仍以 [`docs/M4_CLOSEOUT_REPORT.md`](docs/M4_CLOSEOUT_REPORT.md) 的历史 SHA 为准，不回写为新功能验收。项目范围见 [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)，本地步骤见 [`docs/DEV_RUNBOOK.md`](docs/DEV_RUNBOOK.md)。真实 AI 成片质量、供应商账单、完整生产成本与生产部署仍待验收。

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
services/media-worker    Python 健康检查与独立 FFmpeg 单镜/逐句声音/整集合成 CLI
services/comfyui-adapter ComfyUI Adapter stub
packages/contracts       文本、媒体、声音、规划与健康检查共享契约
packages/database        Prisma + PostgreSQL M1-B persistence/job core
packages/domain          版本/审核/来源、状态机、预检与导出规则
packages/providers       Mock、文本与默认关闭的真实媒体 Adapter
infra/compose.yaml       PostgreSQL、Redis、MinIO
docs/                    已冻结的 V1 架构文档
```

## 前置要求

- Node.js **24.21.0 LTS**（推荐开发和验证环境；由 `.nvmrc`、`package.json#engines` 固定）
- Corepack，以及 package.json 中精确固定的 pnpm 10.17.0
- Python 3.11 或更高版本
- 合成需要 `ffmpeg` / `ffprobe`（含 libx264、AAC、drawtext）；新声音 profile 另需 Noto Sans CJK SC，缺字/缺字体会拒绝编码
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
corepack pnpm run doctor
```

`pnpm verify` 按 lint、typecheck、test、build、`scripts/dev-doctor` 语法与测试、以及既有 Python 合成测试的顺序执行。`pnpm run doctor` 只读检查本机工具和所选配置，不表示服务 ready，也不表示业务闭环通过。pnpm 10.17.0 的 `pnpm doctor` 是它自己的安装检查，不运行本仓库脚本。显式指定 env 文件时使用 `corepack pnpm run doctor -- --env-file .env`。

单独启动：

```powershell
corepack pnpm --filter @ai-drama/api dev
corepack pnpm --filter @ai-drama/worker dev
corepack pnpm --filter @ai-drama/comfyui-adapter dev
corepack pnpm --filter @ai-drama/web dev
```

`pnpm --filter … dev` 不经过 Turbo 的依赖构建。`@ai-drama/contracts`、`domain`、`health`、`providers`、`database` 导出 `dist/index.js`。新检出仓库先按 `docs/DEV_RUNBOOK.md` 做锁定安装、Prisma validate/generate 和 `pnpm build`，再启动应用。初始化终端和应用终端使用同一套只填充未定义变量的配置。

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

## 当前代码与实际启用的边界

真实媒体当前固定为百炼北京 `qwen-image-3.0`、`wan2.6-i2v-flash`、`qwen3-tts-flash`，音乐为 ElevenLabs `music_v2`；精确参数与价格由服务端冻结。不得把文本模型密钥、登录状态或功能开关当成付费授权。每次生成仍需有效报价与一次授权；无法确认的提交保留 UNKNOWN，不能自动重发。使用新声音 profile 还需 Noto Sans CJK SC，缺字或缺字体会在编码前阻断。配置、密钥轮换与三个独立空库验收入口见[运行手册](docs/REAL_MEDIA_RUNBOOK.md)。

ComfyUI/GPU 实际推理、真人声音克隆、口型同步、重叠对白、平台发布、支付/多租户仍未交付。系列 1–60 集只交付文本，媒体生产继续拒绝。真实模型质量、真实费用核对和服务器启用不由代码测试替代。原千问**文本**入口已退役；新增 `DASHSCOPE_MEDIA_*` 是独立媒体配置。历史报告保留原来的 Mock/本地验收口径。
