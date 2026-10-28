# 统一登录安全审查修复报告（PR #63）

针对独立安全审查在 `876c5d17b74f5ce92d3f5a638188b4c618d8831c` 上提出的 2 项 P1、3 项 P2。PR 保持 Draft，待 Codex 复审。

## 现场

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio-unified-login` |
| 分支 | `feat/unified-admin-login` |
| 起始 HEAD | `876c5d17b74f5ce92d3f5a638188b4c618d8831c`（本地、远端、PR #63 一致，工作区干净） |
| 基线 main | `91ed8ad0250407cf1f4e76cedbd8624211feec7c` |
| 工具链 | Node 24.21.0、pnpm 10.17.0（engines 检查开启） |
| 最终 HEAD | 代码修复 `08026f9`；随后一个仅文档提交（见文末） |

范围只限五项。没有改模型保险库、主密钥、模型调用、故事审核、费用、幂等与版本冲突规则；没有新依赖、数据库结构或 Migration；没有部署、服务器操作或真实模型调用。

## S1（P1）空的认证开关导致匿名开放

- **原因**：`loadApiEnv` 对仅进程变量丢弃空字符串，`SITE_AUTH_ENABLED=` 变成 undefined，被解释为“关闭”。
- **修改**：`apps/api/src/config/env.ts` 只对 `SITE_AUTH_ENABLED` 保留显式空字符串，其他变量仍按原规则丢弃；`apps/api/src/auth/site-auth.config.ts` 已把 `"true"`/`"false"` 以外的值（含 `""`）判为 misconfigured，补充说明。未设置与精确 `false` 的语义不变。
- **回归**：`apps/api/src/auth/site-auth-env.http.spec.ts`（真实 `loadApiEnv` → `AuthModule` → HTTP）。空字符串、`yes`、`TRUE`：读写均 503 且不进入控制器；`true` 缺哈希/缺 origin/哈希为空：503；`true` 完整：匿名读 401、匿名写 403（写请求先查 Origin）、登录后 200；`false` 与未设置：保持原开放行为；其他仅进程变量的空值处理不变；`.env` 文件中的开关仍被忽略。

## S2（P1）退出或过期后已建立的事件流仍接收新事件

- **原因**：`/api/v1/events` 只在建立连接时由中间件验证会话，之后每 250ms 读取并输出，不再检查撤销或到期。
- **修改**：
  - `apps/api/src/auth/site-auth.ts` 新增 `watch(headers)`：绑定发起请求的那个会话，返回检查函数；仅当该会话仍存在且未到期时为真；检查不更新最近活动时间，服务端推送不会延长空闲期限。
  - `apps/api/src/studio/studio.controller.ts` 的 `EventsController`：注入站点认证状态（可选）；每次读取前检查；读取返回后、输出前再检查一次（覆盖读取期间退出的竞争），不通过则不发送本次结果并结束连接；`stop()` 幂等，清除定时器并移除 close 监听；客户端断开后不再调度。认证关闭或未接入时行为不变；Last-Event-ID 与游标校验保持原样。
- **回归**：`apps/api/src/studio/events-auth.http.spec.ts`（真实 AuthModule、真实 EventsController、真实 HTTP 流；事件存储与时钟为可控替身，用“读取已进入/读取次数达到”屏障协调）：
  - 有效会话持续收到事件；无会话不能建立连接。
  - 退出后连接结束，之后新增的事件不发送，也不再读取。
  - 读取进行中退出：该次读取返回的新事件不发送，连接结束。
  - 空闲期限前多次定时读取后再到期：连接结束（证明推送不续期）。
  - 期间持续有用户请求，到绝对期限仍结束。
  - 客户端断开后不再读取。
  - 认证关闭时原行为、Last-Event-ID 与过期游标 409 不变。
  - 只有“已结束后不再发生任何读取”的反向断言使用短暂等待（无法用屏障观察“不发生”）。

## S3（P2）部署文档会导致回滚旧 API 失败

- **核对**：在临时基线工作区放入旧版 `91ed8ad` 的 `admin-bootstrap.ts`/`admin-auth.ts`，用虚构配置验证：删除 `MODEL_ADMIN_TOKEN`、`MODEL_ADMIN_PUBLIC_ORIGIN` 后旧版抛出 `ADMIN_NOT_CONFIGURED`；恢复保留的旧环境后通过（2/2）。未连接服务器。
- **修改**：`docs/UNIFIED_ADMIN_LOGIN.md`、`docs/ADMIN_MODEL_SETTINGS.md`：
  - 新增第 0 步：受保护备份 Caddy 配置、systemd 单元、全部 EnvironmentFile 与运行版本；`NODE_ENV` 保持现场实际原值。
  - 统一登录配置写入单独、版本化的新环境文件；回滚窗口内**不修改** `api-admin.env`，旧变量保留。
  - 回滚顺序：恢复 Basic Auth → 恢复旧版所需环境 → 恢复旧应用 → 验证健康与旧令牌登录。
  - 旧凭据清理推迟到回滚窗口结束（第 6 步）。
  - 删除“仅关闭 `SITE_AUTH_ENABLED` 即可回到旧两层登录”的错误说法，并说明原因。

## S4（P2）模型后台用旧到期时间清空仍有效会话的草稿

- **原因**：页面只保存首次读取的 `expiresAt`；之后的读写会延长服务端会话，但定时器仍按旧时间清空草稿、密钥输入并跳登录。
- **修改**：
  - `apps/web/src/components/admin-models.tsx`：定时器到点改为 `confirmExpiry()`，以被动方式重新确认服务端会话。仍有效：只更新会话快照与定时器，不重新安装配置视图，未保存内容保留。服务端明确未登录：按原规则清空并跳登录。网络错误或 503：不当作退出，什么都不清空，30 秒后再查（操作仍由服务端逐次鉴权）。使用独立的进行中标记与请求世代，卸载和结束会话时清除重试定时器，迟到回执被丢弃；未复用 `checkSession()`。定时器最短 250ms，防止提前触发时空转。
  - 被动检查不能续期，否则页面会自己维持会话：`apps/api/src/auth/site-auth.ts` 新增 `peek()`，`auth.controller.ts` 在请求头 `X-Session-Check: passive` 时用它；`apps/web/src/lib/site-session.ts` 的 `readSession` 增加 `{ passive }` 选项。
- **回归**：`admin-models.spec.tsx` 新增 4 项（真实组件、模拟 fetch）：被动检查确认续期后不跳转、不重读配置、模型草稿与密钥输入都保留；服务端确认过期后清空并跳登录；断网与 503 不清空、不跳转；卸载后迟到的过期回执不触发任何动作。`site-auth.http.spec.ts` 新增 1 项：被动检查不延长空闲期限，普通读取会延长。

## S5（P2）验收使用不存在的故事接口

- **修改**：`scripts/site-login-acceptance.mjs` 与 `apps/api/src/auth/site-auth.http.spec.ts` 改为真实路径 `/projects/:projectId/stories`。验收在登录后真实创建作品，先以会话请求该作品的 `/stories`（真实 handler 返回 200），再用无会话的新上下文请求同一路径（401）。
- **文档**：`docs/UNIFIED_ADMIN_LOGIN.md` 写明素材与成片下载用随机 ID，401 只证明认证层在业务前拒绝，不是对真实素材的“登录可下载/匿名被拒”对照。未扩展媒体验收。

## 后端影响与 Migration

- 改动只涉及 API 进程内的认证状态与事件流：会话仍在 API 进程内存中；新增 `watch`/`peek` 只读该内存；事件流改为每次读写前检查会话。
- 对外接口：`GET /auth/session` 增加可选请求头 `X-Session-Check: passive`；未带时行为不变。
- 不触及数据库表、列、索引或数据，因此**不需要 Migration**。

## 执行的命令（本机 Windows，无 PostgreSQL / Docker）

| 命令 | 退出码 | 结果与性质 |
| --- | --- | --- |
| `pnpm --filter @ai-drama/api lint` / `typecheck` | 0 / 0 | — |
| `pnpm --filter @ai-drama/api test` | 0 | 150 通过，43 跳过（仅 POSIX 的保险库/运行时用例，Linux CI 执行）。含 S1、S2 的真实 HTTP 回归 |
| `pnpm --filter @ai-drama/web lint` / `typecheck` | 0 / 0 | — |
| `pnpm --filter @ai-drama/web test` | 0 | 461 通过（模拟 fetch 的组件与库测试） |
| `node --test scripts/{admin-models-init,site-auth-password,render-caddy-site}.test.mjs` | 0 | 6 通过，2 项仅 POSIX 本机跳过 |
| `node --check scripts/site-login-acceptance.mjs` | 0 | 语法检查；该验收只在 CI 的真实 PostgreSQL + Caddy 环境运行 |
| `turbo run build --filter=@ai-drama/api --filter=@ai-drama/web` | 0 | 7 个任务成功 |
| `git diff --check` | 0 | — |

未执行：本机真实浏览器、真实数据库、真实 Caddy（无 PostgreSQL/Docker）——由 CI 的 Unified site login 执行；服务器切换与回滚演练（禁止）；整仓 `pnpm verify`（未改动其他包）。

## 基线对照（临时工作区 `D:\Projects\adsl-baseline-876c5d1`，`876c5d1`，用后删除）

只放入新增的测试文件，不改基线业务文件。

| 用例 | 基线 `876c5d1` | 修复后 | 性质 |
| --- | --- | --- | --- |
| S1 空字符串开关 | 失败：匿名读 200（应 503） | 通过 | 缺陷回归 |
| S1 空值仅对开关保留 | 失败：`""` 被丢弃 | 通过 | 缺陷回归 |
| S1 非法值、`TRUE`、`true` 完整/缺失、`false`/未设置、`.env` 忽略 | 通过 | 通过 | 原有行为守护 |
| S2 退出后结束连接 | 失败：8 秒内连接不结束 | 通过 | 缺陷回归 |
| S2 读取进行中退出 | 失败：连接不结束 | 通过 | 缺陷回归 |
| S2 空闲期限 / 绝对期限 | 失败：连接不结束 | 通过 | 缺陷回归 |
| S2 有效会话收事件、无会话拒绝、断开后停止、认证关闭行为与游标 | 通过 | 通过 | 原有行为守护 |
| S2 基线探针：退出后新请求 401，但旧连接仍收到退出后新增的事件 | 通过（证实缺陷） | — | 缺陷证据（未提交） |
| S3 旧版 bootstrap：删除旧变量 → `ADMIN_NOT_CONFIGURED`；恢复后通过 | 2/2 | — | 文档依据（未提交） |
| S4 续期保留草稿 / 确认过期 / 检查失败 / 卸载迟到回执 | 4 项失败：从不重新确认会话 | 通过 | 缺陷回归 |
| S4 基线探针：服务端仍会确认有效时，旧页面到点清空草稿并跳登录 | 通过（证实缺陷） | — | 缺陷证据（未提交） |

## 提交与 CI

- 授权：本会话此前的任务明确允许普通 commit、push 与更新 Draft PR；本轮未 merge、未转 Ready、未 force push。
- 修复提交：`08026f9cca7c19b60f2d6c7f5dadeb072d02d2cc`（普通 push 到 `feat/unified-admin-login`）。
- 该提交实际触发的 13 个工作流全部成功，包括 **Unified site login**（PR run 38039952914、push run 38039951042）：真实 Chromium → Caddy（仓库模板）→ Next → 真实 API → 新空库，`success:true`、截图 8、pageerror 0、Basic Auth 质询 0；新的同路径对照 `/api/v1/projects/:projectId/stories` 登录 200、匿名 401；运维脚本测试 8/8。证据 `docs/unified-login/site-login-evidence.json`（headSha 为该提交）。
- 其余：Admin model settings、Creator UI checks、Beginner creator web、Writing assistant API、Title writing isolated acceptance、M1-C/M2-A/M2-C/M3-A/M3-B integration、M4 three episode sample 均成功。
- 本报告与证据文件随后作为仅文档提交推送；该提交触发的 CI 以 GitHub 上对应 SHA 为准，不借用上面的结果。

## 遗留

- 会话仍保存在单个 API 进程内存中（设计如此）；多实例部署需另行设计。
- 事件流在下一次授权检查时关闭；若查询正在进行，待查询返回或失败后结束连接。会话失效后，读取返回的事件不会发送。250ms 是空闲轮询间隔，不是连接关闭时延的严格上限。
- 复审版本：代码以 `08026f9cca7c19b60f2d6c7f5dadeb072d02d2cc` 为准；其后只追加本报告与证据文件（文档提交）。
