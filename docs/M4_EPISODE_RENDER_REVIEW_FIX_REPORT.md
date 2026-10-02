# M4-C2 审查修复

本报告只记录四项定向修复的验收。它不沿用上一轮 Run `36974211083`。Migration = NO。

## 目录与提交

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio` |
| origin | `https://github.com/xyq-dev/ai-drama-studio.git` |
| 分支 | `feat/m4-episode-render` |
| 起点 | `37bab3bda0ca600a69687f3f66f7add6c7c77a19` |
| 审查源码 | `58edf8d00c00f113d5af8f3a259b0a89ee2e304c` |
| 验收 SHA | `0ab54d1b29348e6bd236e79a86fe88a8252cfce7` |
| 报告 SHA | 包含本文件的提交；推送后与 `origin/feat/m4-episode-render` 一致 |
| Migration | NO |

起点核验时工作区干净，HEAD 与 `origin/feat/m4-episode-render` 同为 `37bab3b`。`origin/main` 仍为 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。`origin/feat/m4-episode-compose-preflight` 仍为 `d127a344570224bad8a685121759ad3fc60c406b`。本轮只普通推送当前功能分支。

## 四项根因、范围与结果

1. 幂等键。`start()` 把 500/502/504 当成确定失败并清掉 unresolved，下一次点击会换键。现在只有明确业务拒绝（校验、输入变化、配置、不存在、审核前提、幂等键被另一次请求占用）才释放原提交。网络异常、500/502/503/504、解析失败和不完整 202 继续使用原请求体和原键。有效 202 回执之后，下一次明确新合成才换键。新的预检结果不会替换尚未确认的提交。模拟回归里，服务端已按键创建 Job，响应仍是上述错误，重放后始终只有一个 Job。

2. 游标与分页。列表 SQL 按 `created_at` 比较，游标却经过 `new Date(String(row.created_at))`，毫秒和微秒都丢失，`limit=1` 会停在同一行。查询现在用 `to_char(...US...)` 取出数据库时间文本，排序、比较和游标编码使用同一文本，顺序改为 `created_at DESC, id DESC`。页面每次只读一页最新成片，用「加载更早的成片」继续历史页；轮询与历史按资产 ID 去重并保持顺序。隔离 CI 在真实 PostgreSQL 上核对了同时刻不同 ID、非零微秒 `.100001Z`、`limit=1` 和多页结束，16 条无重复、无遗漏。真实浏览器里最新成片可见且可批准，历史页能继续加载。

3. 取消与回读。取消回写只比较集级 epoch，所以取消 A 的延迟响应能把同集已受理的 B 写成 A 的 `CANCELED`。回写现在同时检查任务 ID、操作世代和读取世代。B 被接受后，A 的取消成功、失败和回读都不再写入。同一任务取消到达终态后，更早的 `RUNNING` 查询也不能覆盖它。查询仍串行，终态停止轮询，隐藏暂停，可见后恢复。回归覆盖延迟成功、延迟失败、旧 `RUNNING` 回读，以及 A→B→A。

4. Mock 目录。API 的 `localComposeEnabled` 把 `MOCK_OBJECT_DIR` 算进总开关，集级创建、列表、审核和内容又要求这个开关；读内容时在识别 `COMPOSITE` 之前就拒绝缺少 Mock 目录。现在总开关是非生产环境的 `M4_LOCAL_COMPOSE_ENABLED`。单镜生成仍要求 Mock 目录和对应 Mock 生成开关。集级在两个合成开关开启且 compose 对象目录为绝对路径时即可创建、执行、列表、播放和审核，不要求 `MOCK_OBJECT_DIR` 或 Mock 生成开关。内容按资产类型检查目录：图片、音视频、字幕和音乐走 Mock 目录，已存成片走 compose 目录。默认关闭、production 关闭和未知 schema 拒绝保持。Worker 集级判定同样不要求 Mock 目录。隔离 CI 先准备合法单镜成片，再在未配置 `MOCK_OBJECT_DIR`、关闭三个 Mock 生成开关的 API 与 Worker 上完成集级闭环；同一配置下单镜合成返回 `CONFIGURATION_ERROR`。

修改文件：

- `apps/web/src/components/episode-compose-job-panel.tsx`
- `apps/web/src/components/episode-compose-job-panel.spec.tsx`
- `packages/database/src/media-assets.ts`
- `packages/database/src/episode-composite-cursor.spec.ts`
- `apps/api/src/studio/studio.runtime.ts`
- `apps/api/src/studio/studio.service.ts`
- `apps/api/src/studio/episode-compose.service.spec.ts`
- `scripts/m3-av-e2e/episode-render.mjs`

没有改渲染 profile、固定 fixture、通用任务状态机或审核规则。原有 42 个阶段全部保留，新断言加在 `episode-render-gates`、`episode-render-playback`、`episode-render-stale` 和 `episode-render-isolation` 内。

## 测试

本机没有 Docker，因此没有在本机跑 `scripts/m3-av-e2e/run.mjs`。页面交互测试使用 happy-dom 和模拟 fetch。游标单测使用脚本化查询客户端，精确时间由 CI 的真实 PostgreSQL 和真实浏览器验收。

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| Web 集级面板与预检测试 | 0 | 15 项通过，模拟 API |
| API `episode-compose.service.spec.ts` | 0 | 4 项通过 |
| 数据库 `episode-composite-cursor.spec.ts` | 0 | 脚本化游标 |
| `pnpm m3-av-e2e:check` | 0 | harness 通过 |
| `pnpm m3-av-e2e:outcome` | 0 | 23 项通过 |
| `pnpm verify` | 0 | lint、typecheck、test、build，以及 media-worker 7 passed / 2 skipped |

## 隔离 CI

| 项 | 值 |
| --- | --- |
| Run | https://github.com/xyq-dev/ai-drama-studio/actions/runs/36991878705 |
| attempt | 1 |
| Job | `110789723358` |
| 结论 | success |
| Artifact | `m4-episode-render-e2e-evidence` / `11220103863` |
| 大小 | 4473555 字节 |
| 下载 SHA-256 | `df3eafbef0e00e1c102ec7a330d2c932e2001d26d65e82055173ddbc9d1d8912` |
| 数据库 | `m3av_36991878705a1`，迁移前 `public_tables=0` |
| Migration | NO。沿用既有 5 个 migration，没有 DROP SCHEMA |

42 个阶段全部 `passed`。`fatal`、`restoreError`、`cleanupError` 均为空。`compose down` 退出码 0。`results.ok` 为 true。

本次修复证据：

- 无 Mock 目录的集级任务 `b13d8462-3cad-4303-8a5d-9bc6244337a5`，成片 `81b5d5dd-52a3-44d6-96eb-92ff74b2cf10`，内容 14783 字节，审核 `APPROVED`。同配置下单镜合成被拒绝。
- 精确游标页数 16，时间文本 `2020-01-01T00:00:00.100001Z`。浏览器加载到历史成片 `0c6b65e5-1964-40df-9227-14c590b3f826`，最新成片 `d0303ec4-efd9-4a2b-baee-db0ddc75cc88` 可批准。
- 播放解码为 1080×1920，进度超过 0.2 并结束。正向与反向亮度顺序相反。
- 审核批准、退回各一条，并发审核事件 1 条。
- 取消任务 `efb9191d-6a73-4680-a71c-049a61943256`。来源变化任务 `16e31175-b7be-4bdd-97de-c891fe18317e` 为 `FAILED`。SIGKILL 任务 `839e636e-19f6-4577-bf27-34f6de3a722d` 有 2 次尝试，成片落在最新尝试 `936c197b-0105-497e-bcd1-e532763c74a9`。锁等待任务 `2f53fe07-bebf-4fcb-b093-a0af3db5ba33` 成功，过期尝试 `ef3aa982-88be-4077-a6de-0ba868ab0e75` 没有成片。注入失败 `d552cf89-5969-4bab-b7d4-c99f927045fb` 为 `COMPOSE_COMMIT_INJECTED`。
- 历史成片 `d0303ec4-efd9-4a2b-baee-db0ddc75cc88` 为 `STALE` + `APPROVED`。隔离依赖 2 条，MinIO 对象数 0。对象键 `compose/6b606cdc-407e-457e-acb3-13dfec62dd69/3b11ffc4-9f05-4cb2-81b0-69c5f6591359/d4ede12c-60e8-4afa-a77c-3cd9ddb0caeb/f44eaf12-1f74-4f6b-9f7a-b49369afadbf/a81921ca53e51faa207c14cdde354b40b97ae2f68026fe5638c41800d5c31bc7.mp4`。

亮度差来自既有 mock 黑帧和烧录字幕，不是真实配音。

## 未执行项与遗留

本机未执行真实 Docker 闭环。CI 的 `notRun` 仍包括：其他媒体组合的成本冲突、未触发的暂时故障组合、隐藏标签页、Windows 与其余 Compose 故障、会 `DROP SCHEMA` 的既有 integration 套件，以及新 migration、main、force push、PR、merge、pack、部署、付费 Provider、ComfyUI 和真实模型。

没有新的遗留功能缺陷。Worker 执行集级任务时仍需要 compose 工作目录；API 的集级开关要求绝对 compose 对象目录。两边都不要求 Mock 目录。
