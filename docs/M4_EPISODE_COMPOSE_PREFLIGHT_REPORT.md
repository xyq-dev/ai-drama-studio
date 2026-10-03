# M4 集级编排与只读预检报告

## 结论

集级多镜编排和只读预检已通过。用户可以在工作台查看本集已批准单镜成片，按顺序选择、上移、下移和移除，看到每段起止时间和总时长，并向服务端请求确定的来源清单和 `inputHash`。界面显示「预检通过，尚未执行多镜合成」。

本轮停在只读预检。没有创建多镜合成任务，没有新的集级成片，没有执行集级 FFmpeg。多镜实际渲染是下一批。

这不是完整 M4，不是真实 AI 生成，也不是生产就绪。

## 现场

目录 `D:\Projects\ai-drama-studio`。来源分支 `feat/m4-single-shot-render`，来源 HEAD `fc11bff93a087e510a94e25b883760e38b58a68c`。该提交包含已验收源码 `33d11ada7bcb28e1a0149952650c9b1e2cb35f44`。开始时工作区干净，没有未提交修改需要保留。没有 reset、clean、stash 或覆盖。

目标分支 `feat/m4-episode-compose-preflight` 原先不存在，已从核实后的来源创建。`33d11ad` 是该分支祖先。

- 本轮验收 SHA：`abbf041f59628878516cf3b3947135ea97d988f0`
- 报告 SHA 与验收 SHA 分开。报告 SHA 是包含本文件的 docs 提交，push 后与 `origin/feat/m4-episode-compose-preflight` 核对。
- `origin/feat/m4-single-shot-render` 仍是 `fc11bff93a087e510a94e25b883760e38b58a68c`。
- `origin/main` 仍是 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。
- `origin/feat/m4-compose-preflight` 仍是 `4b67d6a6ad11382c16a80e525859aaab8e379ecd`。
- `origin/feat/m3-lifecycle-acceptance` 仍是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。

## 修改原因与范围

工作台需要在集级入口编排多份已批准单镜成片，并在不写业务表的情况下得到稳定的拼接清单和 `inputHash`。

影响范围是预检类型与纯函数、只读候选查询和来源校验复用、两条 API、独立页面组件及工作台接入、验收阶段、隔离 workflow 和本报告。单镜合成面板、文本草稿、If-Match 和 409 确认没有改行为。已验收单镜 profile 没有改。

Migration=NO。没有新表，没有持久化编排记录，没有改既有 migration。

## 功能

`GET /projects/:projectId/episodes/:episodeId/compose-candidates` 按场景序号、镜头序号和 assetId 稳定分页。候选必须是当前集里可用的已批准单镜成片。响应不含磁盘路径、objectKey 或凭据。

`POST /projects/:projectId/episodes/:episodeId/compose-preflight` 只接受 `{compositeAssetIds}`。请求顺序就是编排顺序。响应 schema 是 `m4.episode.compose.preflight.v1`。manifest 含 workspace、project、episode、有序 segments 和拼接计划。`startMs` 从 0 累加，`endMs = startMs + durationMs`。`inputHash` 只覆盖 manifest。`rowVersion` 在 guards。`verification` 为 `metadata`，`diskContentChecked` 和 `decoded` 都是 false。

一次选择同一 workspace、project、episode 内 2–30 个成片。assetId 不重复，同一个逻辑镜头只能选一份。每段整段使用。总时长不超过 90,000 ms。短于 60 秒仍可通过，并提示「尚未达到 V1 的 60–90 秒目标」。来源失效时预检被拒绝，页面保留已选顺序。

## 实际修改文件

相对 `fc11bff`，验收提交改了 20 个文件，2102 行新增，13 行删除：

- `packages/domain/src/episode-compose-preflight.ts`
- `packages/domain/src/episode-compose-preflight.spec.ts`
- `packages/domain/src/index.ts`
- `packages/database/src/media-assets.ts`
- `packages/database/src/episode-compose-preflight.spec.ts`
- `apps/api/src/studio/studio.controller.ts`
- `apps/api/src/studio/studio.service.ts`
- `apps/api/src/studio/episode-compose.service.spec.ts`
- `apps/web/src/components/episode-compose-preflight.tsx`
- `apps/web/src/components/episode-compose-preflight.spec.tsx`
- `apps/web/src/components/workbench.tsx`
- `scripts/m3-av-e2e/episode-compose-preflight.mjs`
- `scripts/m3-av-e2e/episode-compose-preflight.test.mjs`
- `scripts/m3-av-e2e/run.mjs`
- `scripts/m3-av-e2e/outcome.mjs`
- `scripts/m3-av-e2e/lifecycle.test.mjs`
- `scripts/m3-av-e2e/check.mjs`
- `package.json`
- `.github/workflows/m4-episode-compose-preflight-e2e.yml`
- `docs/API_CONTRACT.md`

## 定向测试与 verify

领域测试覆盖顺序改变哈希、重复预检哈希稳定、毫秒时间线、60 秒和 90 秒边界、重复资产、同一镜头两份成片、跨集/项目/workspace、DRAFT、REJECTED、STALE、旧 revision、来源重算未完成、伪造来源、失败任务和非最新 attempt。`rowVersion` 改变不改变 `inputHash`。

数据库脚本测试不连接 PostgreSQL。它检查请求顺序、待处理 stale recalculation、旧镜头修订、跨项目成片，以及候选响应不含存储路径。语句不以 INSERT、UPDATE、DELETE 或 TRUNCATE 开头。

API 服务测试确认未知字段、重复资产和缺失 media store 会在写入前拒绝，成功预检不调用幂等写入。

页面测试使用 happy-dom 和模拟 fetch，没有启动 API、数据库、Worker 或浏览器。覆盖改序后旧哈希消失、失败后保留选择、A→B→A 迟到响应被丢弃，以及加载失败后的重新查询只有 GET。

本机 `pnpm verify` 通过。Web 测试里既有的 happy-dom 用例会打印 `ECONNREFUSED 127.0.0.1:3000`，这些用例仍然通过。本机没有 Docker，没有跑 `scripts/m3-av-e2e/run.mjs`，没有执行既有 `DROP SCHEMA`。本机 media worker 结果是 4 passed、2 skipped。

## 隔离 CI

Run `36963506355`，Job `110702137877`，head `abbf041f59628878516cf3b3947135ea97d988f0`，结论 success。

Artifact `m4-episode-compose-preflight-e2e-evidence`，id `11209267373`，4,041,518 bytes，SHA-256 `1b73fbc14fe8987f6ef86fb9fcad7ace5048511914526e44813fbb6b8ec4d6c3`，到期 `2026-10-09T04:27:51Z`。

36 个必需阶段全部 passed。`missing` 和 `notPassed` 都是空。`fatal`、`restoreError`、`cleanupError` 都是 null。`composeDown` 退出码 0。没有 skipped 或 failed 阶段。

新建隔离库 `m3av_36963506355a1`。迁移前 `public_tables=0`。只应用仓库已有 migration。Migration=NO。没有 `DROP SCHEMA`。

同一集两个不同镜头的已批准单镜成片：

- `1ad3321a-26d4-4e5d-9581-9aab19f8685c`
- `76e0bb8e-cce7-4107-be9c-76ccd3d48a62`

浏览器选择后预检 `inputHash` 为 `387e4578de4d6e55dca4245b93644cd41f003336ee720f2c493f8b2ff47bb435`。上移后再次预检为 `eb9b395fb23fa2ce5ff21f7738b769b70a6740eef133cd34bdf3f939929597b1`。两次哈希不同，时间线从 0 累加。上游场景换版后，再次预检返回 `REVIEW_REQUIRED`，页面仍保留两段选择。

390px 视口下 `documentOverflow=0`，`bodyOverflow=0`。截图 `episode-compose-390.png` 在上述 artifact 内。

只读指纹在准备数据完成且任务静止之后，比较预检前后的行数、ID 和 `md5(row_to_json(t)::text)`。十张表都没有变化：

- `generation_job` 66 行，`658091b4a1975bc5baa86f6fb7037629c6d580523096f29b8170b08563b53e12`
- `job_attempt` 69 行，`f69f9376339a7f5e2664060e68a25e7eec67142e51439918a469cb8b87fb9498`
- `workflow_run` 66 行，`90aa17cee49f44312853307119ca28aea2bf39dbd773e462db7274ce3a7bb53e`
- `asset` 45 行，`28c76d950e4dc02675ad624fe034230cf8b373f5f7dbc67c550902f45daddacd`
- `cost_ledger` 37 行，`62a7f212c18b44ad0d7e2f8d09c480f57d8209d282aba8b8e26923c049af9ac2`
- `dispatch_outbox` 69 行，`fbf20b6b0e668570f9679e22beac952f4f31c32c2e1fdb4c7f30bcd7c555dc6a`
- `domain_event` 601 行，`9c5ca445d064ef26797ba14e0aa21ef4348f180b720af8ab57c886d4cb9bb651`
- `asset_dependency` 17 行，`bc6a9934c0dd143725c6494ac6f62d93245dd6cbac38e4344380bcee85dbb11e`
- `asset_revision_dependency` 135 行，`2b4bb8e0e5202e6a8e3fcebb86c3ce5768c160b28d6f5ae8652d45ad0e1223fb`
- `idempotency_record` 226 行，`5f9d6d072649c061aad22e79743af0e0b8e82772954ac47add8af44d77d5bf95`

被拒绝的预检也使用同一比较，十张表仍然不变。准备两份成片和门禁数据时的写入不计入这次预检。

## 未执行

没有多镜渲染、Worker 分发、Python 集级编码、集级成片审核、真实 Provider、MinIO 写入、导出下载或付费模型。没有新增 Migration。本机没有安装 Docker，也没有重装。

## 远端与遗留

验收提交已推到 `origin/feat/m4-episode-compose-preflight`。来源分支、main、compose-preflight 和 lifecycle 分支没有被这次推送改动。

同一 workflow 上较早的三次运行失败后已修复，不作为验收：`36958363951` 的阶段顺序断言未包含新增阶段；`36958709669` 调用了已经停止的 3026 端口；`36962193812` 把已经失效镜头的 `REVIEW_REQUIRED` 误判成必须是 `COMPOSE_INPUT_INVALID`。通过的运行是 `36963506355`。

没有 PR，没有 merge，没有部署。
