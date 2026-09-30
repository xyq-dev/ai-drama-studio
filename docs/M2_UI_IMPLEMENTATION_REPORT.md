# M2 创作工作台实现报告

## 现场

- 目录：`D:\Projects\ai-drama-studio`
- origin：`https://github.com/xyq-dev/ai-drama-studio.git`
- 分支：`feat/m2-creator-ui`
- HEAD：`6548ffe07f54a03ac2c5547d7b724cb329af5932`
- 本次 fetch 后 `origin/main` 仍是该 SHA，包含已合并 PR #39。
- 仓库根目录没有 `AGENTS.md`。
- 已有未提交 UI 文件全部保留。未 reset、clean、stash 或覆盖。
- fsync 诊断在旁路 worktree `D:\Projects\ai-drama-studio-fix-mock-object-store-windows`，分支 `fix/mock-object-store-windows`。没有复制或合并到本分支。

## 本轮核对后保留的实现

路由仍是 `/`、`/projects/[projectId]`、`/status`。浏览器请求同源 `/api/v1`，rewrite 到已校验的 `NEXT_PUBLIC_API_BASE_URL`，默认 `http://127.0.0.1:3001`。

写请求使用公开 GET 的版本，不从 `revisionNo` 推算 `If-Match`，也不读取 ETag：

- 故事创建/审核，以及角色/场地首版：`Project.version`
- 剧本创建/审核，场景首版：`Episode.rowVersion`
- 角色/场地后续修订和审核：实体 `rowVersion`
- 镜头首版：`Scene.rowVersion`
- 场景/镜头后续修订和审核：对应实体 `rowVersion`
- 审核 `expectedReviewVersion` 来自被审核 revision

保存走创建 revision 的 POST。历史只读，没有 set-current 或回滚。比较默认最新与上一版；只有一版时显示空状态。未知 JSON 字段保留。409 保留草稿，重新读取后再由用户提交，并更换幂等键。Mock 按钮写明处理固定三集，不覆盖已占用的 ordinal 1。202 之后只显示任务已受理，再查 `workflow-runs`。

标题和梗概创建后只读。`StudioController` 仍只有项目创建和读取，没有更新接口。

## 本轮实际修改

- 剧本当前版本改为 `Episode.currentScriptRevisionId`。该 id 不在已加载页时停止保存，不再用 `revisionNo` 挑一版来编辑。
- 审核、Mock 提交、取消和重试在同一次失败重试中复用幂等键。409 先重新 GET，用户再次操作才使用新基线和新键。
- 正文 409 后重新加载服务端内容，草稿仍留在原来的 `project/entity/baseRevision` 键下。
- 新建场景遇到 409 时刷新集版本，不自动再提交。

故事列表没有 `currentStoryRevisionId`。已加载页里 `revisionNo` 最大的一项只用于显示和选择来源正文；并发版本仍是 `Project.version`。服务端拒绝来源时以响应为准。

## 测试

本轮执行且通过：

- `pnpm --filter @ai-drama/web test`：5 files，14 tests
- `pnpm --filter @ai-drama/web lint`
- `pnpm --filter @ai-drama/web build`（含 TypeScript）

对应未变更测试代码的既有证据：上一轮同样的 14 项 Web 测试、lint、typecheck 和 build 已通过。本轮再次执行了 test、lint 和 build。

失败项：无新的 Web 失败。

当时未执行：

- UI 分支 `pnpm verify`。当时 fsync 修复还在独立 worktree。后续集成和验证见文末「M2 本机最终收尾」。

## M2 收尾

本轮只补已有工作台的缺口，没有重做界面，也没有改 API、Worker、数据库或 fsync worktree。

- 项目、集、场景、镜头、角色历史和任务轮询在切换对象后丢弃旧响应。
- 场景和镜头列表按 `nextCursor` 加载更多；切换父对象仍由 `applyPage` 重置。
- 场景修订和镜头修订在 409 时重新 GET 当前版本并展示差异，草稿保留，确认后才用新基线和新幂等键。
- 任务状态显示进行中、成功、失败、已取消，并保留原始状态码。Mock 入口写明固定三集、ordinal 1 和已通过且 CURRENT 的前置条件；202 只表示受理。
- 长正文区域限制最大高度并可滚动。窄屏比较区保持单列。

`shouldApplyLoad` 覆盖在 `studio-model.spec.ts` 既有用例中。JSON 保留、键顺序、数组顺序、版本头、409 草稿、分页重置、空 revision、轮询停止仍由原有 Web 测试覆盖，没有另写重复用例。这些是模拟数据的单元测试，不是真实 API 联调。

本轮执行且通过：

- `pnpm --filter @ai-drama/web test`：5 files，14 tests
- `pnpm --filter @ai-drama/web lint`
- `pnpm --filter @ai-drama/web typecheck`
- `pnpm --filter @ai-drama/web build`

当时未执行 `pnpm verify`。集成后的结果见文末。

## 环境与浏览器

`docker` 不在 PATH。仓库没有 `.env`。Web `3000`、API `3001`、PostgreSQL `55432`、Redis `56379` 均未监听。没有启动 Compose、Web、API 或 Worker，也没有做真实浏览器闭环。

未执行：故事及三集剧本审核、Mock Scene、审核、Mock Shot、单镜第二版、历史比较、刷新恢复。没有用拦截响应冒充联调。

未执行 Migration、`workspace:provision`、Commit、Push、PR、Merge、Pack、Deploy。

## M2 本机最终收尾

目录 `D:\Projects\ai-drama-studio`，分支 `feat/m2-creator-ui`，HEAD `6548ffe07f54a03ac2c5547d7b724cb329af5932`。原有未提交文件保留。fsync worktree `D:\Projects\ai-drama-studio-fix-mock-object-store-windows` 仍在，未删除。

已完成：

- 审查后把 worktree 中的 `local-mock-objects.ts` 与 `local-mock-objects.spec.ts` 原样复制到本工作区。只在 Windows 且目录 `sync` 返回 `EPERM` 时继续；文件 sync 仍强制执行。这不保证断电后的目录项持久性。
- 写入本机隔离配置 `.env.m2-e2e`（被 `.gitignore` 的 `.env.*` 忽略）。计划端口：Web `3300`、API `3301`、Worker `3302`、PostgreSQL `55433`、Redis `56380`、MinIO `59010`/`59011`。数据库名 `ai_drama_m2_e2e`。
- 集成后在本工作区执行 `pnpm verify`，退出码 0。其中 `@ai-drama/worker` 测试 22 通过，含 `local-mock-objects.spec.ts` 5 项（真实文件系统 1 项，注入 I/O 4 项）。

Docker Desktop 安装失败，不是未执行：

- 安装包 `Docker Desktop Installer.exe` 4.93.0（240920），598MB，已下载到本机临时目录。
- 当前进程最初不是提升权限。随后以管理员身份重跑，完整性级别为 High。
- 安装器退出码 1。日志 `C:\ProgramData\DockerDesktop\install-log-admin.txt`：Windows 10 Enterprise 1809，Build 17763。前置检查失败，要求 Windows 10 22H2（19045）或 Windows 11 23H2（22631）及以上。2024-03-28 的 4.28.0 安装记录也因版本低于 19044 失败。
- `docker` 不在 PATH，`C:\Program Files\Docker` 不存在。隔离端口 3300、3301、3302、55433、56380、59010、59011 均未监听。

因此以下未执行，不能写成通过或失败：

- Compose 项目 `ai-drama-m2-e2e` 未启动。
- 未连接测试库，未核实库归属，未执行 Migration，未执行 `workspace:provision`。
- Web、API、Worker 未启动，没有健康检查结果。
- 真实浏览器闭环未执行：故事、三集剧本、审核、Mock Scene、审核、Mock Shot、单镜第二版、版本比较、冲突草稿、刷新恢复、任务状态。
- 计划页面 `http://127.0.0.1:3300` 没有服务。

人工阻塞：把 Windows 升级到 10 22H2（19045）或 Windows 11 23H2（22631）之后，再执行已下载的安装器：

`DockerDesktopInstaller.exe install --quiet --accept-license`

升级后用 `.env.m2-e2e` 和 `docker compose -p ai-drama-m2-e2e -f infra/compose.yaml --env-file .env.m2-e2e up -d` 启动隔离依赖。Migration 必须显式传入该文件中的 `DATABASE_URL`，不能依赖自动读取 `.env`。

全仓 `pnpm verify` 已通过。真实浏览器联调未执行。Docker Desktop 安装失败，隔离环境未启动。本报告随 `feat/m2-creator-ui` 提交。不推送 main，不创建 PR，不合并，不 pack，不部署。
