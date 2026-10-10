# 管理员模型配置交付记录

基线 `044788f9da16d8cd89b064ef1103c5db8e5caa12`，分支 `feat/admin-model-settings`。
本文件记录提交前本地验证；不把基线SHA或未提交截图当成新提交的CI证据。GitHub验收产物会单独记录PR实际head SHA。

## 完成内容

- 管理后台 `/admin/models`，三供应商统一界面、单独管理员登录、模型白名单、写入后不回显的密钥、默认供应商与调用次数限制。
- 独立管理员session、Origin/CSRF、限速、no-store及页面防嵌入；后台和创作者操作者令牌分离。
- AES-GCM文件、初始化标记、原子保存、CAS、脱敏审计；active/saved区分、重启应用、在途任务暂缓。
- API正常运行时接线，后台关闭不隐式丢弃已管理配置；原有标题创作开关及production强制关闭保留。
- 服务器初始化脚本和部署说明 `ADMIN_MODEL_SETTINGS.md`；无需新Migration、依赖或锁文件变更。

## 实际本地验证

使用Node24.21.0、pnpm10.17.0；没有关闭引擎检查。

| 验证 | 结果与范围 |
| --- | --- |
| 全仓lint、typecheck | 退出码0 |
| API单元/HTTP/运行时装配 | 160项通过；其中新增HTTP19、vault30、service/bootstrap7、runtime7 |
| Web单元/组件 | 414项通过；新增27项 |
| Contracts | 33项通过；新增20项 |
| 其他包 | database54、domain86、worker68、health7、comfyui-adapter4通过 |
| Providers | 114通过；两个既有CLI subprocess用例本地受限，见下文 |
| 初始化/doctor/FFmpeg采集脚本 | 13项通过 |
| 整仓生产构建 | `pnpm build`退出码0，含Web/API及所有依赖 |
| diff whitespace检查 | 退出码0 |

本地全仓 `pnpm test` 的两个既有千问CLI用例失败：tsx创建Unix IPC socket时报 `listen EPERM`，CLI未进入业务逻辑。
已直接复现相同环境错误，未改测试或关闭断言；随后其余包完整通过，provider定向排除这两项后114通过、2跳过。
Python合成测试本地未能启动：环境没有pytest；未修改Python代码。不能把本地结果称为 `pnpm verify` 全通过，完整门由CI按精确提交执行。

## 浏览器验证

真实Chrome → 生产Next → 同源代理 → 真实Nest管理员controller/auth/service → 真实临时加密文件。
不是route.fulfill，也没有模拟fetch；业务数据库未连接，模型transport未接入，所有出站fetch拒绝。

- 实际登录、保存替换、脱敏读回、刷新、退出后401、重新登录、确认清除、限额单独保存。
- 保存版本从0到1/2/3，当前生效仍0，明确待重启；没有调用模型，也没有启用标题创作。
- HttpOnly session，浏览器localStorage/sessionStorage无密钥和管理员令牌。
- 管理页CSP/X-Frame-Options/no-store实测通过。
- 1440与390宽共6张截图，无横向溢出、pageerror为0；截图仅假配置，实际密钥字段已清空。
- 本地脚本曾因审计文本重名和移动隐藏说明的选择器失败，收窄到实际可操作角色/名称后通过；没有放宽产品验收要求。

截图和本地证据：`docs/admin-models/`。本地证据headSha为null是因为它在提交前运行；不能事后写成某次CI。
新增 `Admin model settings` 工作流在PR/main复用同一浏览器脚本，将证据保存为artifact。

## 独立复审

见 `ADMIN_MODEL_SETTINGS_REVIEW.md`。初审1项P1、2项P2已经修复并有回归；最终没有未处理P0/P1。
复审不替代CI或服务器部署。

## 边界

尚未在服务器初始化或切换；本环境没有服务器连接。没有在任何数据库执行SQL，没有真实模型调用。
单台Linux/单API、先停旧后启新；不能把本版本用作多租户或多API集群密钥管理。
配置API密钥不等于启用标题创作；真实付费验收仍须单独授权。
