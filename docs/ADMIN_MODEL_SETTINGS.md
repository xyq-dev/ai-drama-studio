# 管理员模型配置

入口：`/admin/models`（`/admin` 跳转）。这是独立的管理员入口，不加入创作者导航。
支持标题创作的千问、OpenAI、DeepSeek 密钥、官方端点、模型白名单、默认供应商、每日调用次数和同时运行数。
已有网页千问助手、CLI、媒体 Provider 的配置不受影响。保存配置不会调用模型、不会自动启用标题创作、不会修改数据库。

## 用户操作与真实含义

1. 使用站点统一登录（`/login`，见 [`UNIFIED_ADMIN_LOGIN.md`](UNIFIED_ADMIN_LOGIN.md)）进入；不再有独立的管理员访问令牌。登录账号不是供应商 API Key，也不是标题创作操作者令牌。
2. 选择供应商，填写账户确实可用的模型 ID。千问需填写地域匹配的官方 compatible-mode 地址；OpenAI/DeepSeek 地址固定。
3. 密钥操作有「保持」「替换」「清除」，清除需勾选确认。服务端只返回是否已配置，不返回密钥、尾号或摘要。
4. 保存只做本地格式和白名单校验；“配置就绪”不代表供应商真实可用或真实调用已验收。
5. 页内同时显示已保存与当前生效版本。保存后需要 API 重启；没有自动重启按钮。
6. API 启动时若该工作区存在 `state=running` 的标题创作任务，继续使用持久化的旧 active 快照，显示暂缓生效。
   等任务结束后，由运维再次重启 API 才应用新配置。运行中不会自动热切换，也不会改冻结的模型 ID。
7. 刷新可恢复登录会话，但未提交的密钥、令牌不写入浏览器存储。会话30分钟绝对过期，API重启使所有会话失效。
8. 网络错误或保存结果不明时，先重新读取。页面不自动重放写请求；revision CAS 防止旧页面覆盖新配置。

每日次数（1–500）、并发数（1–10）都是次数限制，不是金额硬预算。原有单任务最多8次、unknown费用、结果不确定须人工确认、操作者授权、生产强制关闭规则全部保留。

## 存储与运行边界

- 无新表、字段或 Migration。AES-256-GCM 密文文件包含 active/saved 和最近50条不含配置值的审计元数据。
- 仅支持单台 Linux、单个 API 实例、单工作区。**先停旧 API，再启新 API；不支持滚动重叠或多个 API 共用配置文件。**
  文件锁只保证配置写入，不能代替跨实例的任务调度屏障。外部模型已有的租约与恢复语义保持不变。
- 私有目录必须是 API 实际用户所有、权限700，文件600；不允许符号链接或硬链接。Windows ACL未实现，Windows启用时明确拒绝；默认不启用时现有应用不受影响。
- 首次启动将当前有效环境配置写入 revision0 密文，并写 `.initialized` 标记。之后 managed 配置有完整优先权：清除的密钥不会回退到旧环境值。
- 关闭 `MODEL_ADMIN_ENABLED` 只关闭登录入口。只要 path/master仍配置，运行时仍使用 managed 配置。
  不要把移除这两个变量当成关闭后台的方法，否则是在运维层明确切回旧环境配置。
- 密文、初始化标记、主密钥需一起安全备份。密文缺失、损坏、主密钥不匹配、标记损坏均拒绝启动或读写；不自动回退旧环境。
  删除密文和标记二者会被视为新的初始化，禁止用此方式“修复”存储。可信本机管理员仍对文件完整性负责。
- atomic rename/fsync，revision CAS，文件独占锁。崩溃残留 `.lock` 不自动抢占；先确认没有存活写进程，再由运维处理。
  rename后fsync失败可能已经保存，必须重新读取revision，不能假定503代表未保存。
- 主密钥、bootstrap配置和站点登录配置只读API**进程环境**，根 `.env` / `NEXT_PUBLIC_*` 无效。
- 后台使用站点会话：写接口先验证会话、固定Origin、`X-CSRF-Token` 和 JSON。站点登录关闭或配置无效时后台返回503，不会匿名开放。
  管理页禁止iframe；接口和页面no-store。反向代理应保留Cookie、Origin、X-CSRF-Token，不记录请求正文或这些认证值。

## Hermes 初始化与部署

本功能本身无需数据库迁移；以发布SHA相对实际运行版本的差异为准。登录方式与 Basic Auth 的切换按 [`UNIFIED_ADMIN_LOGIN.md`](UNIFIED_ADMIN_LOGIN.md) 的顺序进行；保留所有标题创作开关；不修改 `NODE_ENV` 来开启功能。

先独立构建并验证待发布的完整SHA。记录现有Web/API工作目录、版本、代理地址，保留回滚目录。
使用Node24.21.0 / pnpm10.17.0，安装、prisma validate/generate、build均依现有运行手册；**不执行 migrate 或草案**。

一次性准备一个源代码和release目录之外的私有父目录，让API实际服务账号拥有它。不要直接复用只属于ubuntu且权限700的secrets目录，API用户无法遍历。
在已核对路径和账号后执行（占位路径/账号必须替换）：

```bash
sudo install -d -o <API_USER> -g <API_GROUP> -m 700 <PRIVATE_PARENT>
sudo -u <API_USER> <NODE24_PATH> <RELEASE>/scripts/admin-models-init.mjs \
  --directory <PRIVATE_PARENT>/models
```

初始化只创建 `api-admin.env`（600），不生成登录凭据、不打印内容、不连接模型、不修改服务。已经初始化过的服务器不要重新执行。
目录已经存在时拒绝，**不要重新生成主密钥**。初始化失败保留现场，先检查部分文件，禁止盲目覆盖。

给API的systemd单元增加 `EnvironmentFile=<PRIVATE_PARENT>/models/api-admin.env`（使用受保护文件，不内联值）。里面包含：

| 变量 | 用途 |
| --- | --- |
| MODEL_ADMIN_ENABLED | `true`开放管理员接口；不是标题创作开关 |
| MODEL_ADMIN_CONFIG_PATH | 私有目录里的 `models.enc` |
| MODEL_ADMIN_MASTER_KEY | 32字节随机加密主密钥，64位十六进制 |

新版不再读取 `MODEL_ADMIN_TOKEN`、`MODEL_ADMIN_PUBLIC_ORIGIN`（API 启动时只记录可删除的提示，不作为登录方式），站点 origin 改为 `SITE_AUTH_PUBLIC_ORIGIN`。**旧版 API 在后台开启时仍需要这两个变量**，所以在回滚窗口内保留它们和旧 `admin-login.txt`，不要改动此文件；统一登录配置放在单独的环境文件里。确认不再回退后再删除，步骤见 [`UNIFIED_ADMIN_LOGIN.md`](UNIFIED_ADMIN_LOGIN.md) 的 Hermes 交接。

只把此EnvironmentFile注入API，不给Web/Worker。保留已有环境来源；检查 `TITLE_WRITING_ENABLED` 仍为false/未设，操作者令牌没有被替换。
先停旧API再启新API；API健康后切换Web。Worker/media-worker无需因本功能切换；若同次部署还包含其他变更需另作差异核验。

部署后：

1. 核对Web/API进程cwd、git SHA、Web BUILD_ID，live/ready和同源代理。
2. 未登录打开 `/admin/models` 跳转 `/login?returnTo=%2Fadmin%2Fmodels`；未登录GET `/api/v1/admin/models`为401。后台未开启时503属于预期关闭态。
3. 用站点账号登录后回到后台，确认每家供应商只显示“已配置/未配置”，不回显密钥。
4. 标题创作options仍 `enabled=false`；进入后台或保存未产生模型请求。
5. 1440与390页面检查；不要为验收随意填假密钥覆盖服务器真实配置。需要真实供应商验收仍单独授权。
6. 失败回退Web/API服务目录并检查health；保留私有配置目录，不删文件、不执行SQL、不自动回退数据库。

管理员功能完全未配置时，新代码保留既有环境驱动的标题创作行为。配置了加密存储却打不开时失败关闭，先修复私有文件权限或恢复匹配的密文/主密钥，不能移除变量绕过。

## 验证设施

- contracts：严格字段、revision、密钥动作一致性。
- API：真实临时文件加密、权限、篡改、marker、并发CAS；真实Nest HTTP的登录/CSRF/错误保护；真实StudioRuntime装配配合数据库边界替身。
- Web：组件交互、密钥清理、冲突/错误/会话恢复，另有真实浏览器同源HTTP验收。
- `scripts/admin-models-browser-server.mjs` 只在显式 `ADMIN_MODELS_BROWSER_ACCEPTANCE=local-temporary-storage` 下启动loopback验收服务。
  使用真实站点登录/controller/service/vault、一次性私有目录与每次生成的测试密码；没有数据库连接，所有出站fetch拒绝。它不属于生产入口。
- 本地初始化脚本测试由 `pnpm verify` 覆盖。

真实供应商连接、计费、服务器部署和已有数据库未因这些测试获得验证。
