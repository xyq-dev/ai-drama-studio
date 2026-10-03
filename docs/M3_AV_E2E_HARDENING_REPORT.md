# M3 AV E2E 补强报告

## 范围

目录 `D:\Projects\ai-drama-studio`，分支 `feat/m3-av-workbench`。fetch 后本地 `1bf3f36` 快进到审查提交 `35a50144ff0a999f90c8ee0ce6270581f8979596`。工作区当时没有未提交改动。产品源码、固定 fixture 和 `infra/compose.yaml` 未改。

## 起点与最终 SHA

- 起点：`35a50144ff0a999f90c8ee0ce6270581f8979596`
- 本轮真实通过的验收 SHA：`8b08c259e78a9925f13e48297d8e588cc8afe024`
- 报告提交与该验收 SHA 分开。最终仓库 SHA 在报告 push 之后由 fetch 核对。

## 改动文件

- `scripts/m3-av-e2e/outcome.mjs`
- `scripts/m3-av-e2e/outcome.test.mjs`
- `scripts/m3-av-e2e/run.mjs`
- `scripts/m3-av-e2e/check.mjs`
- `package.json`
- `.github/workflows/m3-av-e2e.yml`
- 本报告

## 本机命令

| 命令 | 结果 |
| --- | --- |
| `git fetch` + `git merge --ff-only` | exit 0，HEAD 成为 `35a5014` |
| `node --test scripts/m3-av-e2e/outcome.test.mjs` | exit 0，13 tests passed |
| `node --check` 与 `node scripts/m3-av-e2e/check.mjs` | exit 0 |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9 |
| 本机 Docker | 没有 `docker` 命令。真实服务只在 Actions 上运行 |

## 通过的 CI

验收 SHA `8b08c259e78a9925f13e48297d8e588cc8afe024`。

- Run：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36812029981
- Job：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36812029981/job/110208968710
- Artifact：https://github.com/xyq-dev/ai-drama-studio/actions/runs/36812029981/artifacts/11139724818 ，id `11139724818`，1673545 bytes，到期 2026-10-08

`results.json`：`ok` true，`fatal` null，`cleanupError` null，`restoreError` null。`outcome.missing` 与 `outcome.notPassed` 都是空。16 个必需阶段全部 passed。

普通 push：`7f159b8..8b08c25`。`git fetch` 后该 SHA 与 `origin/feat/m3-av-workbench` 一致。没有 force push、main、PR、merge。

## 账本关联

视频 job `fa4e72c0-2c8c-4b73-b420-695127799af7`：attempt `376ef35e-efaa-4ab2-ae5a-8561bdc7e8cc`，cost `jobAttemptId` 相同，`providerRequestId` 同为 `mock-media|sync|video.generate|fa4e72c0-2c8c-4b73-b420-695127799af7:1`，ACTUAL USD 0，`finishedAt` 有值。配音 attempt `96d2d2dc-9164-4573-849f-19d8164bb331` 与 cost `jobAttemptId` 相同。`submitCallsMeasured` 为 false，没有把 request id 不变写成 submit 次数。

磁盘恢复原 attempt `finishedAt` `2026-10-01T03:49:06.166Z`，`error_json.code` `MOCK_AV_OUTPUT_INVALID`，`retryable` false，无 Asset/cost。关 AV 后原 attempt `finishedAt` `2026-10-01T03:50:08.655Z`，`error_json.code` `MOCK_MEDIA_NOT_CONFIGURED`，`retryable` false。retryable 存在 `job_attempt.error_json`，不是单独列。

关 AV 后的图片 job 有 Asset，`sourceJobAttemptId` 等于 attempt `c5748a2b-45ba-4588-9c58-6816cfd0f727`，没有 cost 行。`apps/worker/src/runtime/mock-image-generation.ts` 的 `persistMockImageOutput` 调用 `completeAttemptWithAsset` 时没有 `actualCost`。这是现有产品行为，本轮没有改产品源码。

## 390px 与默认关闭

截图 `viewport-390.png` 在视口仍为 390×844 时保存，330137 bytes，在上述 artifact 内。document/body/hash 溢出仍为 0。

默认关闭使用删除了 `M3_MOCK_AV_ENABLED` 的 API 进程，`unsetPresent` false。生成返回 `CONFIGURATION_ERROR`，任务数没有增加。显式 false 与 production 负例仍在。

## 404 与 pageerror

`console.json` 有 4 条 console error，location URL 都是 `http://127.0.0.1:3000/favicon.ico`，阶段为 page-submit 与 playback。没有 pageerror。没有把这 4 条当成产品失败，也没有在缺少 URL 时称作 favicon。必需的生成和 asset/content 请求没有失败记录。

## 同分支未通过的运行

`7f159b81235090852f8927ce1df8222436fda4e9` 的 Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36811375914 、Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36811375914/job/110206949719 结论 failure。Artifact https://github.com/xyq-dev/ai-drama-studio/actions/runs/36811375914/artifacts/11138929391 。`recovery-flag` 在图片任务上要求 cost 行，产品没有写 cost，`results.ok` 为 false。这不是本轮通过。

## 尚未执行

- 成本冲突、全部暂时故障与取消竞争、隐藏标签页、Windows 与其余 Compose 故障组合。
- 字幕、音乐、成片、完整 M3、M4。
- 既有 integration 套件、新 Migration、DROP SCHEMA、应用 pack、部署、付费 Provider、ComfyUI、真实模型、上游 MinIO OCI digest。
- 本机真实 PostgreSQL、Redis、MinIO、API、Worker、Web 和浏览器。
