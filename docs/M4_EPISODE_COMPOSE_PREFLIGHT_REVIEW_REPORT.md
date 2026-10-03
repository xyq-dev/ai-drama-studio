# M4 集级预检审查修复报告

## 结论

两项审查问题已修复，功能范围没有扩大。换序、添加或移除会使进行中的预检失效，并同时解除它占用的 busy，清掉旧结果、哈希和旧错误，按钮可以立刻再次预检。迟到的成功、失败和 finally 不能清掉新请求的 busy，也不能覆盖新结果。

候选列表复用正式预检的单成片资格。明确不合格的成片不返回。数据库按稳定顺序、游标和请求的 limit 读取一批，不再先扫完整集再在内存分页。过滤不合格项后游标仍前进。空页不宣告结束，也不跳过后面的合格项。多片段数量、重复镜头和总时长仍是编排级校验。正式预检和单镜行为没有放宽。

没有新增多镜实际合成。Migration=NO。

## 现场

目录 `D:\Projects\ai-drama-studio`。分支 `feat/m4-episode-compose-preflight`。

- 起点 HEAD：`e46707c4fae2a0ef7df2abc09aa7e598d4b519bc`。开始时工作区干净，没有未提交修改需要保留。没有 reset、clean、stash 或覆盖。
- 审查源码 `abbf041f59628878516cf3b3947135ea97d988f0` 仍是当前分支祖先。
- 本轮验收 SHA：`b6c5ca148f6daa7ad4cb895c8c9fbb5221685f41`
- 报告 SHA 与验收 SHA 分开。报告 SHA 是包含本文件的 docs 提交，push 后与 `origin/feat/m4-episode-compose-preflight` 核对。
- `origin/feat/m4-single-shot-render` 仍是 `fc11bff93a087e510a94e25b883760e38b58a68c`。
- `origin/main` 仍是 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。
- `origin/feat/m4-compose-preflight` 仍是 `4b67d6a6ad11382c16a80e525859aaab8e379ecd`。
- `origin/feat/m3-lifecycle-acceptance` 仍是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。

## 修复一：解除失效预检的 busy

`remember()` 原先只增加 epoch 并清掉结果。旧请求的 finally 发现 epoch 已经变化，就不再 `setBusy(false)`，预检按钮一直禁用。

现在换序、添加和移除会清掉结果、错误和 busy，再增加 epoch。预检期间这些按钮本来就可以点。新的预检使用新的 epoch。旧请求的成功、失败和 finally 在 epoch 或集身份不一致时直接返回，不能清掉新请求的 busy，也不能写入新结果或新错误。集切换、A→B→A 迟到响应丢弃、失败后保留选择都还在。

影响范围是 `apps/web/src/components/episode-compose-preflight.tsx` 和它的页面测试。

## 修复二：统一单成片资格并有界分页

`assertEpisodeCompositeEligible` 从正式预检抽出，两边共用。它检查作用域、ACTIVE/APPROVED、审核哈希、单镜 metadata/schema/profile、合法时长和大小、成功的 MEDIA_COMPOSE、最新已完成 attempt，以及上游可用性。候选查询在这一批行上调用它；`REVIEW_REQUIRED` 或 `COMPOSE_INPUT_INVALID` 的行不返回。编排级的 2–30 段、重复镜头和总时长仍只在 `buildEpisodeComposePreflight` 里拒绝。

候选 SQL 按场景序号、镜头序号、assetId 排序，带行比较游标和 `LIMIT`。一次请求只读这一批。批满时，即使合格项为空，nextCursor 也取本批最后一条已扫描记录。批不满才表示结束。

影响范围是 `packages/domain/src/episode-compose-preflight.ts`、`packages/domain/src/index.ts`、`packages/database/src/media-assets.ts` 和对应测试。没有改 Migration、Worker、Python 渲染、媒体生成、单镜审核或来源失效语义。

## 模拟测试

这些测试没有连接真实 PostgreSQL，没有启动 API、Worker 或浏览器，也没有跑 `scripts/m3-av-e2e/run.mjs`。

- 领域 7 项通过。未知 metadata/schema、错误 profile、失败 Job、非最新或未完成 attempt 与正式预检的单成片结果一致。单段 50 秒仍合格，两段合计超过 90 秒只在编排级拒绝。同一镜头两份成片也只在编排级拒绝。
- 页面 5 项通过。覆盖旧请求未返回时换序、添加和移除，然后再次预检；旧请求随后成功或失败，新请求保持 busy 且结果不被覆盖；新请求完成后按钮恢复可用。集切换和失败保留选择仍通过。
- 数据库脚本 4 项通过。合格与不合格记录混排时，limit 为 2 的分页没有重复、没有遗漏。每一页只有一条带 `LIMIT` 的候选读取，返回行数和上游检查数都不超过 2。空页带有下一个游标。没有 INSERT、UPDATE、DELETE 或 TRUNCATE。
- `node scripts/m3-av-e2e/check.mjs` 通过。除集级预检对真实 POST 的延迟转发外，harness 仍拒绝 `page.route`、`route.fulfill` 和 `route.abort`。
- `pnpm m3-av-e2e:outcome` 23 项通过。36 个必需阶段的顺序和失败条件没有放宽。
- 本机 `pnpm verify` 通过。Web 测试里既有的 happy-dom 用例会打印 `ECONNREFUSED 127.0.0.1:3000`，这些用例仍然通过。本机 media worker 结果是 4 passed、2 skipped。本机没有 Docker，没有执行既有 `DROP SCHEMA`。

## 真实隔离 CI

Run `36966561157`，Job `110711479504`，head `b6c5ca148f6daa7ad4cb895c8c9fbb5221685f41`，结论 success。

https://github.com/xyq-dev/ai-drama-studio/actions/runs/36966561157

Artifact `m4-episode-compose-preflight-e2e-evidence`，id `11210202470`，3,996,683 bytes，下载 SHA-256 `c3aac57bc36771dbee62658fff7a205ba1a856dd8b4b04b91470320caa35c513`，到期 `2026-10-09T05:09:51Z`。下载字节数与 artifact 声明一致。

36 个必需阶段全部 passed，顺序仍以 `episode-compose-preflight`、`episode-compose-gates`、`episode-compose-readonly` 结束。`missing` 和 `notPassed` 都是空。`fatal`、`restoreError`、`cleanupError` 都是 null。`composeDown` 退出码 0。没有 skipped 或 failed 阶段。

新建隔离库 `m3av_36966561157a1`。迁移前 `public_tables=0`。只应用仓库已有 migration。没有 `DROP SCHEMA`。

浏览器阶段先完成一次真实预检，再把下一次真实 POST 停住。停住期间按钮禁用；上移后按钮恢复，并可以立刻再次预检。新的真实响应显示后，才放行旧响应。旧响应的哈希没有覆盖新结果，按钮保持可用。阶段因此通过。记录中的两次哈希是：

- 初始顺序 `df155830269cae8905b2bfe3ee5453768f97cad5b9faee06069a5df37999aa4c`
- 上移后 `e80824fdf241784c96d766c196804a1609ba6a6f8409c82fc6f509fedb9e3810`

两份成片是 `ec74a4e0-c1b3-4902-babd-a09b09dd2f7a` 和 `97abe55a-0e43-4c60-85c5-f79fd4eebfe9`。390px 下 `documentOverflow=0`，`bodyOverflow=0`。截图 `episode-compose-390.png` 在上述 artifact 内。上游场景换版后，预检返回 `REVIEW_REQUIRED`，页面仍保留两段选择。

只读指纹比较预检前后的行数、ID 和 `md5(row_to_json(t)::text)`。十张表都没有变化：

- `generation_job` 66 行，`57650458f44148427e9a631d51a5f112c3c2b11cd5344392af197c3210fb7ae5`
- `job_attempt` 69 行，`a39e7506b3d00c517eebd67b14d1667c296c69effe97dd6a1a3838305d8ab9bd`
- `workflow_run` 66 行，`baf3d203432ee14c0155068e1401aae572bc8d92e481fcfeea1835b3c90e3e1a`
- `asset` 45 行，`e365d898323fcb7bfdef533c94bd3dfe40c8ef4a0bdd7ffe5a844c0f5c4c20a8`
- `cost_ledger` 37 行，`89b581da29cbd4056ccc933ce756ee276f3ac04474f2be2879e5e67438ee6d8a`
- `dispatch_outbox` 69 行，`f29aa224d1b1af9d1a5f25405ee04e4129ae0b76df073b9666e42e3da8d9e85e`
- `domain_event` 601 行，`336cb4bf54843581327bd0eec32ba7641e2055ebb09ed258abfa6109a9fa26e7`
- `asset_dependency` 17 行，`412d14f4a21d6741f0ae51f8bdfcd7b0c1d8114501463ee5eede65cdde555b28`
- `asset_revision_dependency` 135 行，`135a6b22f22501235fbeca158949b9a780350c7ffff8e2b935eace4e35a10aa1`
- `idempotency_record` 226 行，`ab40523955b6da1894c790b0f2a32446fe68c7f810b31e899a225fed84b03e5d`

被拒绝的预检也使用同一比较，十张表仍然不变。准备两份成片和门禁数据时的写入不计入这次预检。

## 未执行

没有多镜渲染、Worker 分发、Python 集级编码、集级成片审核、真实 Provider、MinIO 写入、导出下载或付费模型。没有新增 Migration。本机没有安装 Docker，也没有重装。没有操作 main、来源分支、force push、PR、merge、pack、部署或生产数据。

## 远端

验收提交已推到 `origin/feat/m4-episode-compose-preflight`。来源分支、main、compose-preflight 和 lifecycle 分支没有被这次推送改动。报告提交只改 docs，用来确认它没有启动同一 workflow。
