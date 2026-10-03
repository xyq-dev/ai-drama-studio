# M4-E1 整剧已记录成本汇总

本报告只记录整剧已记录成本查询。它不代表三集 60–90 秒样片、完整生产成本或完整 M4 验收。Migration = NO。

## 目录与提交

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio` |
| origin | `https://github.com/xyq-dev/ai-drama-studio.git` |
| 分支 | `feat/m4-project-cost-summary` |
| 起点 | `08b0555e94dd989e3d2f36225d12e7367a07b9e3` |
| 已验收源码 | `95f4df1075277267d79443ec4799b71b87df9947` |
| 验收 SHA | `174a6bd564ca77d03241eef13de30271acf4c3ff` |
| 报告 SHA | 仅含本文件的提交；推送后与 `origin/feat/m4-project-cost-summary` 一致 |
| Migration | NO |

起点是 `origin/feat/m4-episode-export`。验收提交的父历史包含 `08b0555` 和 `95f4df1`。`origin/main` 仍为 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。`origin/feat/m4-episode-export` 仍为 `08b0555e94dd989e3d2f36225d12e7367a07b9e3`。本轮只普通推送 `feat/m4-project-cost-summary`。

## 修改原因与范围

项目工作台需要按币种查看当前项目全部历史 `cost_ledger`：已记录实际金额，以及尚未被 `ACTUAL.supersedes_cost_id` 明确替代的估算。这是账本视图。它不是当前成片独占成本，也不是完整生产成本。

读取使用一条 `REPEATABLE READ READ ONLY` 查询。金额在 PostgreSQL `numeric` 中聚合，API 返回固定八位小数字符串。空账本的 `currencies` 为空数组。已记录的 `ACTUAL 0` 通过笔数与“没有账本行”区分。本地合成不补虚构的零成本行。

允许改动的是 domain 口径、只读查询、`GET /projects/:projectId/cost-summary`、项目信息区的独立成本组件、测试、CI harness 和本报告。账本写入与替代规则、历史补账、Worker、Provider、固定媒体 fixture、Python 渲染、审核状态机、下载资格与来源清单、M2 草稿都没有改。没有新表、索引、产品开关、后台任务或 Migration。

关键文件：

- `packages/domain/src/project-cost-summary.ts`
- `packages/database/src/project-cost-summary.ts`
- `apps/api/src/studio/studio.service.ts`
- `apps/api/src/studio/studio.controller.ts`
- `apps/web/src/components/project-cost-summary.tsx`
- `apps/web/src/components/workbench.tsx`
- `scripts/m3-av-e2e/project-cost.mjs`
- `.github/workflows/m4-project-cost-e2e.yml`

## 统计口径与边界

基表是当前 workspace 和 project 的 `cost_ledger`。客户端不传 `workspaceId`。其他 workspace 的项目沿用 `NOT_FOUND`。

1. 实际金额是全部 `ACTUAL` 行相加，包含失败、取消、重试和历史 attempt。读取时不按当前 Job、最新 attempt 或现用 Asset 筛除。
2. 未结算估算只计入没有被 `ACTUAL.supersedes_cost_id` 明确引用的 `ESTIMATED` 行。聚合使用 `NOT EXISTS`。不按请求 ID、金额或时间推断替代，也不假设两行币种相同。
3. 币种分开统计，不换汇，不生成跨币种总额。多条合法 `ACTUAL` 都计入。同金额的不同账本行不去重。
4. `job_attempt_id` 可以为空。查询不通过 inner join attempt 丢掉历史行。
5. 总额不转回 `numeric(20,8)`，因此可以超过单行 12 位整数上限。API 不做 `Number` 或 `parseFloat`。
6. 没有账本行不表示免费。`boundary.localEncodeCostMetered` 和 `totalProductionCostKnown` 固定为 `false`。

`providerBoundAttemptsWithoutLedgerCount` 是已绑定 Provider 请求但没有关联账本行的 attempt 数，不等于确定漏收费用。`localComposeAttemptCount` 只识别 `m4.shot.compose.v1` 和 `m4.episode.compose.v1`。`ledgerRowsWithoutAttemptCount` 统计 attempt 为空的历史行。

页面默认折叠，展开后读取，可手动刷新，没有后台轮询。每种币种展示“已记录实际金额”和“未结算估算”。固定说明是“包含本项目历史调用；本地编码等成本尚未计量。”加载失败、空记录、刷新失败分开显示。刷新失败保留同一项目的上次结果，并标明读取时间和刷新失败。项目切换、卸载和重复刷新后，旧响应不能覆盖新结果。

## 测试

本机没有 Docker，没有执行 `scripts/m3-av-e2e/run.mjs`。真实 Chrome、API、Worker 和 PostgreSQL 只在本次隔离 CI 中运行。

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `packages/domain` `project-cost-summary.spec.ts` | 0 | 4 项通过。空账本、真实零金额、八位小数、超过单行上限的总额、跨币种和显式替代 |
| `packages/database` `project-cost-summary.spec.ts` | 0 | 1 项通过。SQL 使用 `NOT EXISTS` 和只读事务，不含 `numeric(20,8)`、`parseFloat`、`DISTINCT`、`FOR UPDATE` |
| `project-cost-summary.spec.tsx` | 0 | 5 项通过。空态、真实零金额、首次失败、刷新失败保留上次结果、切换、卸载和迟到响应 |
| `pnpm m3-av-e2e:check` | 0 | 验收提交前通过 |
| `pnpm m3-av-e2e:outcome` | 0 | 23 项通过，要求 48 个阶段 |
| `pnpm verify` | 0 | lint、typecheck、test、build，以及 media-worker 7 passed / 2 skipped。domain 54、database 24、web 104 项通过 |

上表是本机模拟或静态检查。下面的 Run 才是新建隔离库上的真实闭环。

## 隔离 CI

| 项 | 值 |
| --- | --- |
| Run | https://github.com/xyq-dev/ai-drama-studio/actions/runs/37091291592 |
| attempt | 1 |
| Job | `111111996058` |
| 结论 | success |
| 验收 SHA | `174a6bd564ca77d03241eef13de30271acf4c3ff` |
| Artifact | `m4-project-cost-e2e-evidence` / `11262781137` |
| 大小 | 4827170 字节 |
| 下载 SHA-256 | `7cfb5b0866b369ef1563cecfe18adb52c2b56c3a994f7fc4d08c2cddb9fe2182` |
| 数据库 | `m3av_37091291592a1`，迁移前 `public_tables=0` |
| Migration | NO。Applied 5 migration(s)。没有 DROP SCHEMA |

48 个阶段全部 `passed`。原有 45 个阶段保留。新增且通过的阶段是 `project-cost-summary`、`project-cost-gates`、`project-cost-readonly`。`fatal`、`restoreError`、`cleanupError` 为空。`composeDownFailed` 为 false。`compose down` 退出码 0，隔离库的 postgres、redis、minio 容器和对应 volume 已删除。`results.ok` 为 true。`notPassed` 与 `missing` 为空。没有 skipped 或 failed 阶段。

同一轮媒体闭环下载的集级 MP4 为 Asset `49e74d13-9e56-42a9-a2a1-684d0e4d1c18`，Job `a963799d-f021-4229-861d-5f745ed4323b`，attempt `3c27f4c9-152b-4d6b-9141-6f9e87d371b4`，8079 字节，SHA-256 `eaa79f534f91cf0f8600100a8af3a3757ba75d9782c51d1a0aea000fb13e9662`。这是成片文件，不是成本接口的响应。

## 真实读取结果

媒体闭环所在项目的账本由 API 与独立 SQL 一致读出，Chrome 在 390px 展开并刷新。`ledgerRowCount` 为 49。USD 已记录实际金额 `1.00000000`，实际 48 笔；未结算估算 `0.00000000`，1 笔。覆盖为 job 107、attempt 112、无账本 Job 58、已绑定 Provider 但无账本 attempt 14、本地合成 attempt 49、空 attempt 账本行 0。页面展示实际金额和笔数，并保留“本地编码等成本尚未计量。”

空项目 `e255c345-6174-4261-9713-963b15efa09f` 的 `currencies` 为 `[]`，`ledgerRowCount` 为 0。页面说明没有记录不等于免费。

独立测试项目 `fa0be3fd-b77f-4ab8-b461-fb95f19d5adc` 在保留约束和触发器的情况下写入标记 `m4-project-cost-summary-test` 的账本。API、手算字面量和独立 SQL 一致：

| 币种 | 已记录实际金额 | 实际笔数 | 未结算估算 | 未结算笔数 | 已替代估算笔数 |
| --- | --- | ---: | --- | ---: | ---: |
| CNY | `0.00000000` | 0 | `3.25000000` | 1 | 1 |
| EUR | `0.00000000` | 0 | `8.00000000` | 1 | 0 |
| USD | `1200000000010.00000001` | 7 | `0.00000000` | 0 | 0 |

`ledgerRowCount` 为 10。两条 `600000000000.00000000` 都计入。两条 USD `ACTUAL` 明确替代同一条 CNY `ESTIMATED`，该估算只计 1 笔已替代，不再进入未结算估算。失败 Job 7 行、取消 Job 2 行、旧 attempt 4 行、空 attempt 1 行都在账本中。覆盖为 job 7、attempt 6、无账本 Job 4、已绑定 Provider 但无账本 attempt 1、本地合成 attempt 2、空 attempt 账本行 1。USD 总额超过单行 `numeric(20,8)` 的整数位数，响应仍是八位小数字符串。

其他 workspace 请求该测试项目返回 404 `NOT_FOUND`，正文没有测试金额。随机项目 ID 同样返回 404。Chrome 在 390px 展示上述三种金额，没有横向溢出，也没有把结果写成整剧免费或成本完整。

测试账本的插入在只读窗口之前。窗口内对测试项目成功读取两次，并拒绝一个不存在的项目。十张业务表的 ID、行数和完整字段指纹没有变化。

## 只读指纹

| 表 | 行数 | 指纹 |
| --- | ---: | --- |
| generation_job | 114 | `1f968868ecf9305fced8f8a25d484921b488e8fa5f23ea2629eaeb08bf78bbe3` |
| job_attempt | 118 | `474d41d11bfd6fc19ba3dbad46ab389fe2cd5df7fb9dae020973cc8746a625b6` |
| workflow_run | 114 | `f40fa940a1a9701d98e63d0dd669487026490a12ee71b5734a455a9ac84b8d0d` |
| asset | 111 | `272438ea73122101449ebe051ef474ed9f928db61142916b5ff32adbd75ece55` |
| cost_ledger | 59 | `3ebeacb7ff74c693f269ffab381899bbdc61b125200872894b944bcdd23e676b` |
| dispatch_outbox | 109 | `e1c5d3d341e13ed48ee7ebeab4dac3e2ce9c92daae6874c3888ab5033a7ba093` |
| domain_event | 981 | `fb2dd267ebcc0202ba47d40be8a4d6c95c52bebd48381722fee1e1755a5e4004` |
| asset_dependency | 51 | `f5d42f18696bb96e9b8b2ea647b782a61c1d535dc05c56276c95ce1b7c791221` |
| asset_revision_dependency | 204 | `b761d7b9f360551bd2b11091787f947fa1a623677934895d7de99501f740ec2c` |
| idempotency_record | 366 | `53c9c20455512ca75dc7163e53ce1f6a4d7c5843fa7717c5c61403c25ecc08eb` |

`cost_ledger` 的 59 行是媒体闭环 49 行加上标记测试账本 10 行。`cost_ledger` 插入后不可修改，测试行随隔离库一起删除，没有单独删除。

## 遗留与下一步

本轮通过只表示整剧已记录成本可以按币种查询。三集 60–90 秒样片、完整生产成本和完整 M4 仍未验收。

本机未执行真实 Docker 闭环，也未在本机 Chrome 中打开工作台。CI 的 `notRun` 仍包括：其他媒体组合的成本冲突、未触发的暂时故障组合、隐藏标签页、Windows 与其余 Compose 故障、会 `DROP SCHEMA` 的既有 integration 套件，以及新 migration、main、force push、PR、merge、应用 pack、部署、付费 Provider、ComfyUI 和真实模型。

下一步仍是样片时长和完整生产成本的单独验收。费用明细、按集分摊、Provider 或 model 分组、CSV 下载都不在本轮范围内。
