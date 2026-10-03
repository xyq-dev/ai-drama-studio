# M3 同步 Mock 生命周期验收报告

## 结论

M3 同步 Mock 生命周期既定范围通过。这不是完整 M3，不是真实 Provider，也不是生产就绪。

## 现场

目录 `D:\Projects\ai-drama-studio`。来源分支 `fix/m3-mock-image-accounting` 的远端与本地 HEAD 都是 `c8c6ee178b058abab339109885711479b5684e51`，其中包含已验收源码 `1b01b0b684513ab63ae14430bcc39971d75f3782`。当时工作区干净。目标分支 `feat/m3-lifecycle-acceptance` 原先不存在，因此从该来源 HEAD 新建，没有 reset、clean、stash 或合并。

- 本轮真实通过的验收 SHA：`67dcb64ad7b6e93f700acf6e3980b95b9f6f210d`
- 报告提交与该验收 SHA 分开。最终仓库 SHA 在报告 push 之后由 fetch 核对。
- 远端核验：push 后 `origin/feat/m3-lifecycle-acceptance` 与本地 HEAD 一致。

同一分支上先有一次失败运行，不能算通过：`53e82d12255f722a158e9fc4c08bd3cd75044a24`，run `36847991699`，job `110322638360`，artifact `11154108370`（2195445 字节，SHA-256 `4bdc50c49e1a1c0ed2f7cdc2364ee3a993dbd5b69597f451305d19274e581f52`）。`media-cancel` 已通过，`media-terminal-race` 失败，后面两个阶段 skipped。失败原因是第二个 `FOR UPDATE` 等待者的 `pg_blocking_pids` 指向第一个等待者，而判定当时只认直接指向持锁进程的 pid。锁链本身已经证明重叠。验收 SHA 改为沿这条链追溯到持锁进程。

## 修改范围

允许范围内的 harness、判定、测试、workflow 和两份文档。没有改产品 API、Web、Worker、database 实现、Provider 契约、固定 fixture、开关、snapshot、请求 ID 或 `infra/compose.yaml`。没有新增公网 callback、媒体手工 retry、异步生成入口或 Migration。

- `scripts/m3-av-e2e/lifecycle.mjs`、`lifecycle.test.mjs`：四个必需阶段和判定
- `scripts/m3-av-e2e/run.mjs`、`outcome.mjs`、`check.mjs`：原有 21 个阶段保持在前，四个新阶段接在 `image-cost-guard` 之后
- `package.json`：`m3-av-e2e:check` 与 `m3-av-e2e:outcome` 纳入生命周期脚本
- `.github/workflows/m3-lifecycle-e2e.yml`：只在 `feat/m3-lifecycle-acceptance` 和 `workflow_dispatch` 上运行，`contents: read`，路径不含 `docs/**`
- `docs/M3_MOCK_IMAGE_ACCOUNTING_REPORT.md`：恢复记录改为“先记录原始 normalizedEventKey 和 externalStatus；hash 包含在事件键中，完整 observation 未持久化。”

## Migration

Migration=NO。没有新 Migration。仓库已有 migration 和已有 provision 只用于本次新建、身份已核实且迁移前 public 表数为 0 的隔离库 `m3av_36849236180a1`。没有 `DROP SCHEMA`，没有 `TRUNCATE`，没有连接本机已有库，没有用 SQL 伪造 Job、Attempt 或 Asset 成功。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`。本机没有 Docker，因此没有执行 `scripts/m3-av-e2e/run.mjs`。既有会 `DROP SCHEMA` 的 integration 套件没有执行。真实库证据来自下面的 Actions。

`pnpm verify` 在两个实现提交前各执行一次，退出码都是 0：lint 9/9，typecheck 14/14，test 14/14，build 9/9。Web 测试 61 通过，期间有模拟 API 的 `ECONNREFUSED 127.0.0.1:3000`。API 17 通过，Worker 50 通过。

| 命令 | 结果 |
| --- | --- |
| `pnpm m3-av-e2e:check` | exit 0 |
| `pnpm m3-av-e2e:outcome` | exit 0，19 tests passed |
| `pnpm verify` | exit 0 |
| `node scripts/m3-av-e2e/run.mjs` | 本机未执行 |
| 既有 DROP SCHEMA integration | 未执行 |

## Actions

通过运行：

- SHA `67dcb64ad7b6e93f700acf6e3980b95b9f6f210d`
- Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36849236180
- Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36849236180/job/110326691339 ，id `110326691339`
- Artifact `m3-lifecycle-e2e-evidence` id `11154804519`，1892935 字节，SHA-256 `246a777bc37eb2a9044b3cd92c4438eaa658b64e6617fdfdfa2d80be5585c84b`，expires `2026-10-08T10:38:48Z`
- `results.ok=true`，25 个必需阶段全部 passed。数据库 `m3av_36849236180a1`，迁移前 public 表数 0。MinIO 对象数 0。

失败运行见上文，不能算通过。

## media-cancel

真实生成接口创建任务，目录写失败让真实 Worker 绑定 request 和 attempt。停止 Worker 后，真实取消接口用同一幂等键重放，响应和取消事件、attempt 都没有新增。恢复目录并启动 Worker 后，租约恢复把单 Job workflow 收成 `CANCELED`。`error_json` 是 `{code:CANCELED}`，没有 `retryable` 字段。`response_snapshot` 为空。没有 Asset、成本或 `job.succeeded`。`job.cancel_requested` 与 `job.canceled` 各一条。

| 类型 | Job | Attempt | Workflow | finished_at |
| --- | --- | --- | --- | --- |
| IMAGE | `cd5270fa-60ef-42cd-8748-600f1c1689a2` | `2234006b-7fdc-4304-b39f-45d7e3dfd2d1` | `da0a3e41-4a6b-4aa6-9eb3-0e754b6080a8` | `2026-10-01T10:36:33.584Z` |
| VIDEO | `98307e6e-a4d8-48b6-b7de-3a6f4301b5dc` | `1adc7b53-44b8-4836-a2a8-34f7b19f76f5` | `0c87dd64-8097-4bb4-a495-a0680cb81994` | `2026-10-01T10:36:33.590Z` |
| AUDIO | `e93eecc0-4e6b-4765-a868-53ee0371bf6f` | `45415fcc-11f7-4439-ac4d-39251b0d148a` | `c3ea5b94-c83b-46d0-b3ec-6fd5f1ad3633` | `2026-10-01T10:36:33.594Z` |
| SUBTITLE | `400ddf8c-19aa-4dee-ba81-6bc2386625df` | `a11a07f2-cc51-47be-a465-da39661e76e5` | `307443bc-c033-4070-9876-1d2893da753b` | `2026-10-01T10:36:33.608Z` |
| MUSIC | `8ec27a40-eeb4-4ad8-8d4d-a7c005c89b91` | `c9acc830-0329-4b66-9305-047db1bf679f` | `46e6e495-f153-4d27-a489-b4c7e1173b52` | `2026-10-01T10:36:33.612Z` |

请求 ID 仍是原来的 `mock-media|image.generate|...:1` 或 `mock-media|sync|<capability>|...:1`。

## media-terminal-race

Worker 进程在受控竞争期间停止。验收连接 `BEGIN` 后对 Job 行 `SELECT FOR UPDATE`。取消走真实 HTTP，完成走本次构建的 Worker recovery 函数。`pg_blocking_pids` 显示一个等待者被持锁 pid 挡住，另一个等待者排在前一个等待者后面。释放锁之后按入队顺序提交。

| 顺序 | 类型 | 持锁 pid | 等待链 | Job | 终态 | Asset | Cost | 成功事件 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 取消先提交 | IMAGE | 807 | 95 被 807 挡住，808 被 95 挡住 | `e3d20c07-8c2f-493d-9f90-70d8490ed2ef` | CANCELED | 无 | 无 | 0 |
| 成功先提交 | IMAGE | 819 | 808 被 819 挡住，95 被 808 挡住 | `cc281798-81f4-4487-b1a9-89dc9f725578` | SUCCEEDED | `e2a6411e-515d-4993-ad2f-b3f222cbe746` | `849b2c1c-7269-4a2b-8829-c9fee5c18900` | 1 |
| 取消先提交 | VIDEO | 823 | 95 被 823 挡住，808 被 95 挡住 | `dba29936-75df-44ba-8444-53fffe43a3d3` | CANCELED | 无 | 无 | 0 |
| 成功先提交 | VIDEO | 827 | 808 被 827 挡住，95 被 808 挡住 | `51d1cc83-5ab3-4d2c-b3a1-1ac22adf9f59` | SUCCEEDED | `5222cea6-2a24-4414-98a0-af3a3cd49bd4` | `e2335e6a-332d-4557-9bde-ed4fcdf25e58` | 1 |

成功先提交的随后取消返回 409 `JOB_TERMINAL`，成功记录的 attempt、Asset、成本和 `response_snapshot.outputAssetIds` 保持原样。取消先提交的 attempt 有 `finished_at`，`error_json.code` 为 `CANCELED`，workflow 为 `CANCELED`。对应 workflow：`16747471-0d1e-4abf-afd9-a3d869411df4`、`c497ddc7-fb00-4784-a8f3-676f4b6ef78c`、`7c490e5b-d29f-4cc1-b608-4a0179e5a0bf`、`300c4846-bee2-43f3-b903-a7231bb47443`。

## media-observation-replay

这是真实 PostgreSQL 上的内部服务调用，使用本次构建的 `MockMediaAdapter`、database 服务和 `recoverMockImageAttempt` / `recoverMockAvAttempt` / `recoverMockSmAttempt`。不是公网 callback。计数来自传入这些函数的 adapter 实例：submit 0，inspect 14。这不是真实 Worker 进程的 submit 计数。

五类成功任务第一次观测各写入一条 `source=POLL`、`externalStatus=SUCCEEDED` 的 ProviderEvent，第二次相同 `normalizedEventKey` 不再新增。两次都得到 `JOB_TERMINAL`。Asset、成本、成功事件、attempt、job 和 workflow 保持不变。

| 标签 | Job | 事件键 | ProviderEvent | 终态 |
| --- | --- | --- | --- | --- |
| IMAGE | `deb0b71d-519b-4fad-be5b-1b23fc60ffff` | `poll:bbd4ddefee6823a9a797be92346c9b58fdb037a719c7f1ab20c511d232590b2e` | `671023b5-fdd3-432b-80d1-9bc06b224afb` | SUCCEEDED，Asset `193e667b-bd55-477b-9a7e-a481e8c29136`，Cost `18ef2346-fc73-45be-8890-85f73429117e` |
| VIDEO | `95a147e2-d9eb-44bd-9a8e-55bc4cc35026` | `poll:c62034ff5551b12a18d7c5f3d51f7a2c95722b3ae4f63ad58d92cb5d41cb0a1b` | `6fadcb6d-1a57-4824-92d9-0ec33e22a82d` | SUCCEEDED，Asset `7def1f46-bebd-4f06-af45-564a267083bd`，Cost `1cf78344-78dc-4257-b52a-c0f622a9a572` |
| AUDIO | `27544491-ff96-4f14-935c-e9b5c81bc4b5` | `poll:8bf2a9d8973ed5838672ba5344da481ec6ef9a3fb51621f10ff400c8362f3483` | `80a45ab8-d329-456a-b0e5-e5bda6c11644` | SUCCEEDED，Asset `f8c819e2-8097-4ee2-887e-12bc5d372f21`，Cost `ba2ade1a-bb0e-40e7-b4ed-f00c9a09213d` |
| SUBTITLE | `801b1b66-4da7-4fa4-adde-c6090c71bb77` | `poll:10ad0bc4f861f152dae66107e1d4913edeafb3f4cead905a185f18c401f9a8ea` | `033a4dec-5873-4206-a790-f27db8bb363c` | SUCCEEDED，Asset `aca6ac0f-f0d1-4b14-8005-8e4f863301af`，Cost `010ee177-5244-40e5-8308-e9f1021cd6ca` |
| MUSIC | `ebac256e-bf31-4be5-a1be-945081f5f127` | `poll:644ba0bfbf9d49aa14d367755a9431e5f17eeb48b10d92313a6f5ec23ecece04` | `464bb700-5a37-4b12-bb6b-8106cdcdb6dc` | SUCCEEDED，Asset `aa065bcd-7a7e-44a8-bd78-b3821531f68b`，Cost `e278fdf0-212b-4a7b-8d1e-6683c98ad5e3` |
| CANCELED | `cd5270fa-60ef-42cd-8748-600f1c1689a2` | `poll:d69da796b974598b13643e83a8efb086bc25fcccd7bdf52f409894514bae31ef` | `5ddc06bf-ba71-4916-9bff-68734997b146` | 仍为 CANCELED，无 Asset、成本或成功事件 |
| FAILED | `ff46132f-22ee-490e-beea-e824656b32f6` | `poll:486429d0a4370f169eb70b53dc452b754a2c8f57c246b31560b4db59d9664e5a` | `69a52b7a-1c98-48d4-b1e5-0bf616372d91` | 仍为 FAILED，`MOCK_AV_OUTPUT_INVALID` 且 `retryable=false`，无新增事件、Asset 或成本 |

迟到成功观测可以留下审计事件，但不能重开终态。磁盘上的确定性对象文件不等于 Asset 成功。

## media-shot-isolation

同一项目 `cb02fdcd-9c9d-4c59-9aa5-348ac88a1d46`、同一场景 `58888657-7851-4930-bdfb-fb2611586f89` 上新建两个已批准且 CURRENT 的镜头。A `f3035c69-a38a-4412-93e1-ec41f7cccc4c` / revision `e932feb1-90cf-41bc-b918-9618702efb47`。B `9c46b33f-8056-4802-a9a6-ddd1a1f04ffa` / revision `d6476ddb-5960-4e6b-b3ce-43c0acc543a9`。IMAGE 和 VIDEO 通过真实接口并行提交。A 取消，B 成功。B 的 attempt、workflow、Asset 和成本不受 A 影响。

| 镜头 | 类型 | Job | Attempt | Workflow | 终态 | Asset | Cost |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A | IMAGE | `f8e149b0-9a66-4880-8cb8-7421e61d3281` | `57ba9b73-23b5-4694-816c-db134ed57fee` | `5661bed8-2da9-4c58-bb33-891655b767aa` | CANCELED | 无 | 无 |
| B | IMAGE | `b3398413-83af-4f83-89ad-9b84584007ad` | `36985423-9c0b-4796-83ed-29414db8d3e0` | `7acf09d1-545a-4910-a75f-87c0acb00aea` | SUCCEEDED | `99600ead-9b21-47d9-965e-93a88a066cf9` | `b68f81d8-7216-43ab-b174-0a8e48961420` |
| A | VIDEO | `fa295146-52da-4be0-a414-f337a632373a` | `392d4c88-20c9-4aef-ae76-da3e21518b56` | `4b9867a8-c33c-4b89-9056-37c5db07603d` | CANCELED | 无 | 无 |
| B | VIDEO | `8f16d074-e12b-4c39-8438-a44b0fdce7e9` | `91ee3fd7-3306-4aef-84f3-0f1b915ddc51` | `eddb713f-e274-4960-9785-bd6196020f0c` | SUCCEEDED | `c67ab816-75d7-4540-b05e-4d85e2ba8c89` | `7cf8970b-1e45-4db9-bf60-b67ab3cc14bc` |

B 的对象键分别含自己的 Job：`mock-images/.../b3398413-83af-4f83-89ad-9b84584007ad/...png` 与 `mock-videos/.../8f16d074-e12b-4c39-8438-a44b0fdce7e9/...mp4`。来源镜头版本是 B 的 revision。真实浏览器切换后，A 的资产接口 `listedAssetIds` 为空，页面不出现 B 的 assetId、jobId 或 revision。B 的页面列出上述两个 Asset，并显示自己的 revision 和任务。两边 fixture 字节相同，隔离依据是 assetId、`sourceShotRevisionId` 和请求关联。已有工作区拒绝用例仍在 `gates` 阶段通过。

## 未执行与授权边界

本机服务型验收未执行。失败运行 `53e82d1` 保留为失败证据。没有遗留产品缺陷需要放宽断言。

commit 与普通 push 已执行。main、force push、PR、merge、pack、deploy 未执行。
