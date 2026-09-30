# M3 图片工作台实现报告

目录：`D:\Projects\ai-drama-studio`  
分支：`feat/m3-image-workbench`，跟踪 `origin/feat/m3-image-workbench`  
基线：`65e251a591a34976c3301f05b27325b4859218a2`（`docs(m3): define the mock image workbench implementation slice`）  
审查基线：`20dc281eb406a5f4ac112f88edb4daec1d303118`  
祖先：`3b349627c42b7dda26e412b18cf208417b874e92`  
本报告与最新修复在同一次提交。提交 SHA 以该提交的 `git rev-parse HEAD` 为准。

## 完成内容

- 镜头页增加“生成 Mock 图片”、可选 seed、当前版本与历史版本资产列表。202 只显示已受理。确定性 1×1 Mock 测试图，seed 不改变像素。
- 图片任务与文本任务分开轮询。媒体任务结束只刷新图片列表。媒体手工 retry 保持禁用。
- `GET /api/v1/assets/:assetId/content` 只按当前 workspace 的 Asset ID 读取 PNG。校验 key、普通文件、符号链接、路径逃逸、1 MiB 上限、记录大小，并只读取该字节数。随后核对 SHA-256 和 PNG 块结构（IHDR、CRC、IEND）。响应为 `image/png`，`nosniff`，`private, no-store`。预览地址是同源 `/api/v1/assets/<id>/content`。
- `pnpm --filter @ai-drama/database mock-media:provision` 只为已有 ACTIVE workspace 幂等写入 `mock-media` / `image.generate`。要求进程环境中的 `DATABASE_URL`、非生产、`M3_MOCK_IMAGE_ENABLED=true` 和绝对路径 `MOCK_OBJECT_DIR`。不运行 Migration，不在启动时自动执行。
- M2 草稿、原 If-Match、409 确认和显式 null 清空保持原语义。图片刷新不重写镜头正文。

## 审查修复

- `reloadBase` 和轮询共用同一套任务状态转换。页面隐藏时不轮询；已知的 `MEDIA_IMAGE` 在隐藏期间进入终态后，恢复可见会重读对应资产，终态不再继续轮询。
- 资产列表绑定当前 revision。同一镜头保存出新 revision 后，新的读取完成前不再把旧图放在当前版本；历史归属仍按 `sourceShotRevisionId`，迟到响应不会写回新 revision。
- POST 返回 202 后，随后的任务或图片查询失败单独显示，并提供重新查询。受理文案保留，不提示再次生成，也不宣称复用旧幂等键。写入本身失败时仍复用原键。
- 内容读取拒绝签名-only、截断或 CRC 损坏的 PNG、大于记录大小的文件、超过 1 MiB 的文件，以及目录。固定 1×1 fixture 仍可读取。

## 验证

Node 使用 `C:\Users\Administrator\Tools\node\node-v24.21.0-win-x64`，pnpm 10.17.0。未关闭 engine 检查。

在仓库根目录执行：

```text
pnpm verify
```

审查修复前，针对模拟套件已执行：

```text
pnpm --filter @ai-drama/api exec vitest run src/studio/mock-image-content.spec.ts
pnpm --filter @ai-drama/web exec vitest run src/components/workbench.review.spec.tsx
```

结果：API 内容测试 3 tests 通过；Web `workbench.review.spec.tsx` 33 tests 通过。Web 日志出现 `ECONNREFUSED 127.0.0.1:3000`，套件仍通过。这是模拟测试里的连接拒绝，不是真实 API 结果。

随后在仓库根目录执行 `pnpm verify`，exit 0。顺序为 lint、typecheck、test、build。其中 Web 6 files / 48 tests，API 5 files / 10 tests。`provision-mock-media.spec.ts` 只覆盖配置解析，没有连接数据库。Web 的 `ECONNREFUSED 127.0.0.1:3000` 仍出现在模拟日志中，没有导致失败，也不是真实 API 结果。

## 未执行

- 真实浏览器、真实 API、真实 Worker 和同源 PNG 解码。happy-dom 只断言预览 URL 与错误文案。
- 390px 视口。窄屏换行使用 `break-all` / `min-w-0`，不能用 class 字符串代替真实布局。
- PostgreSQL 集成测试、Migration、`workspace:provision`、`mock-media:provision` 对真实库的执行。集成测试会 `DROP SCHEMA public CASCADE`，本机没有已确认归属的隔离库。
- Docker、Compose、MinIO。1×1 PNG 写入显式 Mock 目录，不进入 MinIO。Docker Desktop 在 Windows 10 1809（build 17763）上此前安装失败，本轮没有重试安装。
- 视频、ComfyUI 工作流、付费模型和媒体手工 retry。

1×1 fixture 不是真实 AI 图片。模拟测试通过不能记为真实联调通过。
