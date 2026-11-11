# 我的作品：分类列表

本次将 `/studio` 改为分类侧栏与作品列表。每个作品在名称前展示可读取的真实图片；没有图片或读取失败时显示“暂无封面”。继续创作与高级编辑仍进入原有页面，原来的审核、生成和发布规则不变。

## 数据与交互

- `GET /api/v1/library/projects` 支持 `q`（名称或故事内容，最长 200 字符）、`category`（`all`、`uncategorized` 或分类 UUID）、`sort`（`updated` 或 `created`）和 `cursor`。每页 20 条，服务端在同一个只读快照内筛选、计数及分页，不将已加载的一页当成全量结果。
- `total` 是当前关键词与分类的全量匹配数；`allCount`、`unclassifiedCount` 和 `categories[].count` 是当前关键词下、不限制所选分类的计数。分类初始为空，不自动猜测或写入作品题材。
- `POST /api/v1/library/categories` 接收客户端生成的 `{ id, name }`，同 ID/名称重试返回同一分类；工作区内分类名称不区分大小写唯一。名称限 1–40 字符。
- `POST /api/v1/library/projects/:id/category` 接收 `{ categoryId: UUID | null, expectedRevision }`。`null` 表示未分类；独立分类 revision 防止覆盖其他标签页的更新。分类元数据不改作品内容版本与更新时间。
- 列表项 `thumbnailUrl` 只使用同源 `/api/v1/real-media/assets/:assetId/content`。当前自动选取该工作区、该作品下最新的 ACTIVE、未拒绝、可供现有内容接口读取的真实 S3 IMAGE，排除 Mock、1 px、超出该内容接口大小范围等不可用图。图片仍经过现有服务端鉴权读取，不向浏览器暴露存储密钥。此版不增加手动封面上传/指定。
- 原 `/api/v1/projects` 行为保持不变。新增 API 的工作区只从服务端配置读取；沿用现有登录与 CSRF 中间件。

当前阶段继续从真实故事、剧本、审核、媒体和任务状态推导，并遵守作品集数和短剧/系列写作模式。继续保留并发 2、5 秒自动刷新、后台标签页暂停、最多 24 次及手动重试机制。未引入顶部“创作中/已完成”全量状态筛选，因为当前事实读取机制无法准确提供全量阶段筛选；页面展示全量作品数及逐行真实阶段。

搜索通过提交按钮触发，分类与排序切换重新查询服务端。旧请求返回不会覆盖新筛选或混入“加载更多”的结果。新建分类与分配分类成功后重新读取当前列表第一页及计数；分页位置会回到第一页。

## 数据库变更状态

独立草稿 `packages/database/prisma/drafts/20261111000100_project_library.sql` 新增分类、作品分类关系以及查询索引，不改旧作品字段。**已编写，未对业务数据库执行**。执行草稿前，作品查询、搜索、排序和缩略图继续可用；`categoriesReady=false`，分类按钮禁用，分类写入明确返回 `PROJECT_LIBRARY_UNAVAILABLE`。部署与业务数据库 Migration 需要单独授权。

## 验证

- `corepack pnpm --filter @ai-drama/web test src/components/my-works.spec.tsx src/components/beginner-start.spec.tsx`：搜索、分类筛选/排序、旧页竞态、分类重试、真实分配/清空、缩略图失败占位，以及原有进度轮询回归。
- 数据库与 API 新增定向测试覆盖工作区边界、查询验证、微秒精度游标、无草稿回退和分类并发版本冲突；独立 PostgreSQL 兼容测试用于 SQL 草稿验证，不连接业务库。
- `node scripts/project-library-ui-check.mjs`：实际 React 页面配本地 API fixture，在 Chromium 1440/390 宽度检查无横向溢出、搜索、分页、分类新建/分配/清空、空白与错误状态，输出 `test-results/project-library-ui/` 截图及证据。截图中的作品和标注“本地测试封面”的图片仅用于浏览器测试，不代表生产数据验收。

视觉沿用已确认效果图的暖白底色、红色主按钮、分类侧栏、列表与名称前缩略图。手机端分类变为可换行标签，作品行重排为纵向内容。与效果图的有意差异是移除无法全量准确实现的状态标签、使用真实业务阶段、将分类做成可编辑选择框，并为没有真实图片的作品保留明确占位。

## 本轮隔离数据库验收

新增 `vitest.project-library-acceptance.config.ts` 与对应 acceptance 测试。仅连接显式命名的全新空库 `ads_library_acceptance_<suffix>`，要求 `PROJECT_LIBRARY_TEST_DATABASE_NAME`、专用 `PROJECT_LIBRARY_TEST_DATABASE_URL`、`PROJECT_LIBRARY_TEST_ALLOW_WRITES=true`、`PROJECT_LIBRARY_TEST_ALLOW_DRAFT=true`。不使用业务 `DATABASE_URL` 作为连接目标。

2026-11-11：原生 PostgreSQL 16 隔离库 **7 项通过**，覆盖未安装草稿的只读兼容、分类持久与幂等、微秒分页、搜索和全量计数、工作区及外键隔离、缩略图筛选、并发 revision 仅一方成功。草稿只在一次性验收库执行，未对业务数据库执行。
