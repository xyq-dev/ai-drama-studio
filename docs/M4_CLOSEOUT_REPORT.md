# M4 收尾与集成准备

本文件只整理已有验收，不新增功能。仓库没有 `AGENTS.md`。范围仍以 [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) 为准，启动入口是仓库根目录 [`README.md`](../README.md)，开发操作见 [`DEV_RUNBOOK.md`](DEV_RUNBOOK.md)。报告提交不能代替验收 SHA。产品样片的 52 阶段仍属于 `72b51b9` 的 Run `37100980441`。主线入口提交另有一次同清单重跑，见下方记录；该记录不改写固定提交统计。

PR #40 已合并。核实过的 `origin/main` 是 `4f42f7ea786ef47b04a86a94f16350d4da8e1d13`。该 main 上的 M1-C Run `37135367806` 与 52 阶段 Run `37135367830` 均已成功。这两次是合并后的既有验收，不是运行手册这一轮的新测试。完整 M4 和完整生产成本仍未验收。下面的矩阵、历史 SHA 和固定的 83/202、84/204 统计保持原样。

最后通过的产品验收 SHA 是 `72b51b9ce59ff997b619eee3b9303c6e84f366a3`。来源 `feat/m4-three-episode-sample` 的 `a6cd529891ea4fee282d787c973a9d8de02e48ec` 只在其后更新了样片报告和 390px 截图。

## 验收矩阵

总判：**部分通过**。已通过的是同步 Mock 媒体与本地 FFmpeg 技术闭环。三集输出是固定技术样片，不是真实 AI 短剧。

| 条件 | 标记 | 验收 SHA | Run | 报告 |
| --- | --- | --- | --- | --- |
| 单镜合成预检 | 已通过 | `9e457e4962839915fb19eddc6b77020c5a0d9c02` | `36873348954` | [`M4_PREFLIGHT_REVIEW_FIX_REPORT.md`](M4_PREFLIGHT_REVIEW_FIX_REPORT.md)，报告提交 `4b67d6a6ad11382c16a80e525859aaab8e379ecd` |
| 单镜本地合成、播放与审核 | 已通过 | `33d11ada7bcb28e1a0149952650c9b1e2cb35f44` | `36954435171` | [`M4_SINGLE_SHOT_RENDER_FINAL_FIX_REPORT.md`](M4_SINGLE_SHOT_RENDER_FINAL_FIX_REPORT.md)，报告提交 `fc11bff93a087e510a94e25b883760e38b58a68c` |
| 集级编排与只读预检 | 已通过 | `b6c5ca148f6daa7ad4cb895c8c9fbb5221685f41` | `36966561157` | [`M4_EPISODE_COMPOSE_PREFLIGHT_REVIEW_REPORT.md`](M4_EPISODE_COMPOSE_PREFLIGHT_REVIEW_REPORT.md)，报告提交 `d127a344570224bad8a685121759ad3fc60c406b` |
| 集级硬切合成、播放、审核与来源失效 | 已通过 | `4426743f4558517ae0ea20cd0cd84fbae9cfb9b9` | `37002393916` | [`M4_EPISODE_RENDER_REVIEW_FIX_REPORT.md`](M4_EPISODE_RENDER_REVIEW_FIX_REPORT.md)，报告提交 `18e85eb3c0f0613975774590f108fbf7a28a2236` |
| 已批准集级成片下载与来源清单 | 已通过 | `95f4df1075277267d79443ec4799b71b87df9947` | `37086868513` | [`M4_EPISODE_EXPORT_REPORT.md`](M4_EPISODE_EXPORT_REPORT.md)，报告提交 `08b0555e94dd989e3d2f36225d12e7367a07b9e3` |
| 项目已记录成本查询 | 已通过 | `174a6bd564ca77d03241eef13de30271acf4c3ff` | `37091291592` | [`M4_PROJECT_COST_SUMMARY_REPORT.md`](M4_PROJECT_COST_SUMMARY_REPORT.md)，报告提交 `c187f08011dba61060ed7c37a84b764fd11a1f32` |
| 三集 60/75/90 秒技术样片 | 已通过 | `72b51b9ce59ff997b619eee3b9303c6e84f366a3` | `37100980441` | [`M4_THREE_EPISODE_SAMPLE_REPORT.md`](M4_THREE_EPISODE_SAMPLE_REPORT.md)，报告提交 `a6cd529891ea4fee282d787c973a9d8de02e48ec` |
| 原定标准：一个创意产出三集 60–90 秒、审核通过、非 STALE、可下载且来源/成本完整的 1080×1920 MP4 | 部分通过 | 同上技术样片 SHA | `37100980441` | 样片报告。来源与审核已在该次闭环核对；成本不完整 |
| 真实 Provider | 未执行 | — | — | — |
| 付费模型 | 未执行 | — | — | — |
| ComfyUI 实际调用 | 未执行 | — | — | — |
| 生产启用 | 未执行 | — | — | — |
| 完整 M4 | 未执行 | — | — | — |

样片闭环的 52 个阶段属于 `72b51b9` 的 Run `37100980441`。其后的文档提交没有重跑该闭环。

三集技术样片项目记录了 24 行 ACTUAL USD `0.00000000`。这是 Mock 媒体的已记录金额，不代表完整生产成本。15 次单镜合成和 3 次集级合成共 18 次本地编码没有账本行。每集第 1 镜附带的 Mock 配音、音乐和字幕仍是短静音和固定字幕。

## 集成候选

共同祖先与 `origin/main` 都是 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。`72b51b9` 是 `a6cd529` 的祖先；两者之间没有产品源码差异。下列计数固定在对应 SHA，不随后续文档提交改写：

| 固定 SHA | 相对 `origin/main` |
| --- | --- |
| `a6cd529891ea4fee282d787c973a9d8de02e48ec` | 83 个提交，202 个文件。这是来源 `feat/m4-three-episode-sample`，不是当前候选 |
| `44d5f2c945d661902bbd17b4410221b6d27f2fae` | 84 个提交，204 个文件。这是接通主线验收入口之前的 `chore/m4-closeout` |

合入会带到：

- `apps/web`：创作工作台、单镜/集级编排与合成、下载、已记录成本。
- `apps/api`、`apps/worker`：Mock 媒体、本地合成和样片请求。
- `services/media-worker`：单镜与集级 FFmpeg 合成。
- `packages/contracts`、`packages/domain`、`packages/database`、`packages/providers`：样片描述、资格、账本查询和两份固定 MP4。
- `scripts/m3-av-e2e` 与对应的隔离 workflow。

开关在代码中的默认值都是 false，production 强制关闭：`M3_MOCK_IMAGE_ENABLED`、`M3_MOCK_AV_ENABLED`、`M3_MOCK_SUBTITLE_MUSIC_ENABLED`、`M4_LOCAL_COMPOSE_ENABLED`、`M4_LOCAL_EPISODE_COMPOSE_ENABLED`、`M4_MOCK_SAMPLE_VIDEO_ENABLED`。样片生成还要求 AV 开关和绝对 `MOCK_OBJECT_DIR`。本地合成要求绝对 `M4_COMPOSE_WORK_DIR` 与 `M4_COMPOSE_OBJECT_DIR`。这些配置不在启动时自动 provision。

运行依赖仍是 Node.js `>=24.21.0 <25`、pnpm `10.17.0`、PostgreSQL、Redis、MinIO，以及合成路径上的 Python media worker 和 FFmpeg。

相对 main，`packages/database/prisma/migrations` 没有文件差异。main 与候选都已有这 5 个 migration：

- `20260924000100_m1b_job_core`
- `20260925000100_m2a_text_chain`
- `20260928000100_script_dependency_scopes`
- `20260928000200_m3a_media_assets`
- `20260928000300_m3b_job_shot_lineage`

本轮 Migration=NO。这只表示收尾没有新增迁移；候选本身相对 main 也不再携带新的 migration 文件。本轮不执行迁移或部署。

## 交接

唯一集成候选是 `chore/m4-closeout`。最后通过的产品验收 SHA 是 `72b51b9ce59ff997b619eee3b9303c6e84f366a3`。

入口：

- 范围：[`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)
- 启动：[`README.md`](../README.md)
- 本记录：[`M4_CLOSEOUT_REPORT.md`](M4_CLOSEOUT_REPORT.md)

52 阶段 workflow 仍使用原有路径过滤。产品与验收路径覆盖 `apps/**`、`packages/**`、`services/**`、`scripts/m3-av-e2e/**`、`infra/compose.yaml`、锁文件和该 workflow 自身。`docs/**` 不在过滤列表中，纯文档提交不重复触发。事件为样片分支、`chore/m4-closeout` 和 `main` 的 push，发往 `main` 的 `pull_request`，以及 `workflow_dispatch`。权限保持 `contents: read`。不使用 `pull_request_target`，没有生产凭据、发布或部署步骤。`chore/m4-closeout` 的 push 已在验收 SHA `de522441f096c96493911a571e7f9edb23c78f8d` 上自动触发 Run `37104185587` attempt 1，job `111149400295`。隔离库 `m3av_37104185587a1` 迁移前 `public_tables=0`，只应用已有 migration。52 个阶段全部 passed。`fatal`、`restoreError`、`cleanupError` 为空，`composeDown` 退出码 0。证据包 artifact `11268046670`，13730884 字节，SHA-256 `81cce7ebe43bbb6b290aaa6737894004bf9df97c95ca3ee66763bd8574a82121`。发往 `main` 的 pull request 和 `main` 的 push 仍只完成配置检查，尚未由这些事件执行。上述 84/204 与 83/202 不因这次记录改写。

剩余工作按这个顺序：先做该候选的合并前审查；审查前不继续扩展 Mock 功能。其后才可能单独处理真实 Provider、付费模型、ComfyUI、生产启用和未计量的本地编码成本。这些事项现在都未执行。

上述交接记录保留到合并前。PR #40 合并之后，候选已经在 `main` 的 `4f42f7ea786ef47b04a86a94f16350d4da8e1d13`。开发运行步骤见 [`DEV_RUNBOOK.md`](DEV_RUNBOOK.md)。这份手册不表示环境已经部署，也不把 M1-C Run `37135367806` 或 52 阶段 Run `37135367830` 记成新的产品验收。真实 Provider、付费模型、ComfyUI 实际调用、生产启用、完整 M4 和完整生产成本仍然未执行。
