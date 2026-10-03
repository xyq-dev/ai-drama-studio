# M3 AV Codex 审查：444d23f

审查日期：2026-09-30。源码基线：`444d23f043cedc5df7a973ae00fabb141192a122`，分支：`feat/m3-av-workbench`。GitHub 独立比较确认相对 `5c8ff0322ecdd5cfeddcdd0a3eb9d9016f4c8459` 为 1 个提交、44 个文件、+1806 / -167，没有 Migration。审查开始及交付前远端均与该源码 SHA 相同。

结论：**需要修复下列四项，再进入真实 API / Worker / 浏览器验收。** 当前固定 Mock 视频与静音 WAV 的实现已落地；本次不宣称完整 M3 或真实播放验收通过。

## 已确认的问题

### R1 · P1：恢复的永久错误不会收敛到终态

位置：`apps/worker/src/runtime/mock-media-recovery.ts:71–84`；对照正常执行的 `mock-av-generation.ts:215–238`。

原 attempt 已绑定 providerRequestId 后，若末端提交因来源失效 / 不存在或成本不一致抛出 `REVIEW_REQUIRED`、`NOT_FOUND`、`COST_CONFLICT`，恢复 catch 只匹配输出错误文案，将这些永久错误加入 AggregateError，没有 failJob。通用 RUNNING lease 查询排除了媒体，无法接管。这使任务每轮恢复重复 inspect / put / 完成尝试，仍保持 RUNNING。

独立重放实际恢复与 Adapter 源码，分别注入上述三个数据库错误，连续运行两轮：各 `puts=2`、`completions=2`（完成调用次数，不是成功资产数）、`failures=0`；两轮均抛同一错误码。数据库 / 对象存储为替身，未执行真实 SQL，也没有证明实际创建了资产。

### R2 · P2：旧任务恢复绕过独立 AV 开关

位置：`apps/worker/src/runtime/start-runtime.ts:76–79`、`mock-media-recovery.ts:18–60`；正常 dispatch 门禁在 `start-runtime.ts:89–91`。

保留图片目录并以 `mockImageEnabled=true`、`mockAvEnabled=false` 重启时，recovery 只根据目录是否存在创建，未接收或检查媒体开关。旧 RUNNING 的视频 / 配音仍可 inspect、写对象并提交 Asset 和 ACTUAL 成本。

独立重放实际 startQueueRuntime 的恢复回调，用实际 Adapter、替身数据库 / 队列 / 存储：关闭 AV 后仍有 `puts=1`、`completions=1`，提交参数为 `kind=VIDEO`、`cost.kind=ACTUAL`。这是运行时接线与恢复行为复现，不是真实数据库成功证明。

### R3 · P2：旧 revision 的迟到受理提示进入当前 revision

位置：`apps/web/src/components/workbench.tsx:2199–2210`、`:2274–2303`。

revision 切换会清列表和错误，但不清三类 notice；POST resolve / reject 也没有请求身份或 revision 世代校验。在 rev-A 视频 POST 在途期间切换同镜头至 rev-B，A 的迟到 202 会在 B 的“Mock 视频”区域显示已受理。资产列表本身按 revision 过滤，没有复现错误资产归属。

实际组件挂载、模拟 fetch 的独立重放确认：请求 URL 为 `/shot-revisions/rev-A/generate-video`，响应返回时活动 revision 是 rev-B，B 视频区域仍显示 A 的受理文案。没有真实 API / 浏览器。

### R4 · P2：视频重新查询失败给图片区添加虚假受理提示

位置：`apps/web/src/components/workbench.tsx:2240–2248`、`:2325–2326`、`:2340–2341`、`:2355–2356`。

只提交视频并收到 202，随后查询失败，在视频区域点击“重新查询”再次失败。共享 requery 的 catch 固定写入图片 setAcceptError，使从未 POST 图片的区域也显示“已受理的结果仍然有效”。

实际组件挂载、模拟 fetch 的独立重放确认图片和视频两区同时显示受理刷新错误，而只发送过视频 POST。允许共用中性的列表查询错误；受理事实与请求 key 必须保持媒体类型独立。

## 验证范围

Codex 在精确源码 SHA 下使用 Node 24.21.0、pnpm 10.17.0，安装 frozen lockfile 依赖，构建 contracts / domain / providers / database 后，重新执行：

| 命令（仓库根目录） | 实际结果 |
| --- | --- |
| `pnpm --filter @ai-drama/worker exec vitest run src/runtime/mock-av-generation.spec.ts src/runtime/mock-media-recovery.spec.ts src/runtime/mock-media-consumer-guard.spec.ts` | exit 0；3 files / 5 tests |
| `pnpm --filter @ai-drama/api exec vitest run src/studio/mock-av-content.spec.ts src/studio/asset-content.controller.spec.ts` | exit 0；2 files / 2 tests |
| `pnpm --filter @ai-drama/database exec vitest run src/mock-media-cost.spec.ts src/provision-mock-av.spec.ts` | exit 0；2 files / 4 tests |
| `pnpm --filter @ai-drama/web exec vitest run src/components/workbench.review.spec.tsx src/lib/asset-content-proxy.spec.ts` | exit 0；2 files / 36 tests |

合计 9 files / 47 tests。这些是现有单元 / 模拟交互测试，不能排除上面的遗漏。Web 出现 happy-dom 连接 `::1:3000` / `127.0.0.1:3000` 的 ECONNREFUSED，套件仍通过；没有把它算作 API 验收。

另外执行了实际源码的 Worker 重放、实际组件挂载 / 代理重放，均 exit 0（断言的是缺陷确实存在）。结构化证据见 [M3_AV_CODEX_REVIEW_EVIDENCE.json](M3_AV_CODEX_REVIEW_EVIDENCE.json)。本次没有重跑全仓 verify，Cursor 报告的 verify 通过是提交方结果。

已检查成本 / Asset / Job 同事务接线、durationMs 既有列映射、精确固定 fixture 内容读取、同源 GET / HEAD 和 provision 范围，未发现新的阻断项。GET 全量 200、HEAD 空 body、忽略 Range 符合最终执行单；不因未实现 206 提出修改要求。

非阻断改进：播放器 onError 后被移除，同 Asset 的后续列表刷新不恢复播放器，也没有预览重试入口。这在模拟挂载中已重放；可以后续增加明确的预览重试，不能用重新生成替代读取重试。

未启动真实 API、Worker、浏览器、PostgreSQL、Redis、MinIO；未执行 Migration、provision、Docker / Compose、部署或付费请求。本轮仅提交审查文档与证据，不修改产品源码。修复要求见 [M3_AV_REVIEW_FIX_EXECUTION.md](M3_AV_REVIEW_FIX_EXECUTION.md)。
