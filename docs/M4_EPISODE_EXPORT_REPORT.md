# M4-D 集级成片下载与来源清单

本报告只记录已批准集级成片的 MP4 下载和来源清单。它不代表三集 60–90 秒样片、完整成本汇总或完整 M4 验收。不沿用 Run `37021902206` 或 `37026479322`。Migration = NO。

## 目录与提交

| 项 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio` |
| origin | `https://github.com/xyq-dev/ai-drama-studio.git` |
| 分支 | `feat/m4-episode-export` |
| 起点 | `18e85eb3c0f0613975774590f108fbf7a28a2236` |
| 已验收源码 | `4426743f4558517ae0ea20cd0cd84fbae9cfb9b9` |
| 验收 SHA | `9f69e83770bb07ab560474dc9a9de4716e889461` |
| 报告 SHA | 仅含本文件的提交；推送后与 `origin/feat/m4-episode-export` 一致 |
| Migration | NO |

起点来自 `feat/m4-episode-render`。验收提交的父历史包含 `18e85eb`。`origin/main` 仍为 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。`origin/feat/m4-episode-render` 仍为 `18e85eb3c0f0613975774590f108fbf7a28a2236`。本轮只普通推送 `feat/m4-episode-export`。

## 修改原因与范围

已批准的集级 `COMPOSITE` 需要直接下载原 MP4，并下载同一资产的来源清单。播放接口保持原有预览语义。正式下载走独立资格校验，不收紧历史播放接口。

不重新编码，不创建 ExportJob、Workflow、Asset、Outbox、成本或导出记录，不写幂等表或 DomainEvent。不生成 ZIP，不引入签名链接或公开分享。不新增产品开关，不恢复对 `MOCK_OBJECT_DIR` 的依赖。沿用 `M4_LOCAL_COMPOSE_ENABLED` 与 `M4_LOCAL_EPISODE_COMPOSE_ENABLED`，以及 production 关闭规则。

下载前检查资格，再用同一打开句柄有界读取并校验 SHA-256。发送成功响应前，短事务重新检查资格和冻结哈希。复查失败不发出 MP4 成功响应。网络传输期间不持有数据库事务和行锁。资格以最终核验时点为准。

清单 schema 为 `m4.episode.export.manifest.v1`。字段只包含核验时点、集与资产、审核、集级 Job、冻结顺序和实际参与合成的直接媒体。标明 Mock 来源边界，以及本地编码成本未计量。不导出本地路径、objectKey、凭据或整份 snapshot。

页面只在 `ACTIVE` + `APPROVED` 的集级卡片上提供「下载 MP4」和「下载来源清单」。两类下载都走同源 `/api/v1`。成功校验响应后才保存。错误 JSON 不会保存成 `.mp4`。迟到响应不能写到切换后的卡片。

关键文件：

- `packages/domain/src/episode-export.ts`
- `packages/database/src/media-assets.ts`
- `apps/api/src/studio/compose-content.ts`
- `apps/api/src/studio/episode-export.ts`
- `apps/api/src/studio/studio.service.ts`
- `apps/api/src/studio/studio.controller.ts`
- `apps/web/src/lib/episode-export-proxy.ts`
- `apps/web/src/lib/studio-client.ts`
- `apps/web/src/components/episode-compose-job-panel.tsx`
- `scripts/m3-av-e2e/episode-export.mjs`
- `.github/workflows/m4-episode-export-e2e.yml`

没有改 Worker、Python 渲染、固定 fixture、审核状态机或 M2 草稿。没有新 migration。

## 测试

本机没有 Docker，没有执行 `scripts/m3-av-e2e/run.mjs`。真实 Chrome、API、Worker 和 PostgreSQL 只在本次隔离 CI 中运行。

| 命令 | 退出码 | 说明 |
| --- | --- | --- |
| `pnpm verify` | 0 | 实现提交 `9ed0ada` 之前。lint、typecheck、test、build，以及 media-worker 7 passed / 2 skipped。Web 测试 96 项通过 |
| `pnpm m3-av-e2e:check` | 0 | 实现提交前，以及两次 harness 修复后 |
| `pnpm m3-av-e2e:outcome` | 0 | 实现提交前，以及候选列表等待修复后，23 项通过 |

两次 harness 修复没有重跑完整 `pnpm verify`。它们只改验收脚本：页面等待候选成片渲染完成；清单里的 `inputHash` 对照 `generation_job.input_hash`，`preflightInputHash` 对照提交时的预检哈希。隔离 CI 在验收 SHA 上重新执行了 harness check、outcome regression 和 45 个真实阶段。

定向测试覆盖下载资格、错误 hash、DRAFT/REJECTED/STALE、schema、非最新 attempt、依赖不一致、pending STALE、文件缺失、目录、symlink/junction、超限、增长、截断、哈希不符、MP4/JSON/HEAD、同源代理、错误响应不保存，以及切集后的迟到响应。

## 隔离 CI

| 项 | 值 |
| --- | --- |
| Run | https://github.com/xyq-dev/ai-drama-studio/actions/runs/37029807979 |
| attempt | 1 |
| Job | `110913504108` |
| 结论 | success |
| Artifact | `m4-episode-export-e2e-evidence` / `11237039665` |
| 大小 | 4805552 字节 |
| 下载 SHA-256 | `a244f60004189bf3ce1ea31a0838c0a9dc57fca2e0375edf69bd933868338f57` |
| 数据库 | `m3av_37029807979a1`，迁移前 `public_tables=0` |
| Migration | NO。只应用仓库已有 migration，没有 DROP SCHEMA |

45 个阶段全部 `passed`。原有 42 个阶段保留。新增且通过的阶段是 `episode-export-download`、`episode-export-gates`、`episode-export-readonly`。`fatal`、`restoreError`、`cleanupError` 均为空。`compose down` 退出码 0。`results.ok` 为 true。`notPassed` 与 `missing` 为空。

真实执行与模拟执行分开：单元测试和 `pnpm verify` 在本机使用模拟对象；上表 Run 在新建隔离库上执行真实合成、审核、Chrome 下载、ffprobe 和解码。

## 下载与清单对应

Chrome 在 390px 视口保存了 MP4 和 JSON。页面横向溢出为 0。

| 项 | 值 |
| --- | --- |
| Asset | `1e2514a1-677a-401d-ae79-dd4b03e2ab97` |
| Job | `8d7cb502-e28c-43f7-983d-0777c2a52981` |
| attempt | `97e568f5-643c-4560-968e-0130925db4c5` |
| 字节数 | 8079 |
| 下载 SHA-256 | `eaa79f534f91cf0f8600100a8af3a3757ba75d9782c51d1a0aea000fb13e9662` |
| 审核内容哈希 | 与下载 SHA-256 相同 |
| 冻结 inputHash | `62dfeda0ee5f273867a65403882d07da14b33ecbdeb6d0c0c4447020a9cde5cf` |
| preflightInputHash | `3f6187929dacf9745ef3ccc2eef180a23a2fd419bc434149db301b0f1fdce32d` |
| 清单 SHA-256 | `6ff45f0e21519b12c1635bf97ab506394c3a28d3a1f319ea2722d2251833e9af` |

清单 `asset.checksumSha256`、`asset.byteSize` 与下载文件一致。尺寸 1080×1920，25 fps，时长 2000 ms，审核 `APPROVED`，`rowVersion` 2。ffprobe 与完整解码通过。HEAD 响应体为空，`Content-Length` 为 8079。Range 请求返回完整 200，正文与 MP4 相同。同源 Web HEAD 也带回 `attachment`。

两段顺序：

1. `0–1000 ms`，单镜成片 `ff1f8214-e052-4ce2-acbf-d7d4c05f152b`，镜头 `9efa4186-3107-484b-a4b8-946eddc32938` / 修订 `c0cbb0d0-d26d-4819-99dd-0bbbcd2d9127`。直接媒体是 VIDEO `31dcb546-2e46-4b61-bb16-69d0f73088c2`，来源 Job `8ff52b01-b201-46d1-a038-80f90554f1fa`，attempt `5134246e-860e-45ed-bbcc-5bb725f3d3bb`。
2. `1000–2000 ms`，单镜成片 `499fe301-2711-4efb-8c82-f9ea0e84480c`，镜头 `469f382d-fbd7-4ded-bd70-b3d167703d6e` / 修订 `e7003c27-2797-42a0-9aa4-5f8b0223c8d4`。直接媒体是 VIDEO `81f958fe-391a-4a0b-810c-c61a2dd4a508`，来源 Job `db8cf6a5-7891-4e43-ba91-efbcedd20c4a`，attempt `ad53f4b3-2cfa-490d-a21b-64e988a20284`。

这两段依赖边与数据库一致。清单没有本地路径或 objectKey。两个 GET 各自核验，不构成一次原子打包。

门闩阶段在文件读取之后、最终资格复查之前替换来源。导出被拒绝：资产 `d282e461-b45c-476e-a7e3-708a9b3961b1`，HTTP 400，`COMPOSE_INPUT_INVALID`。门闩由测试目录 `M4_EPISODE_EXPORT_LATCH_DIR` 控制，不是新产品开关。默认关闭、未设置和 production 仍返回 `CONFIGURATION_ERROR`。没有 `MOCK_OBJECT_DIR` 时，合格成片仍可导出。

## 只读指纹

数据准备并等待后台空闲后，成功导出、重复导出、HEAD 和错误 hash 拒绝都没有改变以下记录。负例数据准备在这个窗口之外。

| 表 | 行数 | 指纹 |
| --- | ---: | --- |
| generation_job | 107 | `0b6f2bf86bebcc0aac27cab698ccabc9fd89601fafce61ff675a62af04489f42` |
| job_attempt | 112 | `e70321e9aaa7e2d32d778a9a025b8fd79873a092f9525f7271bf812f8e23ddf3` |
| workflow_run | 107 | `91c3475395d2a99b4d29ba10b4be84ae74fe51df1be33e7cd8b6495c6538dac2` |
| asset | 111 | `fd5e2e8fcc5614b02049402943fc0a3663a5b0ae866883d3ff4598cace7aeabc` |
| cost_ledger | 49 | `dfa33e84ad9cbaed5eb5722d8fd33826a7fb735f5daa0dd0b2973867d029b15b` |
| dispatch_outbox | 109 | `79819b9223b2732a891ec869056311862ec04bd34ec358df89328777c088a0d9` |
| domain_event | 981 | `4a9801b00aa3db1e92cdae1288c6118af8e6881817bccc21bae6ba851ca78d65` |
| asset_dependency | 51 | `1e6ee382db7e487e271f833ecc1cefabab90bc83c9a8354786e5555cbd879566` |
| asset_revision_dependency | 204 | `4d48708827759b1993f1ed878dd27269b939c12229f50d2a60a83487adf05cb5` |
| idempotency_record | 364 | `b7ba59f1eddbb354a41ede71e6f7c150ee0362652177f53106d855cb9f77d7f0` |

## 遗留与未执行

本轮通过只表示已批准集级成片可以下载，并可以下载来源清单。三集 60–90 秒样片、完整成本汇总和完整 M4 另行验收。

本机未执行真实 Docker 闭环，也未在本机 Chrome 里保存文件。CI 的 `notRun` 仍包括：其他媒体组合的成本冲突、未触发的暂时故障组合、隐藏标签页、Windows 与其余 Compose 故障、会 `DROP SCHEMA` 的既有 integration 套件，以及新 migration、main、force push、PR、merge、应用 pack、部署、付费 Provider、ComfyUI 和真实模型。

清单写明本地编码成本未计量。本轮没有新增成本汇总，也不把 Mock 成片当作真实生成结果。
