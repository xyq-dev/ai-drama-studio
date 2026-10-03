# M4 单镜合成审查修复报告

## 结论

审查修复已通过原有 33 阶段隔离 CI。同一次合成在响应丢失后仍使用原请求体和幂等键；迟到的资产、任务、取消和审核响应不能覆盖较新状态。续租串行且捕获拒绝，失去租约时停止子进程组。成功事务在锁等待之后用数据库当前时钟复核租约，过期结果不能写入 Asset。发布保持 rename，不在失败后向最终路径 copyFile。

这不是完整 M4，不是真实 AI 生成，也不是生产就绪。本地编码成本没有计量。没有做生产分发许可验收。

## 现场

目录 `D:\Projects\ai-drama-studio`。分支 `feat/m4-single-shot-render`。开始时 HEAD 与 `origin/feat/m4-single-shot-render` 都是 `0f39154f251d4765c07b44e3c8f790083712267e`，工作区干净。没有 reset、clean、stash 或覆盖。

原验收 SHA 是 `e3cd939171bae75350cb6825ff432c27805974c5`。上一份报告 SHA 是 `0f39154f251d4765c07b44e3c8f790083712267e`。

- 本轮实际验收 SHA：`e0a44bb9197b5ded2669f4aa549354a73f03c3fb`
- 报告提交与该验收 SHA 分开。报告 SHA 是包含本文件的提交，push 后与 `origin/feat/m4-single-shot-render` 核对。
- `origin/feat/m4-compose-preflight` 仍是 `4b67d6a6ad11382c16a80e525859aaab8e379ecd`。
- `origin/feat/m3-lifecycle-acceptance` 仍是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。

## 修改原因与范围

相对上一份报告，16 个文件，+845/−107。只修 M4-B，没有新功能。

- 合成页保留同一次提交的请求体和幂等键；新的明确合成才换键。资产、任务、取消和审核都按世代丢弃迟到响应，覆盖同 revision 新任务以及 A→B→A。终态停止任务轮询，终态后仍刷新资产；隐藏暂停，恢复可见时再读。
- 续租串行并捕获拒绝。失去租约或续租异常时停止子进程组，旧 attempt 不提交。合成渲染独立限制为同时一个。编码与滤镜线程限制写在输入之后和 libx264 参数上，不只是输入前的 `-threads 2`。
- 锁等待结束后用 `clock_timestamp()` 复核租约，写入 Asset 前再确认一次。最新 attempt、owner、取消和终态检查仍在。
- Worker 暂存写入已经校验的字节。成片发布只 rename；rename 失败时删除临时文件并拒绝，不向最终路径 copyFile。API 读内容和 Python 工作目录都拒绝中间目录符号链接，解析后的路径必须留在配置根内。
- 原有阶段保留。生命周期阶段增加真实 Worker 终止后的恢复、成功事务内部失败回滚，以及跨越租约期限的数据库锁等待。原 HOLD 用例保留，并标明它是租约过期后的迟到结果，不是 Worker 崩溃。
- CI 安装参数固定 `ffmpeg=7:6.1.1-3ubuntu5`、`fonts-dejavu-core=2.37-8`、`python3-pytest=7.4.4-1`，安装后用 `dpkg-query` 断言。只打印版本不算固定。`python3` 与 `python3-venv` 没有精确 Debian 修订号，仍未按版本固定。venv 内 pytest 仍由 `pyproject.toml` 固定为 9.1.1。

## Migration

Migration=NO。没有新 Migration，没有改既有 migration、Prisma schema、触发器或约束。CI 只在身份核实且迁移前 `public_tables=0` 的新建隔离库 `m3av_36951922053a1` 上应用既有 migration。没有 `DROP SCHEMA`。

## Python、FFmpeg 与字体

记录来自通过的 CI 运行。安装参数和 `dpkg-query` 断言固定了下列版本。没有完成生产分发许可验收。

| 项目 | 记录 |
| --- | --- |
| Python | 3.12.3。venv pytest 9.1.1。系统 `python3-pytest` 7.4.4-1 |
| FFmpeg / ffprobe | 6.1.1-3ubuntu5，gcc 13（Ubuntu 13.2.0-23ubuntu3） |
| libavcodec | 60.31.102 |
| libx264 | 2:0.164.3108+git31e19f9-1 |
| 构建 | `--enable-gpl`、`--enable-libx264`、`--enable-libass`、`--enable-libfreetype`、`--enable-libfontconfig` |
| 字体 | `fonts-dejavu-core` 2.37-8，`/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf` |
| 字体 SHA-256 | `ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280` |

## 真实执行与模拟测试

模拟：`compose-job-panel.spec.tsx` 在 happy-dom 里用替换后的 fetch。它覆盖受理后丢响应、迟到 DRAFT 不覆盖 APPROVED、终态停止任务轮询、旧取消回读不覆盖新任务，以及 A→B→A。它没有启动 API、数据库、Worker 或浏览器。

本机真实文件系统：Worker 中间目录 junction 越界读取被拒绝；成片第二次发布和父路径被文件挡住时拒绝，原字节保留。API 中间目录 junction 越界读取被拒绝。这些是本机 `pnpm verify` 里的 vitest，隔离 CI 没有重跑这组 vitest。

本机真实 FFmpeg：`test_ffmpeg_execution_records_thread_limits` 实际执行 FFmpeg debug 日志，确认 `filter_threads`、`filter_complex_threads` 和 `threads=2`。本机 Windows 账号不能创建目录符号链接（WinError 1314），该条 Python 用例在本机 skip。

隔离 CI 真实执行：Linux pytest 6 passed、1 warning，包含中间目录符号链接拒绝和上述 FFmpeg 线程证据。`node scripts/run-media-worker-tests.mjs` 5 passed。生命周期阶段真实 SIGKILL 正在运行的 Worker，确认子进程消失后恢复；真实数据库会话 `FOR UPDATE` 跨越 4 秒租约；成功事务内部注入失败后，Asset、依赖和成功事件一起回滚。Chrome 播放、审核和 STALE 也是这次运行里的真实进程。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`。本机没有 Docker，因此没有执行 `scripts/m3-av-e2e/run.mjs`。既有会 `DROP SCHEMA` 的 integration 套件没有执行。

| 命令 | 结果 |
| --- | --- |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9。domain 32、api 20、worker 53、web 70。Web 测试仍打印 `ECONNREFUSED 127.0.0.1:3000` 并通过 |
| `node scripts/run-media-worker-tests.mjs` | 含在 verify 末尾。4 passed，1 skipped（本机符号链接权限） |
| `pnpm m3-av-e2e:check` | exit 0 |
| `node scripts/m3-av-e2e/run.mjs` | 本机未执行 |
| 既有 DROP SCHEMA integration | 未执行 |

## Actions

通过运行的 head SHA 是 `e0a44bb9197b5ded2669f4aa549354a73f03c3fb`。

- Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36951922053
- Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36951922053/job/110666516570 ，id `110666516570`，结论 success
- Artifact `m4-single-shot-render-e2e-evidence` id `11204029294`，4928249 字节，SHA-256 `62119b59c16fb90b4af32171e1c093c5c515daf3d0675cafe252a06d57a8d17a`，expires `2026-10-09T01:54:33Z`
- 下载后的 zip 与上述 SHA-256 一致。`results.ok=true`，`outcome.ok=true`，missing 与 notPassed 为空。`fatal`、`restoreError`、`cleanupError` 为空，`composeDown.code=0`。
- Chrome `154.0.8037.97`。数据库 `m3av_36951922053a1`，迁移前 public 表数 0。MinIO 对象数 0。
- venv pytest：6 passed，1 warning。node 脚本：5 passed。

## 33 个阶段

全部 passed：

`docker`，`compose`，`identity`，`migrate-provision`，`processes`，`source-chain`，`page-submit`，`subtitle-music`，`playback`，`content-headers`，`png-draft-viewport`，`idempotency-retry`，`revision-history`，`gates`，`subtitle-music-gates`，`mock-boundary`，`subtitle-music-recovery`，`recovery-disk`，`recovery-flag`，`image-recovery`，`image-cost-guard`，`media-cancel`，`media-terminal-race`，`media-observation-replay`，`media-shot-isolation`，`compose-preflight-page`，`compose-preflight-gates`，`compose-preflight-readonly`，`compose-render-page`，`compose-render-gates`，`compose-render-lifecycle`，`compose-review`，`compose-provenance-stale`。

### 成片播放

`compose-render-page` 的资产 `e306f981-45f6-43f3-ac29-c38930e834b4`，任务 `a4c34e49-86ee-46a0-b1c4-2c62f2f2de62`。播放证据：1080×1920，解码帧成功，画面亮像素 9501，播放进度 0.22344 秒，`ended=true`，横向溢出 0。内容读取仍是完整 200；没有宣称 206。

### 门禁

`compose-render-gates` 同键重放任务 `3a255cb5-f0ce-467a-9ab7-3db681856fb9` 仍是 `SUCCEEDED`。

### 取消、恢复、终止、锁等待与提交回滚

`compose-render-lifecycle`：

- 租约过期 / 迟到结果：任务 `ef60bd4d-f082-47e1-b15c-1ac1d4012fca`，2 个 attempt，成片挂在最新 attempt `b2bce530-ae62-4ea9-8dfa-e34f021d8609`。这是 HOLD，不是 Worker 崩溃。
- 真实 SIGKILL：任务 `6bc12a8a-edc1-4ff3-bb09-65754cf0d9da`。子进程在恢复前消失。2 个 attempt，唯一成片挂在最新 attempt `a38d4761-d8ec-4fd0-b66b-cbd2879abc40`，`job.succeeded` 1 条。
- 真实锁等待：任务 `cc9172dd-d985-4fa5-9aa9-a5c4909e244d` 最终 `SUCCEEDED`。过期 attempt `4a25ef12-c20d-4ee7-bdac-24edff9511e3` 没有成片，唯一成片属于后续 attempt。
- 事务内注入失败：任务 `eb874c86-87a1-458d-a2e7-a74fcb88b4fd`，错误码 `COMPOSE_COMMIT_INJECTED`。Asset、依赖、`asset.created` 和 `job.succeeded` 都是 0。
- 取消先提交：任务 `fbddaaec-0d03-4714-8149-5f8daf4638ad` 为 `CANCELED`。
- 成功先提交后再取消：`JOB_TERMINAL`。
- 生成期间来源失效：任务 `83e64283-cccf-462e-a5cf-d61de6a8b31d`，失败码 `REVIEW_REQUIRED`。
- 缺少输入文件：`COMPOSE_RENDER_FAILED`。

### 审核与 STALE

`compose-review`：批准 `APPROVED`，退回 `REJECTED`，并发决策只留下 `APPROVED`。

`compose-provenance-stale` 的资产 `e306f981-45f6-43f3-ac29-c38930e834b4` 变为 `STALE`，审核状态仍是 `APPROVED`。依赖边为 4 条素材边和 3 条 revision 边。

## 遗留边界

本地编码成本尚未计量，没有为 `MEDIA_COMPOSE` 写入虚构的 Provider `ACTUAL` USD 0。`python3` 与 `python3-venv` 没有按 Debian 修订号固定。本机不能创建目录符号链接，那条 Python 越界用例只在 Linux CI 执行。

产物自己的未执行项仍包括：尚未覆盖的其他媒体组合成成本冲突；其余未在本轮触发的暂时故障组合；隐藏标签页的浏览器验收（页面回归是模拟 fetch）；Windows 上的完整 Compose 验收；既有会 `DROP SCHEMA` 的 integration 套件；新 Migration、全库重置、main、force push、PR、merge、应用 pack、部署、付费 Provider、ComfyUI、真实模型。

本轮只修复单镜真实合成闭环的审查项。
