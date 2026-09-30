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

## Codex review 7748960 修复

审查对象是 `7748960b13c361dc11239084c4f404d1dba89aa7`。修复仍在 `feat/m2-creator-ui`，只改 Web 工作台、Web 测试依赖和本报告。没有改 API、数据库、Worker 或业务规则。没有重做整套工作台。

1. 切换角色、场地、场景或镜头后，只有已加载且 `entityId` 与当前选择一致的表单可以提交。迟到或失败的读取被丢掉，失败时不再留下上一对象的可保存表单。未提交内容按对象草稿恢复，不靠卸载 key 丢掉输入。
2. 正文、新建角色/场地、新建场景、新建镜头、场景修订和镜头修订在输入时写入草稿，键为 `project/entity/baseRevision`。刷新、切换和失败后恢复字段、来源和未完成的高级 JSON。正文与 JSON 共用当前对象，未知字段保留。保存成功只在存储指纹仍等于本次提交快照时清除草稿，保存期间的新输入留下。没有草稿的新建表单回到空值，不残留另一对象。
3. 冲突未解除时，普通“保存新版本”不可用，也不会提交。界面展示服务端差异和已经看到的并发版本。确认只用该快照版本和新的幂等键。服务端再变会再次 409，不会自动改到更新的版本。基线重读失败时草稿保留，确认按钮不可用。同一次确认的 path、body、If-Match 和幂等键来自同一次快照；同一快照重试复用键。
4. 角色和场地在保存、审核和冲突重读后重新读取 aggregate 与 revisions。新版本进入历史和比较。提交审核后可以继续通过。下一次保存使用重新读取到的 rowVersion。
5. 角色、场地和镜头修订从来源列表选择当前、已批准且 CURRENT 的来源。过期或非当前项不能选。来源写入草稿和请求；更换来源后幂等键更新。旧 STALE 修订保留，历史不改写。保存新 revision 才接上可用链路。
6. 文本任务从可轮询进入终态时，重新读取项目基线和受影响的剧本、场景或镜头。人留在原页面即可看到新结果。草稿仍按各自的键恢复。终态停止轮询；页面隐藏时暂停；回到可见时重读；过期响应不覆盖新请求。

`apps/web/src/components/workbench.review.spec.tsx` 挂载 `Workbench`，用模拟 `fetch` 触发输入、切换和提交。这不是真实 API 联调。覆盖：角色 A/B 迟到响应后的提交路径和正文；加载失败不再展示旧表单；新建表单按类型恢复；JSON 往返和未完成原文；在途保存后的新输入；故事、场景、镜头的 409 普通保存被阻断，确认后的再次竞争仍返回冲突；基线重读失败保留草稿；角色保存后历史刷新，并连续提交审核和通过；剧本换版后角色可保存新来源；场景换版后镜头可保存新来源且旧 STALE 仍在；同级镜头切换；任务成功后场景列表刷新且剧本草稿还在；隐藏时不轮询，返回后重读。

本轮 `pnpm verify` 退出码 0。其中 lint、typecheck、test、build 均成功。Web 测试 6 个文件、30 项通过，含上述 16 项模拟交互。没有关闭 engine 检查。Node 使用 24.21.0，pnpm 10.17.0。

未执行，不能写成通过或失败：真实浏览器、真实 API、Compose、Migration、`workspace:provision`、Docker 重装。此前 Docker Desktop 安装失败的结论不变。没有创建 PR，没有合并，没有 pack，没有部署，没有推送 main。
