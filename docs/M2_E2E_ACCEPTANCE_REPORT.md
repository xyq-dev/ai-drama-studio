# M2 核心文本创作闭环：真实浏览器验收

日期：2026-09-30。结论：**核心闭环通过，15 个浏览器检查点通过**。本轮使用真实 Web、API、Worker、PostgreSQL、Redis、MinIO；没有拦截 fetch、替换 API 响应或用内存存储冒充联调。文本生成使用仓库正式提供的 Mock provider，不是实际 LLM 或媒体生成验收。

## 代码与执行环境

- 仓库：`xyq-dev/ai-drama-studio`，功能分支 `feat/m2-creator-ui`。
- 起点：`6c3a9d4ecd2a1b0b89abd91cd661260959e8f563`。独立 detached worktree，未修改原工作区及 fsync worktree。
- 本轮业务代码修改：仅 `workbench.tsx` 两处 CSS class。版本栏和差异列表增加 `min-w-0`、`overflow-wrap:anywhere`，保留完整差异内容。
- 执行目录：`/workspace/scratch/62f2be8edb46/ai-drama-m2-e2e`，Linux x64；不是用户 Windows 电脑。
- Node `24.21.0`，pnpm `10.17.0`，锁文件安装；Chrome for Testing `154.0.8037.92`，Playwright `1.62.1`。
- 原生 PostgreSQL `16.14`、Redis `7.4.11`；MinIO 从官方 tag `RELEASE.2025-09-07T16-13-09Z`（commit `07c3a429bfed433e49018cb0f78a52145d4bedeb`）用 Go `1.24.13` 构建。
- 端口：Web 3300、API 3301、Worker 3302、PostgreSQL 55433、Redis 56380、MinIO 59010/59011，均绑定 loopback。
- 新建专用数据库 `ai_drama_m2_e2e`，迁移前核验实际主机、端口、数据库、用户、数据目录及空 public schema。显式注入隔离配置，未使用继承的数据库地址。
- **Migration：YES，仅新测试库；5 个现有迁移成功。Workspace provision：YES，仅新 Workspace `ccc26fc2-e214-4edd-a950-0c867a27c83c`。** 没有重置已有数据库。

## 真实浏览器结果

最终完整复跑使用项目 `2cc4fd11-1332-4d45-9763-17e391b57b5e`。起点源码先通过一次闭环；两处样式修复后重新执行完整闭环，结果仍通过。

| 检查 | 实际结果 |
| --- | --- |
| 创建项目 | 浏览器提交，真实 API 201，进入工作台 |
| 故事草稿刷新恢复 | 输入后刷新，正文完整恢复 |
| 故事保存、提交审核、通过 | 真实写入并生成三集 |
| 三集剧本 | 分别保存、提交审核、通过，3 个检查点 |
| Mock 场景任务 | API 202 后，真实 Worker/job/run 最终 SUCCEEDED；当前页面自动出现结果 |
| 三集场景审核 | 分别提交审核并通过，3 个检查点 |
| Mock 镜头任务 | 真实 Worker/job/run 最终 SUCCEEDED；三集各一个镜头，当前页面自动出现结果 |
| 单镜头第二版、版本比较 | 同一镜头新 revision，第一版保留；第二版保存后其他两镜头仍仅一版且 currentRevisionId 未变 |
| 镜头草稿恢复及清空 | 刷新恢复动作，明确清空对白与时长仍为空 |
| 双页面真实 409 | B 保留旧基线；A 保存第三版；B 普通保存真实返回 409，展示服务端差异并阻断普通保存 |
| 冲突确认 | 界面已看到版本 4，确认请求 If-Match=4、新幂等键；B 正文和两个 null 成功写入第四版，四个历史版本保留 |
| 服务状态页面 | 真实页面加载；另行逐项断言 Web、API、PostgreSQL、Redis、MinIO 均显示 ok |

场景工作流 `441d1fe6-c80c-40c2-9631-e71e4abc512e`、镜头工作流 `355437ac-90d7-405b-8b80-52f4501298cd` 均为 SUCCEEDED，job 的 attemptNo=1、retryCount=0。浏览器 pageerror 为 0。

补充只读检查：任务全部终态后观察 5 秒，workflow-runs 新请求为 0；390px 页面 document.scrollWidth=390，没有横向溢出。桌面、窄屏截图均保留完整哈希及来源。中文字体只安装到隔离浏览器运行目录，未修改产品字体样式。

## 本轮发现及修复

390px 下，版本比较的 64 位 contentHash 不能换行，使 document.scrollWidth 达到 576。实际越界元素为 DiffList 中的哈希段落。只在 RevisionColumn 与 DiffList 根节点增加可缩小和任意长串换行样式；修复后真实页面宽度为 390。未截断内容或隐藏页面横向溢出。

## 验证及证据

- 后端依赖构建：7 个包通过。
- 修复后 Web lint、typecheck：exit 0。
- 修复后 Web test：6 files / 35 tests，exit 0。
- 修复后 Web 生产构建：`pnpm --filter @ai-drama/web exec next build --webpack`，exit 0。
- 真实 Chromium 完整复跑：15 checkpoints，通过；桌面/窄屏/终态轮询/状态页面补充检查通过。
- API live/ready、Worker live/ready、MinIO live、Web 均 HTTP 200；API ready 的 postgres/redis/objectStorage，Worker ready 的 postgres/redis/queue 均 ok。

本环境 Turbopack 在编译 globals.css 的子进程端口绑定处返回 EPERM，提升沙箱权限后仍出现；因此使用 Next.js 支持的 Webpack 模式完成构建。未改 next.config、package scripts 或产品代码来绕过构建。**本轮没有完成标准全仓 `pnpm verify`；此前 Cursor 在 `6c3a9d4` 的全仓通过结果为既有证据，不能代替本轮标准构建。** 两处 CSS 修复的 Web 检查和真实浏览器验证如上。

证据包包含 acceptance.json、实际浏览器请求状态/If-Match/幂等键/正文、最终 revision 历史、两工作流与 jobs、service-health.json、数据库迁移前核验、MinIO 构建来源、15 项执行脚本、补充检查脚本、日志与截图；不含环境文件、密码、数据库数据或运行二进制。

测试源码 `workbench.tsx` SHA256：`bedbdfd7876d7d677c37eec0564ead1ccea8b50181bbca1817f012147c0294d3`；对应 Git blob：`eb929ee853e0b3e97923b776144ed3b81cc1281f`。

## 范围边界

这是 **M2 核心文本创作闭环** 验收通过，不代表全部异常路径、Windows 或生产环境验收通过。

- 未执行 Docker Compose；PostgreSQL 为 16.14，Compose 固定 16.15；MinIO 使用同 tag 官方源码构建，不与容器二进制逐字节等同。
- 未真实执行角色/场地 CRUD 与审核、镜头审核、退回、任务失败/取消/重试、STALE 来源重绑定、确认后再次竞争、在途保存新增输入或跨浏览器矩阵。这些已有模拟测试或代码审查证据不能写成此次真实通过。
- 未重新验证 Windows 目录 fsync；原 Windows Docker 安装失败的结论不变。
- 未修改 API、Worker、数据库业务规则；没有推 main、force push、PR、merge、pack 或 deploy。证据压缩包仅供下载，不是应用发布包。

下一步可以进入 M3；继续保留上述平台和异常路径的验证边界。
