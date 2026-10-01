# M3 AV 审查修复报告

目录：`D:\Projects\ai-drama-studio`  
分支：`feat/m3-av-workbench`，跟踪 `origin/feat/m3-av-workbench`  
起点：`6afa6345f8f7a99565b672e678059ffa5f2170df`（含源码 `444d23f043cedc5df7a973ae00fabb141192a122` 与本轮执行单）  
本报告与修复在同一次提交。提交 SHA 以该提交的 `git rev-parse HEAD` 为准。

这四项都用替身数据库、队列和 happy-dom 验证。没有真实 API、Worker 进程、浏览器、PostgreSQL 或 Redis。固定 1552 字节 H.264 与 1644 字节静音 WAV 未改，也不是真实 AI 媒体。

## 修复

1. 视频和配音的同步执行与恢复共用同一分类。`REVIEW_REQUIRED`、`NOT_FOUND`、`COST_CONFLICT` 按错误码视为永久失败，原 attempt `retryable=false`，不再下一轮 inspect、写对象或提交 Asset。快照、fixture 和 accounting 校验失败同样终态。`STALE_RECALCULATION_PENDING` 和磁盘类错误保持可恢复，不再次 submit。`JOB_TERMINAL` 与 `ATTEMPT_SUPERSEDED` 不失败更新的 attempt。只出现在消息里的 `REVIEW_REQUIRED` 字样不会被当成数据库错误码。
2. `startQueueRuntime` 把图片开关和 AV 开关分别传给 recovery。没有对象目录时仍做配置失败或取消收尾，不构造 LocalMockObjects，也不 inspect。AV 关闭时，已绑定的视频或配音不再写 Asset 或成本。只开 AV 时不恢复图片。取消仍走原确认路径。
3. 镜头页用 revision 世代区分请求。切换版本会清三类提示、受理错误和 pending key。A→B→A 的迟到 202 或写入失败不改当前提示、busy 或新请求的幂等键。已受理的旧请求仍可触发任务查询，列表读取沿用原有防过期。
4. 重新查询带上渠道。只有该渠道在当前世代实际 202 时才保留“已受理的结果仍然有效”。未提交的渠道不出现这句。公共列表失败使用“媒体列表刷新失败，可以重新查询。”重新查询只发 GET。

## 验证

Node `C:\Users\Administrator\Tools\node\node-v24.21.0-win-x64`，pnpm 10.17.0。未关闭 engine 检查。

```text
pnpm --filter @ai-drama/worker exec vitest run src/runtime/mock-media-recovery.spec.ts src/runtime/start-runtime-media.spec.ts src/runtime/mock-av-generation.spec.ts src/runtime/mock-media-consumer-guard.spec.ts src/runtime/mock-media-guard.spec.ts
pnpm --filter @ai-drama/web exec vitest run src/components/workbench.review.spec.tsx src/lib/asset-content-proxy.spec.ts
pnpm verify
```

Worker 定向：exit 0，5 files / 21 tests。Web 定向：exit 0，2 files / 41 tests。其中 `workbench.review.spec.tsx` 为 40 tests。happy-dom 日志有 `ECONNREFUSED 127.0.0.1:3000` 与 `::1:3000`，套件仍通过，不是真实 API 结果。

`pnpm verify` exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9。

| 包 | 结果 |
| --- | --- |
| `@ai-drama/worker` | 13 files / 41 tests |
| `@ai-drama/web` | 7 files / 56 tests |
| `@ai-drama/api` | 7 files / 13 tests |
| `@ai-drama/database` | 5 files / 13 tests |
| `@ai-drama/providers` | 1 file / 15 tests |

恢复和开关测试用的是内存 store、假队列和真实 MockMediaAdapter。镜头页测试是挂载组件加模拟 fetch。没有 PostgreSQL 上的同事务证明。

## 未执行

真实 API、真实 Worker、真实浏览器播放与 390px、PostgreSQL、Redis、Migration、provision、Docker、Compose、MinIO、部署。集成测试会 `DROP SCHEMA public CASCADE`，本轮没有对任何既有库执行。Windows 10 1809 上没有重试安装 Docker。
