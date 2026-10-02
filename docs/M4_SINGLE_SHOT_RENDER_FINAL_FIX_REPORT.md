# M4 单镜合成最后一次定向修复报告

## 结论

三项定向修复已通过原有 33 阶段隔离 CI。结果不确定的提交继续使用原请求体和幂等键；慢于轮询间隔的读取仍能更新任务和成片；编码、探测和解码子进程在父进程死亡后退出。验收按具体 PID 检查进程树。

这不是完整 M4，不是真实 AI 生成，也不是生产就绪。本地编码成本没有计量。没有做生产分发许可验收。

## 现场

目录 `D:\Projects\ai-drama-studio`。分支 `feat/m4-single-shot-render`。开始时 HEAD 与 `origin/feat/m4-single-shot-render` 都是 `c08e14c45b9457a7fec855f3bd5b9f121e526569`，工作区干净。没有 reset、clean、stash 或覆盖。

上轮验收 SHA 是 `e0a44bb9197b5ded2669f4aa549354a73f03c3fb`。上轮报告 SHA 是 `c08e14c45b9457a7fec855f3bd5b9f121e526569`。

- 本轮实际验收 SHA：`33d11ada7bcb28e1a0149952650c9b1e2cb35f44`
- 报告提交与该验收 SHA 分开。报告 SHA 是包含本文件的提交，push 后与 `origin/feat/m4-single-shot-render` 核对。
- `origin/feat/m4-compose-preflight` 仍是 `4b67d6a6ad11382c16a80e525859aaab8e379ecd`。
- `origin/feat/m3-lifecycle-acceptance` 仍是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。

## 三项修复

不确定的提交保留幂等键。网络异常、502/503/504，以及 202 里没有任务编号时，保留原请求体和原键。只有收到带任务编号的回执才结束这次待确认提交。之后的明确合成使用新键。不再因为异常属于 `ApiError` 或某段文案就认为任务没有创建。

同一资源的查询完成后再安排下一次，不再每秒递增世代号。revision、任务身份、审核和取消仍能使过期响应失效。连续慢响应最终能写入 `SUCCEEDED` 和对应成片。终态停止任务查询；页面隐藏时暂停；恢复可见后继续读取资产。

编码、探测和完整解码三条 FFmpeg/FFprobe 调用都设置父进程死亡保护。探测超时仍是 `COMPOSE_PROBE_FAILED`，编码超时仍是 `COMPOSE_RENDER_TIMEOUT`，解码失败仍是 `COMPOSE_OUTPUT_INVALID`。

## Migration

Migration=NO。没有新 Migration，没有改既有 migration、Prisma schema、触发器或约束。CI 只在身份核实且迁移前 `public_tables=0` 的新建隔离库 `m3av_36954435171a1` 上应用既有 migration。没有 `DROP SCHEMA`。

## 真实执行与模拟测试

模拟：`compose-job-panel.spec.tsx` 6 passed。happy-dom 替换 fetch，没有启动 API、数据库、Worker 或浏览器。覆盖网络异常、503、不完整 202 的同键重试，有效受理后换键，慢于轮询间隔的读取，以及原有的丢响应、迟到 DRAFT、终态停轮询、隐藏恢复和旧取消回读。

本机真实 FFmpeg：线程限制测试实际执行 debug 日志。本机 Windows 不能创建目录符号链接，也不能验证 `PR_SET_PDEATHSIG`，这两条 Python 用例在本机 skip。`pnpm verify` 末尾为 4 passed，2 skipped。

隔离 CI 真实子进程：venv pytest 7 passed、1 warning；`node scripts/run-media-worker-tests.mjs` 6 passed。其中 Linux 测试拉起真实 ffprobe 和 ffmpeg，SIGKILL 父 Python 后这两个 PID 退出。ffprobe 读的是测试进程仍然打开的 FIFO，因此退出不是因为管道被父进程关闭。

隔离 CI 真实验收：生命周期阶段记录 `compose_cli` PID `17803` 和其子进程 PID `17805`，要求这两个 PID 都退出，然后恢复。任务 `f64a3d1c-a922-4872-8baa-6e8b7575673e`，2 个 attempt，唯一成片在最新 attempt `0a93517a-b974-43a1-b7ae-eb1073318887`，`job.succeeded` 1 条。Chrome 播放、审核、锁等待和事务回滚仍是这次运行里的真实进程。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`。本机没有 Docker，因此没有执行 `scripts/m3-av-e2e/run.mjs`。既有会 `DROP SCHEMA` 的 integration 套件没有执行。

| 命令 | 结果 |
| --- | --- |
| 合成面板 `compose-job-panel.spec.tsx` | 6 passed |
| `pnpm m3-av-e2e:check` | exit 0 |
| `pnpm m3-av-e2e:outcome` | exit 0，22 passed |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9。web 72 passed。Web 测试仍打印 `ECONNREFUSED 127.0.0.1:3000` 并通过 |
| `node scripts/run-media-worker-tests.mjs` | 含在 verify 末尾。4 passed，2 skipped |
| `node scripts/m3-av-e2e/run.mjs` | 本机未执行 |
| 既有 DROP SCHEMA integration | 未执行 |

## Actions

通过运行的 head SHA 是 `33d11ada7bcb28e1a0149952650c9b1e2cb35f44`。

- Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36954435171
- Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36954435171/job/110674164814 ，id `110674164814`，结论 success
- Artifact `m4-single-shot-render-e2e-evidence` id `11205972371`，4915252 字节，SHA-256 `b5f7951c84fed3fd98e59efac630ea8f68509a2379cb2fdf4b74e101d597ef0f`，expires `2026-10-09T02:26:17Z`
- 下载后的 zip 与上述 SHA-256 一致。`results.ok=true`，`outcome.ok=true`，missing 与 notPassed 为空。`fatal`、`restoreError`、`cleanupError` 为空，`composeDown.code=0`。
- Chrome `154.0.8037.97`。数据库 `m3av_36954435171a1`，迁移前 public 表数 0。MinIO 对象数 0。
- venv pytest：7 passed，1 warning。node 脚本：6 passed。

## 33 个阶段

全部 passed：

`docker`，`compose`，`identity`，`migrate-provision`，`processes`，`source-chain`，`page-submit`，`subtitle-music`，`playback`，`content-headers`，`png-draft-viewport`，`idempotency-retry`，`revision-history`，`gates`，`subtitle-music-gates`，`mock-boundary`，`subtitle-music-recovery`，`recovery-disk`，`recovery-flag`，`image-recovery`，`image-cost-guard`，`media-cancel`，`media-terminal-race`，`media-observation-replay`，`media-shot-isolation`，`compose-preflight-page`，`compose-preflight-gates`，`compose-preflight-readonly`，`compose-render-page`，`compose-render-gates`，`compose-render-lifecycle`，`compose-review`，`compose-provenance-stale`。

## 遗留

本机不能验证 Linux 父进程死亡信号，该条只在隔离 CI 执行。`python3` 与 `python3-venv` 仍没有精确 Debian 修订号。本地编码成本尚未计量。

未执行：本机 Docker 验收、既有 `DROP SCHEMA` integration、新 Migration、全库重置、main、force push、PR、merge、应用 pack、部署、付费 Provider、ComfyUI、真实模型。
