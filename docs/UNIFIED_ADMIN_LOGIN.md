# 统一管理员登录

目标：只输入一次账号密码，由应用自己维护登录会话，替代当前的两层登录（Caddy Basic Auth 弹窗 + 模型后台的管理员访问令牌），同时保留全站访问保护。

单管理员、单 API 实例。不做注册、找回密码、多租户或角色系统。**无数据库变更，不需要 Migration。**

## 路由保护表

原来所有入口都在 Caddy Basic Auth 之后。切换后由应用本身保护，Caddy 不再弹窗。

| 入口 | 之前 | 现在 |
| --- | --- | --- |
| 页面：`/`、`/create`、`/studio`、`/projects/*`（创作五步、高级编辑、标题创作进度）、`/categories`、`/preview`、`/help`、`/status`、`/admin`、`/admin/models` | Basic Auth | Web 的 `proxy.ts`：每个页面请求都向 API 查询服务端会话；未登录 307 到 `/login?returnTo=<原路径>`，会话过期带 `reason=expired`；登录服务不可用时同样跳转登录页（拒绝，不放行） |
| `/login` | Basic Auth | 匿名可访问（禁止嵌入、no-store） |
| `/_next/static/*`（构建产物，无数据） | Basic Auth | 匿名可访问 |
| `/_next/image`、`/favicon.ico` 等其余路径 | Basic Auth | 同页面，需登录 |
| `/api/v1/*` 全部业务接口：作品、故事、剧本、人物、场地、场景、镜头、任务、成本、事件、标题创作、网页千问、模型后台 | Basic Auth | API 中间件：每个请求校验会话；写请求另需固定 `Origin` 与 `X-CSRF-Token`。未登录 401 JSON，来源/CSRF 不符 403 JSON |
| 素材 `/api/v1/assets/:id/content`、成片下载 `/download`、导出清单 `/export-manifest`（Web 服务端转发） | Basic Auth | 转发时只带上浏览器 cookie，由 API 校验；转发层本身不授予访问 |
| `/api/v1/auth/session`、`/auth/login`、`/auth/logout` | — | 匿名可达；登录全局每分钟 5 次；退出在有会话时需 CSRF |
| `/api/v1/health/live`、`/health/ready` | Basic Auth | 匿名，供运维探针；只返回服务名、版本、依赖 up/down，无业务数据 |
| API 端口（默认 3001）、Worker 健康端口 | 仅本机 | 不变；Caddy 模板只代理到 Web |

匿名例外是方法加精确路径的固定清单（`apps/api/src/auth/site-auth.middleware.ts`），不放行整个 `/api` 或任何动态图片代理。路径变体（大小写、末尾斜杠、`..`）不会命中例外。

## 使用体验

- 统一登录页 `/login`，账号默认 `admin`，输入密码登录。登录成功回到原本要访问的站内页面；直接打开登录页则进入“我的作品”。
- 登录后可进入创作页面和 `/admin/models`，模型后台不再要求管理员访问令牌。
- 刷新保持会话。退出后所有受保护页面和接口都需要重新登录。
- 会话到期：页面和接口把用户带回 `/login?returnTo=…&reason=expired`，提示“登录已过期或已退出”，再次登录回到原页面。
- 退出入口：创作页面共用页眉（桌面）和导航抽屉（手机）的“退出登录”；模型后台的“退出”。两者都是站点退出。
- 界面沿用现有暖白/珊瑚红 token，桌面与 390px 同一套组件。

## 实现

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 密码哈希 | `apps/api/src/auth/password-hash.ts` | Node 内置 scrypt（RFC 7914），16 字节随机盐，N=2^17、r=8、p=1（OWASP Password Storage Cheat Sheet 的 scrypt 最低参数，每次校验约 128 MiB），恒定时间比较。格式 `scrypt$17$8$1$<盐>$<派生值>`，可升级参数；只接受有界范围。不用普通 SHA-256，不自制算法，无新依赖 |
| 会话 | `apps/api/src/auth/site-auth.ts` | 32 字节随机会话 ID，服务端只存其 SHA-256；可撤销；空闲 2 小时、绝对 12 小时；最多 20 个会话；单 API 进程内存，**API 重启后需重新登录**。登录成功总是新建会话（同浏览器旧会话作废） |
| Cookie | 同上 | HTTPS：`__Host-ads_session`（HttpOnly、Secure、SameSite=Lax、Path=/）；`__Host-ads_csrf`（可读、SameSite=Strict，仅用于回显）。本机 HTTP 开发用无前缀名。登录与退出时清除旧的 `ads_admin_session`（Path=/api/v1/admin） |
| 校验 | `site-auth.middleware.ts`、`auth.module.ts` | Nest 中间件作用于所有路由，读请求查会话，写请求再查 Origin 与 CSRF；返回 401/403/503 JSON。不以“cookie 存在”代替服务端校验 |
| 登录接口 | `auth.controller.ts` | 账号不存在与密码错误同一结果，且都完整计算一次 scrypt；限流保留；响应 no-store，不回显密码 |
| 模型后台 | `admin/admin-models.controller.ts` | 改用站点会话与 CSRF；删除令牌登录与 `/admin/session`；站点登录关闭或配置无效时 503，不会匿名开放 |
| 页面保护 | `apps/web/src/proxy.ts` | Next 16 proxy（Node 运行时）调用 API 的 `/auth/session` 校验；跳转用相对 `Location`，不依赖 Host 或转发头 |
| 前端请求 | `apps/web/src/lib/site-session.ts` | 公共客户端（作品、标题创作、网页千问、模型后台）的写请求自动带 `X-CSRF-Token`，原有 `Idempotency-Key`、`If-Match`、冲突处理不变；会话结束时跳登录页并带回原路径 |
| returnTo | 同上 | 只接受以单个 `/` 开头的站内路径；拒绝外站、`//`、反斜杠、控制字符、`/login`、`/api/`、`/_next/` |
| 登录页 | `components/login-page.tsx`、`app/login` | 密码只在表单状态与登录请求中，每次提交后清空；不写 localStorage / sessionStorage |

业务规则不变：模型密钥只写不回显、加密存储、保存与生效版本区分；配置生效与运行中任务的保护；标题创作默认关闭、production 强制关闭；操作者授权、次数限制、结果未知确认、幂等、取消和恢复；故事审核、剧本导入、冲突和来源失效。**登录成功不代表 AI 可用**，不会开启模型调用，也不绕过可能已计费的确认。

## 配置（只读 API 进程环境）

| 变量 | 说明 |
| --- | --- |
| `SITE_AUTH_ENABLED` | `true` 启用统一登录。未设置或 `false`：应用不要求登录（保持旧行为，需外层保护）。其他值或配置缺失/无效：**拒绝所有受保护请求**（503），不回退为匿名 |
| `SITE_AUTH_USERNAME` | 默认 `admin` |
| `SITE_AUTH_PASSWORD_HASH` | 由下面脚本生成的 scrypt 哈希，不是密码 |
| `SITE_AUTH_PUBLIC_ORIGIN` | 浏览器访问的精确 origin，如 `https://drama.playhubs.cn`（无路径、无末尾斜杠）；production 必须 HTTPS |

与 `MODEL_ADMIN_ENABLED` 相互独立：关闭模型后台不影响全站登录保护。登录密码与模型配置加密主密钥完全无关；`MODEL_ADMIN_MASTER_KEY`、`models.enc` 和初始化标记不变。

### 设置或修改密码

密码不经过命令行参数、不打印、不落盘为明文：

```bash
# 交互式：隐藏输入两次，输出到新的私有文件（600，已存在则拒绝）
sudo -u <API_USER> <NODE24_PATH> <RELEASE>/scripts/site-auth-password.mjs --output <PRIVATE_PARENT>/site-auth/site-auth.env
# 或从受保护文件读取（必须是普通文件、非链接、权限 600）
sudo -u <API_USER> <NODE24_PATH> <RELEASE>/scripts/site-auth-password.mjs --password-file <受保护文件> --output <新私有文件>
```

输出文件只含 `SITE_AUTH_USERNAME` 与 `SITE_AUTH_PASSWORD_HASH`。修改密码：生成新哈希，替换 API 受保护环境文件里的这一行，重启 API（所有会话随之失效）。仓库、CI 和测试只使用每次随机生成的测试密码。

### 旧配置的升级与清理

- `MODEL_ADMIN_TOKEN`、`MODEL_ADMIN_PUBLIC_ORIGIN` 不再读取；若仍存在，API 启动时只记录“可删除”的警告，不作为任何登录方式（令牌登录路由已删除）。升级后从 `api-admin.env` 删除这两行；旧 `admin-login.txt` 按运维规程安全删除。
- `scripts/admin-models-init.mjs` 只生成模型保险库配置，不再生成令牌或登录文件；已初始化的服务器不要重新执行。

## Hermes 部署交接

**本 PR 不部署、不改服务器。**以下按顺序执行；每一步通过后再进行下一步。不要把服务器实际凭据写进交接或日志。只改本站点，不动其他站点。

1. **保留现有 Caddy Basic Auth**，准备新配置：
   - 用 `scripts/site-auth-password.mjs` 按用户指定的密码生成哈希（隐藏输入或受保护文件）。
   - 新建受保护环境文件（600，API 服务账号所有），内容：`SITE_AUTH_ENABLED=true`、`SITE_AUTH_USERNAME=admin`、`SITE_AUTH_PASSWORD_HASH=…`、`SITE_AUTH_PUBLIC_ORIGIN=https://drama.playhubs.cn`；在 API 的 systemd 单元追加 `EnvironmentFile=`。只给 API，不给 Web/Worker。
   - 从 `api-admin.env` 删除 `MODEL_ADMIN_TOKEN`、`MODEL_ADMIN_PUBLIC_ORIGIN`。不改 `MODEL_ADMIN_MASTER_KEY`、`MODEL_ADMIN_CONFIG_PATH`、`models.enc` 与初始化标记。
   - 确认 `TITLE_WRITING_ENABLED` 仍为 false/未设，`NODE_ENV=production` 不变。
2. **部署并启用应用层统一登录**（Basic Auth 仍在外层）：按现有手册构建精确 SHA（Web 构建时 `NEXT_PUBLIC_API_BASE_URL` 指向本机 API）；先停旧 API 再启新 API，API 健康后切换 Web。经 Basic Auth 验证：
   - 打开站点任一页面 → 跳到 `/login`；登录一次 → 回到原页面；`/admin/models` 不再要求令牌。
   - 本机绕过 Caddy 直接请求 Web：`curl -sI http://127.0.0.1:<WEB_PORT>/studio` 为 307 到 `/login?returnTo=%2Fstudio`；`curl -s http://127.0.0.1:<WEB_PORT>/api/v1/projects` 为 401 JSON；`/api/v1/health/live`、`/ready` 正常。
   - API 日志中没有 “login configuration is incomplete”。
3. **确认保护完整后才替换 Caddy 站点配置**：用 `node scripts/render-caddy-site.mjs --site drama.playhubs.cn --upstream 127.0.0.1:<WEB_PORT>` 生成新站点块（无 `basic_auth`，只代理到 Web），先 `caddy validate`，再只替换本站点的块并 `caddy reload`。若服务器上有生成 Caddy 配置的脚本或模板，同步改为使用本仓库模板，否则下次部署会重新出现双重登录。
4. **验证**：浏览器只出现一次登录、无 Basic Auth 弹窗；匿名访问页面跳登录、匿名 API 401；退出后旧会话失效（页面跳登录、API 401）；原有创作、模型后台读取正常；标题创作 options 仍为 `enabled=false`；健康检查正常。
5. **回滚顺序**：先恢复外层保护（还原 Caddy 站点块为 Basic Auth 并 reload），再退回旧应用版本；不要先退应用，避免出现匿名开放窗口。若只需退回登录方式，也可在保留 Basic Auth 的前提下把 `SITE_AUTH_ENABLED` 改为 false 并重启 API（站点回到旧的两层登录，模型后台此时返回 503）。

## 验证

见 PR 描述与 CI；结果记录在下方“执行记录”。

### 执行记录

（由本轮实际执行结果填写。）
