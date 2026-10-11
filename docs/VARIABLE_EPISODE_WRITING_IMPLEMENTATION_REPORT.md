# R1 实施报告：可选集数、每集目标时长与对应集数的 AI 文字创作

日期：2026-10-11

本轮状态（第 8 节为提交、推送、Draft PR 和 CI 的实际记录）：
- 代码已分组提交，已普通推送到功能分支，Draft PR #65 已创建。没有合并、打包或部署，PR 没有转为 Ready。
- 新 Migration 只在 GitHub Actions 作业专属的一次性空库中执行过；任何服务器和已有数据库都没有执行。
- 没有调用任何真实模型。

## 1. 工作区

| 项目 | 实际值 |
|---|---|
| 实施目录 | `D:\Projects\ai-drama-studio-variable-episodes`（新建的独立 worktree） |
| 分支 | `feat/variable-episode-writing`，已取消上游跟踪，避免误推送 |
| 基线 | `origin/main` = `722224891ae8d7e3cc9df1de9653170401de2573`（执行前 fetch 核验，main 没有前移） |
| origin | `https://github.com/xyq-dev/ai-drama-studio.git` |
| 参考工作区 | `D:\Projects\ai-drama-studio-title-writing`，分支 `docs/ai-drama-reuse-plan`。未改动，未跟踪的 `docs/AI_DRAMA_REUSE_AND_PRODUCTION_PLAN.md` 原样保留 |
| 其他 worktree | 都没有动过 |
| 工具链 | Node 24.21.0，pnpm 10.17.0（engines 检查保持开启） |

仓库内没有 AGENTS.md 或 CLAUDE.md，已阅读 `docs/ENGINEERING_WORKFLOW.md`。

## 2. 用户现在能做什么，哪些还没做

### 已能完成的闭环（代码层面，需先执行迁移并开启标题创作）

1. **创建作品**：在「AI 一键创作」选择：
   - 集数 1–6 集，默认 3 集；
   - 每集时长约 1 分钟或约 1.5 分钟，默认 1.5 分钟；
   - 剧名仍然必填，本批不自动拟标题。

   页面同时显示两个数字：正常需要 N+2 次调用，最多 N+5 次（不是自动重试次数）。页面还说明「每集时长是写作目标，不代表成片已经达到这个长度」。
2. **固定规格**：服务端把集数和目标时长写进作品。规格创建后不能修改，也没有修改接口。
3. **启动创作**：服务端按作品规格冻结一次 v2 任务（N、秒数、供应商、模型、输入版本、提示词版本）。步骤为 concept、outline、episode:1..N。
4. **人工审核**：审核故事后，服务端恰好建立 1..N 集。
5. **写入剧本**：按集写入项目剧本草稿。
   - 已有剧本的集报冲突，不覆盖；
   - 重复写入不会产生新版本。
6. **修改剧本**：在现有编辑器中修改并保存新版本，沿用原来的版本、锁和失效机制。

进度页把两个事实分开显示：「本次创作已生成 k / N 集剧本」和「已写入作品 m / N 集」。页面不会把「任务内生成完成」说成「已写入作品」。

### 本批没有做（按工单不做）

- 结构化剧本和新编辑器；AI 拆场景、拆镜头；局部媒体重做和画面复用。
- 真实图片、视频、配音；自动审核；服务端全流程编排；超过 90 秒的成片。
- 作品开始创作后增加或减少集数。
- 手动创建作品（作品首页）仍是三集、不记录目标时长，界面文案已改为如实说明。

Mock 场景和镜头链已改为覆盖作品的全部 N 集。它仍然是每集一个模板场景、一个模板镜头，页面写明「不是按剧本真实拆分」。

## 3. 后端改动：原因、影响范围、历史兼容

### 3.1 版本边界（契约 `packages/contracts/src/title-writing.ts`）

**v1 保持原样**，包括：
- 输入 `ads.title-writing.input.v1`、提示词 `ads.title-writing.prompt.v1`、大纲 `ads.writing.episode-outline.v1`；
- 设置固定 3 集、30–180 秒；
- 五个步骤，单任务上限 8 次。

**新增 v2**：
- 输入 `ads.title-writing.input.v2`、提示词 `ads.title-writing.prompt.v2`、大纲 `ads.writing.episode-outline.v2`；
- N 为 1–6，秒数为 60 或 90；
- 步骤 N+2 个，上限 N+5 次。

**选用哪个版本由服务端按作品规格决定，请求不能选。**
- 作品没有规格（目标时长为 NULL，即全部历史作品）时，继续使用 v1 规则；
- 作品有规格时，使用 v2。

**v1 冻结输入不变的证据：**
- 对 v1 的提示词和供应商 JSON Schema 取 SHA-256，用 origin/main 的构建和本分支的构建分别计算，结果一致：提示词 `f9d60262…`，Schema `e7d7a242…`。
- 这两个值已固定在测试 `packages/domain/src/title-writing-episodes.spec.ts` 中。
- 因此，已存储的 v1 任务续跑时，发送的内容和以前逐字节相同。

**共用常量的变化：**
- `TitleWritingStepKey` 扩展为 concept、outline、episode:1..6；
- `TITLE_WRITING_STEP_KEYS` 仍然只有 v1 的五个；
- 续跑确认上限从 5 放宽到 8，即 6 集任务的步骤数。

### 3.2 规格是同一个事实

| 环节 | 实现 |
|---|---|
| 项目创建 | `POST /projects` 接受 `episodeCount`（1–6）和 `targetEpisodeSeconds`（60/90），两者必须同时给或同时不给。不带规格的请求，幂等身份与以前完全相同。带规格时，迁移未就绪返回 503 `EPISODE_PLAN_UNAVAILABLE`，不写入任何数据 |
| 项目读取 | `GET /projects/:id` 增加 `episodeCount` 和 `targetEpisodeSeconds`。历史作品返回 `3` 和 `null`，页面显示「未指定」或不显示，不伪造 90 秒 |
| 标题启动 | `apps/api/src/studio/title-writing.service.ts` `frozenSettings`：从作品读规格。请求中的集数或秒数与规格不一致时返回 409 `TITLE_WRITING_PLAN_MISMATCH`，不创建任务，不发送 |
| 审核建集 | `packages/database/src/text-chain.ts` `ensureEpisodes`：按作品的 N 用 `generate_series(1, N)` 建集，之后校验恰好是 1..N。历史作品仍建 1..3，已有分集 ID 不变 |
| 剧本写入 | `title-writing-store.ts` `placeScripts`：作品规格和分集必须正好是该任务的 1..N，否则返回 `plan_mismatch`（409），一个字都不写 |
| 页面展示 | 开始页、进度页、工作台目录、新手流程的分集标签都按作品的 N 显示 |

### 3.3 动态步骤与输出校验

- 引擎 `packages/providers/src/title-writing-engine.ts` 的步骤、上下文、版本、调用上限、JSON Schema 和输出校验，都取自任务自己的冻结输入。
- **大纲**：必须恰好 N 项，按 1..N 排序，不能重复或缺集，schema 必须是 v2。供应商 JSON Schema 中的 `minItems`、`maxItems` 和 `episodeNo` 枚举也是 N，领域校验与供应商 Schema 一致。
- **每集**：编号必须等于所属集号。超出 N、错集号、非 JSON、被截断、超长，都明确拒绝。不自动续写，不切换模型，不提高输出上限。
- **故事长度预检（仅 v2）**：concept 和 outline 完成后、请求第一集之前，先检查格式化后的故事能否放入存储上限（`WRITING_BODY_MAX_CHARS`，2 万字）。放不下就把任务设为 `needs_attention / story_too_large`，分集请求次数为 0。v1 保持原行为，不加这项预检。

### 3.4 调用额度

- 仍按滚动 24 小时统计。
- **v2 新任务启动时**，在幂等键查询之后检查最近 24 小时的剩余次数；少于 N+2 时返回 429 `TITLE_WRITING_DAILY_QUOTA_LOW`（附需要次数和剩余次数），不创建 run 和 step，不发送任何请求。
- **重放不受影响**：同键同输入仍返回原任务，额度后来用完也一样；同键不同输入仍返回 409。
- **预检不预留额度**：每次发送仍由 `reserveCall` 在 workspace 调用锁下逐次原子预约。如果别人中途用掉额度，任务以 `partial / TITLE_WRITING_DAILY_CAP` 停下，已完成的结果保留。
- **锁顺序**：预检只读，不加调用锁，原有顺序「run 锁 → run 行」不变。PostgreSQL 验收中有一项专门证明：另一个会话持有调用锁时，启动不会被阻塞。
- **v1 保持原行为（本轮独立审查修复）**：已移除对 v1 新任务的 N+2 启动预检。v1 仍可创建任务，再逐次原子预约；额度不足时按原规则停止并保留结果。历史任务、重放和续跑不变。

### 3.5 未知结果、取消、迟到结果、续跑

规则不变：未知结果不自动重发；续跑必须确认当前的不确定调用；迟到结果不能覆盖恢复结果；取消后不再开始新步骤；历史调用记录不清零。新增测试在 6 集任务上逐项复现了这些规则（见第 5 节）。

### 3.6 Worker 消费协议

**改动内容**
- Mock 场景和镜头的批次契约（`packages/contracts/src/index.ts`）从「固定 3 项、集号 1–3」放宽为「1–6 项、集号 1–6」。
- `packages/database/src/mock-text.ts` 改为校验批次恰好等于作品的 1..N。

**兼容范围**
- 新代码可以处理旧的 3 集批次。
- 旧 Worker 收到 N≠3 的批次会以 `VALIDATION_ERROR` 拒绝。这只影响 Mock 任务，不涉及付费调用，也不写入数据。

**发布要求**
- API 和 Worker 必须同时更新到本分支代码。
- 这与以前「仅 Web 部署」的结论不同。

导出相关的集号上限（`packages/domain/src/episode-export.ts`）已从 3 放宽到 6。

## 4. Migration

### 已编写（只在 CI 一次性库中执行过，见下方「执行范围」）

`packages/database/prisma/migrations/20261011000100_episode_plan/migration.sql` 只扩展、不删除：

- **project 表**
  - 新增 `episode_count smallint NOT NULL DEFAULT 3`；
  - 新增 `target_episode_seconds smallint`（可为 NULL）；
  - 三个约束：集数为 1–6；秒数为 NULL、60 或 90；没有目标时长的作品必须是 3 集。
- **episode 表**：`episode_episode_no_check` 从 1–3 放宽到 1–6。
- **title_writing_step 表**
  - `step_key` 允许 episode:1..6；
  - `ordinal` 从 0–4 放宽到 0–7。
- **未修改 `call_cap`**：现有约束 `call_cap` 为 1–50，N+5 最多是 11，已核对，不需要改。
- **数据影响**
  - 不写入、不改写、不删除任何行；
  - 历史作品自动得到 3 集和 NULL 目标时长；
  - 历史分集、任务、步骤、调用和 input_hash 都不变。
- **已发布的迁移未改动**：已发布迁移的校验和清单中补上了 `20261008000100_title_writing` 的校验和（`b3931d04…`）。测试证明所有已发布迁移逐字节不变。
- **Prisma schema** 已同步，`prisma validate` 通过。

### 锁影响

- 对 project、episode、title_writing_step 加 ACCESS EXCLUSIVE 锁，持续到这次迁移的事务结束。
- 新 CHECK 会各扫描一次这三张表。
- 加列使用常量默认值，PostgreSQL 11 起只改元数据。
- 表很小，但建议在低峰期执行。

### 升级顺序

1. 用现有部署命令 `pnpm --filter @ai-drama/database migrate` 执行迁移。只会应用这一个迁移，再执行一次应用 0 个。
2. 同时发布 API 和 Worker。
3. 发布 Web。

**新协议的启用检查**
- 依据是 `schema_migration` 中有这条迁移记录，并且两个新列都存在（`packages/database/src/episode-plan.ts` `episodePlanReadyIn`）。
- 只有「四张标题表存在」不算就绪。

**迁移缺失时**
- 带规格的作品无法创建，返回 503，不写入；
- v2 启动返回 503 `TITLE_WRITING_EPISODE_PLAN_UNAVAILABLE`，不发送；
- 新开始页显示「集数和时长设置还没有在服务器上就绪」，不发送请求；
- 旧版页面保存的待确认请求和所有无规格作品，仍按 v1 原样工作。

### 旧版本兼容与代码回退

- 新列及放宽的 CHECK 可以保留，但**数据库结构能被旧代码读取，不代表旧应用可以安全继续写入**。旧代码忽略项目规格，固定使用三集；不能承诺 1/2/4–6 集作品、v2 任务及其页面在旧版本下正常工作。
- **没有 running v2 也不足以安全回退。** 旧 API 的续跑接口仍会接受处于 partial、needs_attention 或 canceled 状态的 v2 任务，再用旧三集提示词驱动；旧启动接口也可能在带规格的作品上建立三集任务。这些路径会产生与作品规格不符的调用。
- **关闭标题创作不是全站写保护。** `TITLE_WRITING_ENABLED=false` 可以阻止标题任务启动、续跑和自动驱动，但不会关闭旧版故事审核建集、剧本写入或 Mock 场景/镜头任务。旧版故事审核会补建 1–3 集，旧 Worker 只接受三集批次；因此新 1/2/4–6 集数据仍可能被写错、拒绝或错误处理。
- 只要数据库已有带规格作品或 v2 数据，**不得回退旧 API/Worker 后继续开放业务写入**。首选保持本版并 forward-fix；必须退回旧进程时，仅限维护隔离，不作为恢复业务的完成状态：
  1. 关闭标题创作，停止接收业务写请求，并核验实际进程环境和 options；不能用“当前无 running 任务”代替关闭开关。
  2. 停止 API 和 Worker 等写入执行者，确认在途任务已经停止；不删除队列、任务或历史记录。
  3. 保持维护页和写入隔离。不要把旧 API 接回公开业务入口、不要启动旧 Worker 消费新批次；本仓库没有已验收的维护只读模式，不能仅凭界面隐藏按钮声称只读。
  4. 待兼容当前项目规格和任务版本的代码恢复并验收后，再按发布顺序恢复 API、Worker、Web 和业务写入。是否重新开启标题创作按原授权单独决定。
- 不执行向下迁移，不删除数据；也不以清空新作品或任务作为回退手段。

### 执行范围

- **CI 一次性库**：在 PR #65 的 GitHub Actions 作业中执行过，库是作业专属的 PostgreSQL 16 服务容器中新建的空库，作业结束后随容器销毁。结果见第 8 节。
- **服务器、生产库、已有开发库**：都没有执行。
- **本机**：没有建库，也没有执行任何 SQL。

## 5. 测试

本机已执行（Node 24.21.0）：

| 检查 | 结果（退出码） |
|---|---|
| `pnpm lint`（9 个包） | 0 |
| `pnpm typecheck`（14 项任务） | 0 |
| `pnpm test`（全部单元测试和组件测试） | 0：contracts 41、domain 104、database 58、providers 118（最终复跑）、worker 68、api 179 通过、43 跳过（需要 PostgreSQL）、web 485、health 7、comfyui-adapter 4 |
| `pnpm build` | 0 |
| `prisma validate`（使用不连接任何服务的占位 URL） | 0 |
| `git diff --check` | 0 |
| 浏览器检查（见下文） | 32/32 通过，0 |

### 新增和补齐的覆盖

- **契约**（`title-writing-episodes.spec.ts`）
  - N=1/3/6 的步骤数、正常调用数、上限，以及 JSON Schema 中的 N；
  - 非法 N（0、7、2.5）；
  - v1 设置（30–180 秒，固定 3 集）；
  - 续跑确认最多 8 个；
  - 分集草稿编号 1–6。
- **领域**（`title-writing-episodes.spec.ts`）
  - v1 提示词和 Schema 的哈希固定；v1 不接受第 4 集；
  - v2 提示词包含 N 和「写作目标」，最后一集有收束提示；
  - 大纲缺集、多集、重复、乱序、使用 v1 schema 时均拒绝；分集编号错误时拒绝；
  - 分集集合 1..N 的校验。
- **引擎**（`providers/title-writing-episodes.spec.ts`）
  - v2 冻结输入、N+2 个步骤、上限 N+5；
  - 第 4 集的迟到结果不能覆盖恢复结果，后续步骤不发送，维护时也不自动重发。
- **API**（`apps/api/src/studio/title-writing.episode-plan.spec.ts`，29 项）
  - N=1/3/6：完整流程、按集写入、重复写入不重复建版本；
  - 规格不一致返回 409，发送 0 次；
  - 迁移缺失返回 503，发送 0 次；
  - v1 的 30/90/120/180 秒：输入、哈希、五个步骤、上限 8，提示词仍是 v1 文本；
  - v1 设置非 3 集时返回 400；
  - 额度不足时 run、step、发送都为 0；正好剩 N+2 次时可以启动；
  - 同键在额度用完后重放仍返回原任务，同键不同输入仍冲突；
  - 中途额度被别人用掉时以 partial 停下并保留结果；
  - 大纲缺集、多集、重复、乱序、v1 schema、非 JSON、截断时，分集请求为 0；
  - 错集号；
  - 故事超长在第一集之前停下，只用了 2 次调用；
  - 第 5 集结果不确定：确认后只重发这一集，历史调用保留；
  - 取消后发送 0 次；
  - 写入时规格不一致，一个字都不写；
  - 某集已有人写的剧本时报冲突，原文保留。
- **Web**
  - 开始页：
    - 集数和时长选项；
    - 调用次数说明随 N 变化；
    - 待确认请求恢复后原样重放（v3 新格式和旧版 v2 记录各一组，旧记录的 180 秒请求逐字节重放，两个请求标识都不变）；
    - 「作品已建、任务未建、没有发送」的错误提示；
    - 迁移未就绪时不发送。
  - 进度页：6 集任务的规格行、已生成和已写入分开计数、第 6 集的编辑链接。
  - 新手步骤：按 N 判断完成状态。

### 浏览器检查

- 环境：真实 Chromium 140 + 本机生产构建的 Next。
- 1440px 和 390px 两种宽度都检查了：
  - 开始页选择 6 集和约 1 分钟；
  - 写请求被拒后的提示；
  - 6 集任务的进度页。
- 两种宽度都没有横向溢出，也没有页面脚本错误。390px 下两个下拉框改为上下排列。
- **这是替身环境，不是 API、数据库或供应商的验收**：
  - 浏览器中所有 `/api/v1` 请求都由脚本的路由夹具应答，写请求也由夹具应答并记录，不会转发；
  - Next 服务端的登录检查由本机一个只返回「登录已关闭」的桩应答。
- 截图和 JSON 证据都在会话临时目录中，未放进仓库。

### PostgreSQL 和 API 验收

以下验收不在本机运行，由 PR #65 的 CI 在一次性库中执行。最终结果见第 8 节：


- `packages/database/src/episode-plan.acceptance.spec.ts`：
  - 命令：`pnpm --filter @ai-drama/database episode-plan:acceptance`；
  - 复用 title writing 验收的防护：三个变量都必须给出，库名必须是一次性库，并且要求是空库，否则直接拒绝。
  - 覆盖：
    - 从当前已发布链升级，历史数据和 v1 任务保留（行摘要对比）；
    - 迁移前带规格的作品被拒，6 集任务无法写入（CHECK 23514），run 和 call 都为 0；
    - 升级只应用这一个迁移，重复执行应用 0 个；
    - N=1/3/6 审核建集、写入、重复写入；
    - 冲突不覆盖；规格不一致时不写入；
    - 额度预检与重放；
    - 持有调用锁时启动不阻塞；
    - 5 个会话用同一个键启动，只建一个任务；
    - 4 个会话争最后一次调用，只成功一次。
- `apps/api/src/studio/title-writing.acceptance.spec.ts` 新增 N=1/3/6 的 HTTP 场景：
  - 带规格建作品；规格不一致返回 409；
  - v2 完成后共 N+2 次请求；
  - 审核后得到 N 集，写入 N 份剧本；
  - 在编辑器中修改最后一集，产生第二个版本。
- 现有的三份 title writing 验收（store、API、runtime）、browser 验收和 CI 中 deploy 步骤的预期迁移数（6 改为 7），都已更新为把新迁移计入迁移链。
- CI 工作流 `.github/workflows/title-writing-acceptance.yml` 的 store job 增加了「episode plan acceptance」这一步，每次运行新建一个一次性库，库名以 `ads_title_acceptance_plan_` 开头。
- 第 8 节记录了这些验收在 CI 中的实际运行结果，包括失败的轮次。

## 6. 遗留问题与需要审查的高风险点

1. **v1 启动兼容已恢复**（见 3.4）：本轮独立审查将 N+2 启动预检限制为 v2，v1 继续逐次预约，不再要求接受原先的行为收紧。
2. **旧代码回退不兼容带规格作品和 v2 任务**（见第 4 节）：没有 running 任务仍可能通过旧续跑/启动入口误发请求；只关闭标题功能也不能保护旧故事审核与 Mock 写入。已有此类数据时优先 forward-fix，必须回退则保持维护隔离，不开放旧 API/Worker 业务写入。
3. **API、Worker 与迁移的发布顺序**（见 3.6 和第 4 节）：
   - 旧 Worker 会拒绝 N≠3 的 Mock 批次；
   - 新代码在迁移前可以运行，但带规格的功能保持关闭。
4. **约束名依赖 PostgreSQL 的默认命名**（`episode_episode_no_check`、`title_writing_step_step_key_check`、`title_writing_step_ordinal_check`）：
   - 如果某个服务器上的约束名不同，迁移会整体回滚，不留下半成品；
   - 在 CI 的 PostgreSQL 16 一次性库中，从当前已发布迁移链升级时，这些约束名都存在，迁移成功。生产服务器上的约束名没有核对。
5. **只用替身验证过**：4096 token 输出上限下，6 集大纲的真实生成质量和截断率都没有验证。真实模型调用需要另行授权。
6. **写作助手**（与标题创作无关的另一功能）仍限 1–3 集：
   - 故事方案固定 3 集，分集提示词只接受第 1–3 集；
   - 本轮独立审查已补齐 UI 边界：非三集作品不展示故事编剧助手，第 4–6 集不展示分集编剧助手，并说明仍可手动修改、保存新版本。工作台和新手流程共用此限制；旧三集故事与第 1–3 集的助手保留。
   - 分集导入格式已放宽到 1–6，但旧编剧助手的第 4–6 集生成/导入没有做端到端验证，也没有因此启用这些入口。
7. **目标时长只用于写作**：控制剧本字数和提示词，不检查、也不保证成片时长。整集合成上限仍是 90 秒。
8. **项目读取多了查询**：`GET /projects/:id` 和审核建集时都会额外查询 information_schema 和规格。

## 7. 实际状态

| 动作 | 状态 |
|---|---|
| commit | 是，5 个提交，加上本报告更新共 6 个，见第 8 节 |
| push | 是，普通推送到 `feat/variable-episode-writing`，未强推 |
| 创建 PR | 是，Draft PR #65 |
| 转 Ready 或合并 PR | NO |
| pack 或部署 | NO |
| 执行 Migration 或 SQL | 只在 CI 一次性库中执行；服务器和已有数据库都没有执行 |
| 修改服务器配置或生产数据 | NO |
| 启用标题创作 | NO |
| 真实模型调用 | 0 |

## 8. 提交、推送、Draft PR 与 CI（2026-10-11）

### 分支与 PR

- 分支：`feat/variable-episode-writing`，上游为 `origin/feat/variable-episode-writing`。推送前远端没有这个分支。
- 开发基线：`722224891ae8d7e3cc9df1de9653170401de2573`。推送前核对过 `origin/main`，没有前移。
- Draft PR：https://github.com/xyq-dev/ai-drama-studio/pull/65（base `main`）。
- CI 的 `pull_request` 事件检出的是 GitHub 生成的合并提交，与分支 HEAD 不是同一个提交：

  | 提交 | SHA |
  |---|---|
  | 已验证的源码 HEAD（第 5 个提交） | `7ba4ea11b63ab76b3c65ac170876e8b06d9ef139` |
  | 对应的 PR 合并提交 | `5464ed3ad1710b54ea37f193ba277c35b60218d8` |

### 提交

| 提交 | 内容 |
|---|---|
| `d11f3e4` | feat(title-writing)：集数规格、v2 任务、迁移、后端测试和验收 |
| `f905a9d` | feat(web)：开始页、进度页、工作台和新手流程按 N 显示 |
| `8574e75` | docs：本报告初版 |
| `7ddd993` | test：按新规格调整 m2 集成测试和浏览器验收（CI 第 1 轮暴露） |
| `7ba4ea1` | fix(database)：数据库不可达时，规格就绪检查返回「未就绪」而不是报错（CI 第 2 轮暴露），并补了回归测试 |

本报告的更新会作为下一个文档提交推送。所有推送都是普通推送。

### CI 运行记录（全部由 pull_request 事件触发，没有手动重跑）

**第 1 轮，HEAD `8574e75`**：12 个工作流，6 个失败。

- **M1-C、M2-A、M2-C、M3-A、M3-B 集成**：同一个测试失败。该测试断言第 4 集会被数据库拒绝，而本 PR 的迁移有意把范围放宽到 1–6。
  - 修复：把拒绝边界改成第 7 集。
  - 同时增加断言：没有规格的作品审核后仍恰好是 1..3 集，多出第 4 集时集合校验失败。断言没有放宽。
- **Title writing 的浏览器验收**：A、B、C 三个场景失败，任务停在「部分完成」。
  - 原因：页面现在建作品时带默认规格（3 集、90 秒），任务是 v2；但浏览器验收里的模型替身仍返回 v1 大纲，被 v2 校验拒绝。
  - 修复：替身改为按提示词返回 N 集 v2 大纲，进度标题的预期文字更新为「（共 3 集）」。
  - 同时增加断言：作品规格是 3 集 90 秒，任务是 v2、3 集、上限 8 次。
- 同一轮通过的项：store 验收 30/30（其中 episode-plan 验收 14/14），API 验收 13/13，runtime 验收 5/5。

**第 2 轮，HEAD `7ddd993`**：Title writing 验收的 4 个作业全部通过；5 个集成工作流在「Verify workspace」步骤失败。

- 原因：只在 Linux 上运行的 `apps/api/src/admin/admin-runtime.spec.ts` 禁止连接数据库。新加的规格就绪检查中，`pool.connect()` 写在 try 外面，数据库不可达时 options 接口直接报错，而不是返回「未就绪」。这是本 PR 引入的真实缺陷；本机是 Windows，这个测试被跳过，所以本地没发现。
- 修复：把 `connect()` 移进 try。新增 `packages/database/src/episode-plan.spec.ts`，覆盖数据库不可达、查询失败、迁移记录或列缺失、只缓存「已就绪」结果，这些测试在 Windows 上也会运行。

**第 3 轮，HEAD `7ba4ea1`**：12 个工作流全部通过。

| 工作流 | 运行 ID | 结论 |
|---|---|---|
| Title writing isolated acceptance | 38108953304 | success |
| M1-C integration | 38108953305 | success |
| M2-A integration | 38108953317 | success |
| M2-C integration | 38108953300 | success |
| M3-A integration | 38108953310 | success |
| M3-B integration | 38108953302 | success |
| M4 three episode sample end-to-end | 38108953299 | success |
| Writing assistant API | 38108953320 | success |
| Beginner creator web | 38108953306 | success |
| Creator UI checks | 38108953315 | success |
| Admin model settings | 38108953301 | success |
| Unified site login | 38108953330 | success |

第 3 轮 Title writing isolated acceptance 中各项的实际结果：

| 作业 | 测试环境 | 结果 |
|---|---|---|
| PostgreSQL store acceptance | 真实 PostgreSQL 16，作业专属一次性空库 | store 验收 30/30；episode-plan 验收 14/14 |
| 同作业：deploy 迁移命令 | 另建一个新库 | 第一次应用 7 个迁移，第二次应用 0 个；在已升级的验收库上再执行也是 0 个 |
| Real API acceptance | 真实 Nest HTTP API + 真实 PostgreSQL + **模型替身** | 13/13，其中包括新增的 N=1/3/6 场景 |
| Real browser acceptance | 真实 Chrome + 真实 Web + 真实 API + 真实 PostgreSQL + **模型替身** | 4/4（场景 A、B、C 全部恢复通过，没有删减） |
| Real runtime and crash recovery acceptance | 构建后的 API 进程 + 真实 PostgreSQL + **模型替身**，供应商主机名指向本机 | 5/5 |

episode-plan 验收的 14 项包括：
- 迁移前带规格的作品被拒，v2 任务无法写入，run 和 call 都为 0；
- 升级只应用一个迁移，重复执行应用 0 个；历史行（除新列外）逐表摘要不变；
- v1 任务的输入、哈希、五个步骤和上限 8 不变；
- N=1/3/6 审核建集、写入、重复写入；冲突不覆盖；规格不一致时不写入；
- 额度不足拒绝新任务、同键重放仍返回原任务；
- 持有调用锁时启动不阻塞；5 个会话同键启动只建一个任务；4 个会话争最后一次调用，只成功一次。

### 各类证据的边界

| 类别 | 内容 |
|---|---|
| 本地模拟测试 | 内存存储 + 模型替身的单元和组件测试（Windows、Node 24.21.0） |
| 真实 PostgreSQL | 只有 CI 一次性库中的 store、episode-plan、集成和 deploy 迁移步骤 |
| 真实 HTTP API + 模型替身 | CI 中的 API、browser、runtime 验收 |
| 浏览器 | CI 浏览器验收使用真实 API；本机 1440/390 检查使用路由替身，不是 API 验收 |
| 真实供应商调用 | 未执行 |
| 服务器 | 没有执行迁移，没有部署 |
