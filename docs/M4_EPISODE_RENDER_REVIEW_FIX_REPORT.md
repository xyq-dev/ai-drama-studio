# M4-C2 页面回归修复

本报告记录两处页面回归的验收。它不沿用 Run `36974211083`、`36991878705`、`36996982629` 或 `37000568230`。Migration = NO。

## 目录与提交

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio` |
| origin | `https://github.com/xyq-dev/ai-drama-studio.git` |
| 分支 | `feat/m4-episode-render` |
| 起点 | `06ccc12cdc0b8a77fb8d4b7449ef5235d15ae237` |
| 审查源码 | `0ab54d1b29348e6bd236e79a86fe88a8252cfce7` |
| 验收 SHA | `4426743f4558517ae0ea20cd0cd84fbae9cfb9b9` |
| 报告 SHA | 包含本文件的提交；推送后与 `origin/feat/m4-episode-render` 一致 |
| Migration | NO |

起点核验时工作区干净，HEAD 与 `origin/feat/m4-episode-render` 同为 `06ccc12`。`origin/main` 仍为 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。`origin/feat/m4-episode-compose-preflight` 仍为 `d127a344570224bad8a685121759ad3fc60c406b`。本轮只普通推送当前功能分支。

## 两项根因与修复

1. 取消后仍为 `RUNNING` 时停止查询。`cancel()` 回读后无条件递增 `jobGen` 再 `setJob`。任务 ID 和 `RUNNING` 都没变时，轮询 effect 不会重新执行，旧轮询又因世代不匹配退出，页面停在运行中。服务端先写 `cancel_requested_at`，Worker 收尾后才进入 `CANCELED`，这是合法行为。现在只有回读已是终态才推进任务世代和读取世代；非终态回读留在当前轮询里。旧任务的取消回读仍不能覆盖新任务，同任务更早的 `RUNNING` 也不能覆盖终态。隐藏后再显示沿用同一世代，不会因此停查。页面不把“已请求取消”显示成 `CANCELED`。

2. 已加载的历史成片不刷新。历史页加载后，刷新只取 `limit=10` 的第一页，`mergeNewest` 永远留下第一页以外的旧记录。`review()` 成功后只调用可选的 `onReviewed`，父组件没有提供该回调。现在审核成功立即写回 `reviewStatus`、`rowVersion` 和 `contentHash`。轮询、重新可见和「重新查询成片」只重读已经加载的页数，按资产 ID 去重并保持最新优先。更低的 `rowVersion` 不能覆盖新审核；相同版本不能把 `STALE` 改回 `ACTIVE`。切集会作废上一集尚未返回的列表。不清空全部历史，不全表扫描，也不自动一直翻页。

修改文件：

- `apps/web/src/components/episode-compose-job-panel.tsx`
- `apps/web/src/components/episode-compose-job-panel.spec.tsx`
- `scripts/m3-av-e2e/episode-render.mjs`

没有改后台游标、配置、渲染或事务。资产的 `created_at` 属于不可变溯源，验收没有改写它，而是插入更新的成片行，把已有成片留在后续页。原有 42 个阶段全部保留。新的浏览器断言在 `episode-render-playback`、`episode-render-lifecycle` 和 `episode-render-stale` 内。

## 测试

本机没有 Docker，因此没有在本机跑 `scripts/m3-av-e2e/run.mjs`。组件回归使用稳定的 `StudioClient` 和模拟 fetch。真实浏览器、API、Worker 和 PostgreSQL 只在本次隔离 CI 中运行。

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `episode-compose-job-panel.spec.tsx` | 0 | 16 项通过，happy-dom 模拟 API |
| `pnpm m3-av-e2e:check` | 0 | harness 通过 |
| `pnpm m3-av-e2e:outcome` | 0 | 23 项通过 |
| `pnpm verify` | 0 | lint、typecheck、test、build，以及 media-worker 7 passed / 2 skipped |

组件回归覆盖：取消后立即 GET 仍为 `RUNNING`、隐藏期间不查询、恢复后读到 `CANCELED` 并停止轮询；历史 `DRAFT` 到 `APPROVED` 和 `REJECTED`；已加载的 `APPROVED`/`ACTIVE` 变为 `APPROVED`/`STALE`；刷新与加载历史并发；切集后的迟到列表。

## 隔离 CI

| 项 | 值 |
| --- | --- |
| Run | https://github.com/xyq-dev/ai-drama-studio/actions/runs/37002393916 |
| attempt | 1 |
| Job | `110822833318` |
| 结论 | success |
| Artifact | `m4-episode-render-e2e-evidence` / `11224419536` |
| 大小 | 4894426 字节 |
| 下载 SHA-256 | `949fb5ae83472f0cdc5dc730fbbd998abb2b635881c78af15cd7465fe45f3250` |
| 数据库 | `m3av_37002393916a1`，迁移前 `public_tables=0` |
| Migration | NO。沿用既有 migration，没有 DROP SCHEMA |

42 个阶段全部 `passed`。`fatal`、`restoreError`、`cleanupError` 均为空。`compose down` 退出码 0。`results.ok` 为 true。

本次页面证据：

- 真实运行中取消的任务 `ede4009b-ca81-4522-99a4-58a807bc95c5`。取消后的立即读取是 `RUNNING`，页面随后自己读到 `CANCELED`。同一阶段的 API 先取消任务 `09b18c16-4275-4df4-8404-b225971023f6` 仍以 `CANCELED` 结束且没有成片。
- 精确游标页数 16，时间文本 `2020-01-01T00:00:00.100001Z`。历史成片 `1fe0cf2e-1644-4b8b-8e7a-37e1d6be135c` 不在第一页，一次「加载更早的成片」后可见。之后浏览器加载历史页并批准真实成片 `64950cba-b597-44c6-8421-07f707c797b3`，审核变为 `APPROVED`，`rowVersion` 为 2。第一页成片 `be4cc5af-9aee-4506-b52c-bdfe0cf17a42` 的批准按钮仍在。
- 已加载历史成片 `be4cc5af-9aee-4506-b52c-bdfe0cf17a42` 在来源失效后显示 `STALE` + `APPROVED`，`rowVersion` 为 3。另一条已加载成片 `a754551d-de31-4a63-8ef3-2d00147e37be` 仍在。来源状态也是 `STALE`。

播放解码为 1080×1920，进度超过 0.2 并结束。正向与反向亮度顺序相反。亮度差来自既有 mock 黑帧和烧录字幕，不是真实配音。

## 未执行项

本机未执行真实 Docker 闭环。CI 的 `notRun` 仍包括：其他媒体组合的成本冲突、未触发的暂时故障组合、隐藏标签页、Windows 与其余 Compose 故障、会 `DROP SCHEMA` 的既有 integration 套件，以及新 migration、main、force push、PR、merge、pack、部署、付费 Provider、ComfyUI 和真实模型。
