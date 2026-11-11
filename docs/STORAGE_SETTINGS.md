# 对象存储设置

本次新增 `/settings/storage`，为当前 `APP_WORKSPACE_ID` 配置腾讯云 COS、阿里云 OSS、Amazon S3、MinIO。页面采用“保存草稿 → 测试连接 → 确认启用”。代码接入 API 读取和 Worker 真实媒体写入；保存草稿不会切换运行配置。

## 启用前准备

新增结构是独立 SQL 草案：`packages/database/prisma/drafts/20261111000100_storage_settings.sql`，依赖普通迁移的 `workspace` / `asset` 表。普通 migrate、启动和 GET 都不会安装它。本次没有执行业务数据库 Migration，也没有使用真实云凭据进行测试。上线安装草案须独立核对目标数据库、最终审查提交、备份与授权。

全部开关仅来自进程环境，`.env` 文件中的同名值不会被读取：

| 变量 | 用途 |
| --- | --- |
| `STORAGE_SETTINGS_ENABLED=true` | 开放存储设置后台；还必须启用有效的站点登录。缺省关闭。 |
| `STORAGE_SETTINGS_KEY` | 规范 base64 编码的 32 字节随机主密钥。API/Worker 必须使用同一值，按服务器 secret 管理，不交给浏览器，不写入 Git。与模型/收据密钥分别管理。 |
| `STORAGE_SETTINGS_ALLOWED_ENDPOINTS` | 以逗号分隔的 MinIO HTTPS origin 白名单；例如 `https://objects.example:9000`。只允许管理员在进程环境配置，页面不能扩大白名单。云厂商 endpoint 使用固定官方域名，不需要该白名单。 |

API/Worker 必须使用同一 workspace、数据库、主密钥和 endpoint 白名单。现有真实媒体准入、站点认证、收据解密配置仍然有效。先暂停新任务并排空在途任务，再更新全部 API/Worker，确认全部版本一致后才启用存储切换，避免旧版本 Worker 绕过新路由。开启配置但缺少 SQL/有效主密钥会拒绝启动；不要用删除主密钥暂停功能。

第一次保存草稿或预留媒体对象时，会将原 `S3_*` 完整配置加密冻结为 legacy。此后环境变量变化不改变历史对象的读取位置。第一次启用前，API/Worker 原 `S3_*` 必须一致且仍能访问全部历史 S3 资产。

## 参数与操作

| 服务商 | Region 示例 | Endpoint 示例 | Path style |
| --- | --- | --- | --- |
| 腾讯云 COS | `ap-guangzhou` | `https://cos.ap-guangzhou.myqcloud.com` | 关闭；Bucket 包含 `-APPID` |
| 阿里云 OSS | `cn-hangzhou` | `https://oss-cn-hangzhou.aliyuncs.com` | 关闭；Region 不带 `oss-` 前缀 |
| Amazon S3 | `us-east-1` | `https://s3.us-east-1.amazonaws.com` | 可选；中国地域使用 `.amazonaws.com.cn` |
| MinIO | `us-east-1` | 服务器白名单内的 HTTPS origin | 开启 |

存储前缀可为空或 `drama/assets`，保存会去除末尾 `/`；拒绝绝对路径、点段、双斜线与查询串。Bucket 限制为无点小写字母、数字和连字符，防止虚拟主机 TLS 歧义。当前不支持自定义 CDN/公开下载域名，媒体继续经过已认证 API、命名空间、大小与 SHA-256 验证。

密钥只可成对替换；同服务商留空选择“保留”时沿用当前草稿（没有草稿则沿用当前生效配置）。切换服务商必须填写一对新凭据。凭据 ID 和 secret 都不回传，界面只显示是否已配置。

1. 保存草稿：只生成新的不可变加密版本，旧测试结果失效。
2. 测试连接：明确同意后，服务器在所选前缀下创建一个 `.ads-storage-probe/<随机UUID>` 对象，写入 32 字节，尝试一次不同内容的条件写以确认不会覆盖，读回验证，再删除自己的 probe。会发生实际对象存储请求，可能产生请求、存储、流量等小额费用；不调用生成模型。它不验证账号全部权限、桶公开策略或生产容量。
3. 测试通过后 15 分钟内显式确认启用。并发修改、测试失败或超时会阻止启用。启用后新的对象预留使用该配置，API/Worker 每次按数据库权威读取，无需进程内热更新广播。

测试只有整个流程（含清理）成功才标记通过。网络丢失可能使云端已写成功但本地不知道版本 ID；此时只对本次随机 probe 尽力清理，测试失败，操作者应检查 `.ads-storage-probe/` 残留。服务端错误返回固定文本，不返回签名 URL、供应商响应或密钥。

COS/OSS 使用原生签名，不走“伪 S3”协议；因 `forbid-overwrite` 在版本控制桶中不能保证不覆盖，测试与每次原生写入先检查桶版本状态，拒绝 Enabled/Suspended。运行中不得开启 COS/OSS 桶版本控制；若检测到检查后状态变化返回 version ID，该写入不发布为资产。S3/MinIO 采用 `If-None-Match: *`，测试会拒绝不支持条件写的旧服务端。

服务商最小权限需包含指定桶/前缀的读、条件写及 probe 删除；COS/OSS 还需查询桶版本状态。桶须由操作者配置为私有；本功能不修改桶策略。使用受限凭据，不在普通应用账号中授权桶管理。

## 历史对象和故障边界

数据库保存不可变配置版本与对象绑定，秘密使用 AES-256-GCM 加密，并将 workspace/version 作为 AAD。公开字段也包含在加密载荷中。每次写入前，在与启用操作相同的工作区锁内预留逻辑对象 key → 配置版本；上传失败重试也回到原位置。历史没有绑定的对象始终走冻结 legacy；不迁移、不重写已有资产。

资产内部仍使用既有 `storage_provider='s3'` 和 `real-media/{workspace}/{project}/{job}/{attempt}/{sha256}.{ext}` 作为逻辑标识，以保留现有来源约束。物理服务商、bucket 和前缀由持久绑定解析。不能把这个兼容字段当成当前物理服务商。API 和 Worker 均通过同一存储路由读取。

关闭 `STORAGE_SETTINGS_ENABLED` 只关闭管理入口，不撤回现有路由；只要存在持久状态，就必须保留主密钥，缺失会拒绝启动，不能悄悄回退环境存储。历史配置不可删除/修改，因此不要撤销旧云凭据、删除旧桶或移除旧 MinIO allowlist，直到另行完成资产迁移。主密钥目前没有自动轮换/批量重加密命令；需安全备份并另行设计轮换。

范围仅为既有真实媒体对象链路；Mock 目录、`local-compose` 成片及整集导出目录继续使用原本本地存储，不因启用 OSS/COS 而自动迁移到云。数据库仍是 PostgreSQL，Redis 仍用于队列；对象存储不替代业务数据库。

## 验证

离线验证覆盖四种传输协议的约束/签名/错误清理、凭据密文篡改、HTTP 登录/Origin/CSRF/JSON、响应密钥拒绝、Worker 保留旧逻辑 key 并读回校验。使用传输替身，不证明真实云账号的连通性。

独立 PostgreSQL 验收入口：

```sh
corepack pnpm --filter @ai-drama/database exec vitest run --config vitest.storage-settings-acceptance.config.ts
```

仅允许新建的空隔离库，必须显式设置 `STORAGE_SETTINGS_TEST_ALLOW_WRITES=true`、`STORAGE_SETTINGS_TEST_ALLOW_DRAFT=true`、`STORAGE_SETTINGS_TEST_DATABASE_NAME=ads_storage_acceptance_<suffix>`、专用 `STORAGE_SETTINGS_TEST_DATABASE_URL`。它先核对实际库名和空库，再安装普通迁移及此草案；绝不连接业务 `DATABASE_URL`。覆盖并发保存/启用、旧对象路由、重启保留、过期测试、密文、不可变外键和丢失主密钥拒绝。具体本轮执行结果以 PR/验收报告为准。

协议依据：[COS 签名](https://www.tencentcloud.com/document/product/436/7778)、[COS PutObject](https://cloud.tencent.com/document/product/436/7749)、[OSS V4](https://www.alibabacloud.com/help/en/oss/developer-reference/recommend-to-use-signature-version-4)、[OSS PutObject](https://www.alibabacloud.com/help/en/oss/developer-reference/putobject)、[S3 条件写](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[MinIO 兼容性](https://docs.min.io/aistor/developers/s3-api-compatibility/)。
