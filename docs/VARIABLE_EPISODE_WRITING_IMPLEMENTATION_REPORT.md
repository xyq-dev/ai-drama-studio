# R1 实施报告：可选集数、每集目标时长与对应集数的 AI 文字创作

日期：2026-10-11

本轮状态：
- 只做了实现、测试和本报告。没有 commit、push、PR、合并、打包或部署。
- 没有执行新 Migration 或任何 SQL，没有建库，也没有调用任何真实模型。

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
- **新任务启动时**，在幂等键查询之后检查最近 24 小时的剩余次数；少于 N+2 时返回 429 `TITLE_WRITING_DAILY_QUOTA_LOW`（附需要次数和剩余次数），不创建 run 和 step，不发送任何请求。
- **重放不受影响**：同键同输入仍返回原任务，额度后来用完也一样；同键不同输入仍返回 409。
- **预检不预留额度**：每次发送仍由 `reserveCall` 在 workspace 调用锁下逐次原子预约。如果别人中途用掉额度，任务以 `partial / TITLE_WRITING_DAILY_CAP` 停下，已完成的结果保留。
- **锁顺序**：预检只读，不加调用锁，原有顺序「run 锁 → run 行」不变。PostgreSQL 验收中有一项专门证明：另一个会话持有调用锁时，启动不会被阻塞。
- **对 v1 的行为变化（需审查确认）**：预检同样作用于新建的 v1 任务。剩余次数少于 5 时，以前会先发出几次请求再以 partial 停下，现在直接拒绝、一次都不发。已存在的 v1 任务、重放和续跑都不受影响。

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

### 已编写，未执行

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

- 迁移后回退到旧代码：
  - 旧代码忽略新列；
  - 新建的项目得到默认值 3 和 NULL；
  - 旧代码不会写出旧范围之外的值。
- 已建立的 4–6 集分集和 v2 任务在旧代码下：
  - 读取不受影响；
  - 旧代码只认三集，无法写入这些任务的第 4–6 集剧本。
- **旧代码不认识 v2 输入。** 回退时如果还有处于 running 状态的 v2 任务，旧代码的维护循环会接管它，并用 v1 的三集提示词继续发送。这可能产生与规格不符的付费请求。因此代码回退前必须先：
  1. 关闭标题创作（`TITLE_WRITING_ENABLED=false`），或确认没有 running 状态的 v2 任务；
  2. 停止 API；
  3. 再回退代码。
- 不执行向下迁移，不删除数据，按 forward-fix 处理。

### 已执行

无。没有在任何数据库执行这个迁移，也没有自建数据库做试验。

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

### 已编写、未执行的 PostgreSQL 和 API 验收

本轮没有获得隔离数据库的执行授权，所以以下验收都**没有运行**，只确认了能通过 tsc 类型检查和 lint：

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
- 以上 CI 都需要 push 后才会运行，本轮没有运行过，也不能把它们算作 PostgreSQL 证据。

## 6. 遗留问题与需要审查的高风险点

1. **v1 新任务的额度预检**（见 3.4）：这是对现有 v1 启动行为的收紧，需要确认是否接受。
2. **代码回退会发送与规格不符的付费请求**（见第 4 节）：旧代码会用 v1 提示词续跑 running 状态的 v2 任务。回退步骤中必须先关闭功能或确认没有运行中的 v2 任务。
3. **API、Worker 与迁移的发布顺序**（见 3.6 和第 4 节）：
   - 旧 Worker 会拒绝 N≠3 的 Mock 批次；
   - 新代码在迁移前可以运行，但带规格的功能保持关闭。
4. **约束名依赖 PostgreSQL 的默认命名**（`episode_episode_no_check`、`title_writing_step_step_key_check`、`title_writing_step_ordinal_check`）：
   - 如果某个服务器上的约束名不同，迁移会整体回滚，不留下半成品；
   - 这一点要以 PostgreSQL 验收结果为准，目前未执行。
5. **只用替身验证过**：4096 token 输出上限下，6 集大纲的真实生成质量和截断率都没有验证。真实模型调用需要另行授权。
6. **写作助手**（与标题创作无关的另一功能）仍限 1–3 集：
   - 故事方案固定 3 集，分集提示词只接受第 1–3 集；
   - 4–6 集作品的第 4–6 集不能用写作助手生成。分集导入格式已放宽到 1–6，但没有做端到端验证。
7. **目标时长只用于写作**：控制剧本字数和提示词，不检查、也不保证成片时长。整集合成上限仍是 90 秒。
8. **项目读取多了查询**：`GET /projects/:id` 和审核建集时都会额外查询 information_schema 和规格。

## 7. 实际状态

| 动作 | 状态 |
|---|---|
| commit | NO |
| push | NO |
| 创建或合并 PR | NO |
| pack 或部署 | NO |
| 执行 Migration 或 SQL | NO |
| 修改服务器配置或生产数据 | NO |
| 启用标题创作 | NO |
| 真实模型调用 | 0 |
