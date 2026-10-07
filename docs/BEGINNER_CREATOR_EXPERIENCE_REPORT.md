# BEGINNER_CREATOR_EXPERIENCE_REPORT

新手创作体验（红果创作）交付报告。本轮完成的是新手界面与其接线，不是真实 AI 全流程，也不是商业运营验收。

## 现场

| 项目 | 值 |
| --- | --- |
| 目录 | `D:\Projects\ai-drama-studio-beginner-ui`（独立 worktree，新建） |
| 主工作区 | `D:\Projects\ai-drama-studio` 仍在 `fix/v1-reliability-closeout`，未混改；其 `m3-av-e2e-output-ci/` 未跟踪目录原样保留 |
| 分支 | `feat/beginner-creator-experience`（新建） |
| 起点 | fetch 后的 `origin/main` = `2fb19acfe086392eb415a3be92b4c4a6830a4cfd` |
| 远端 | `origin` = `https://github.com/xyq-dev/ai-drama-studio.git`；功能分支普通推送，本地与远端 HEAD 一致 |
| 最终 SHA | 见 PR #50 当前 HEAD（本报告所在提交） |
| PR | https://github.com/xyq-dev/ai-drama-studio/pull/50 |
| AGENTS.md / CLAUDE.md | 仓库中不存在 |

前序任务：上一轮可靠性修复 PR #49 在本轮开始前已推送；本轮期间其最终 HEAD `89415cd` 的 7 个 CI 全部通过并已标记为可审查，未合并。

**设计图：** 任务说明中的两张新手版设计图没有随会话提供，本机也没有找到。视觉按文字规范实现，没有逐图对照。

## 实现概览

设计与页面—能力映射见 [`BEGINNER_CREATOR_EXPERIENCE_DESIGN.md`](BEGINNER_CREATOR_EXPERIENCE_DESIGN.md)。

- 共享：工作台的项目数据读取、迟到响应丢弃、任务轮询（单资源串行、隐藏暂停、返回重读）提取为 `useProjectBase`；工作台改用它，原 58 个工作台测试全部通过。原有故事、剧本、角色/场地、场景/镜头、任务面板只加了 `export`。
- 新页面：`/`、`/create`（开始创作）、`/studio`（我的作品）、`/help`、`/projects/[id]/create`（五步流程）。工作台页头加「我的作品」「新手模式」。
- 主题：`.beginner` 作用域重映射共享色板，嵌入的原组件随之变为浅色。

## 页面与五步逐项

| 项 | 实现 | 真实性边界 |
| --- | --- | --- |
| 开始创作 | 标题、说明、创意输入、「开始构思」、「还没想法？看看灵感」、三集竖屏试制说明、「继续上次创作」、标注为示例的静态模板、按规则截取的建议名称（注明不是 AI 生成）、灵感中心方向（`?direction=1`） | 浏览、输入、选模板不创建；只有「确认创建作品」提交 |
| 我的作品 | 卡片：名称、文字封面、当前阶段（第 N 步 + 状态符号与文字）、待处理事项、继续创作、高级编辑；读取失败给重试，不显示示例作品 | 进度只来自接口；无封面资产接口，一律文字封面 |
| 1 定故事 | 原故事编辑器 + 编剧助手（准备要求、导入、预览、比较、采纳到草稿）+ 保存新版本 + 版本栏审核；站内千问按原状态显示，不自动填令牌 | 候选来源仍为用户输入、外部 AI 导入或已配置的站内接口 |
| 2 看剧本 | 1/2/3 集标签显示各集真实状态；原剧本编辑与审核；说明审核只针对当前展示的这一集这一版、剧本描述不等于场景/镜头记录 | 不批量批准 |
| 3 定人物 | 角色/场地标签（已确认数/总数）；原角色/场地编辑与审核；角色参考图沿用原面板（草案未执行时显示待配置）；画风只提示写入描述 | 不开启 strict，不保存画风字段 |
| 4 试一段 | 剧集选择；场景列表；原场景/镜头面板（素材生成、单镜预检与合成、成片审核）；无场景时引导到任务面板（Mock 生成场景/镜头）或高级编辑；演示素材、约 1 秒、时长提示不等于实际时长、自然语言修改不会自动执行的说明；合成未开启时明确提示 | 真实浏览器闭环已执行（见 E2E 章节） |
| 5 出成片 | 原多镜编排（加入/上移/下移/移除、总时长、预检、提交、任务、审核、MP4 与来源清单下载、历史成片）；2–30 个镜头说明；费用面板 | 真实浏览器闭环已执行（见 E2E 章节） |
| 稍后继续 / 高级编辑 | 有未保存修改时说明草稿只在本标签页；高级编辑链接到同一内容的工作台 focus | — |
| 保存状态 | 「服务器已保存」「正在保存」「有未保存修改（本标签页草稿）」及冲突/失败说明，由原编辑器状态映射 | 不承诺跨浏览器恢复 |

### 每个主按钮实际调用

| 按钮 | 调用 |
| --- | --- |
| 开始构思 | 无请求，展开确认区 |
| 确认创建作品 | `POST /api/v1/projects` `{title, premise}`，`Idempotency-Key` 取自本标签页草稿；失败与不确定结果保留输入与原键 |
| 继续创作（卡片） | 跳转 `/projects/[id]/create` |
| 步骤主按钮（写下故事并保存 / 补齐剧本并保存 / 添加角色 / 查看原因并修改） | 无请求：滚动并聚焦到原编辑器 |
| 检查并确认当前版本 / 播放并检查 / 查看变化并重新确认 | 无请求：滚动并聚焦到原版本栏审核区或成片审核区；审核由用户在原按钮上完成（原审核接口、If-Match、幂等键） |
| 查看任务进度 / 打开任务面板 | 打开原任务面板（只读任务；其中的取消、符合规则的重试走原接口） |
| 选一个镜头试做 | 无请求：定位到场景选择区 |
| 继续下一步 | 无请求：切换步骤（仅在服务器状态为已完成时出现） |

### 持久化与草稿

- 服务器持久化：作品（标题、梗概）、故事/剧本/角色/场地/场景/镜头修订与审核、任务、资产、成片审核——全部通过原接口。
- 本标签页草稿（sessionStorage）：新建作品输入与幂等键、各编辑器原有草稿。
- 仅本浏览器（localStorage）：灵感中心创作方向（原有行为）。
- 不持久化：当前步骤（只在 URL `?step=`）、示例模板、建议名称、画风提示。

## 真实可用 / 演示可用 / 待接入

- **真实可用（本轮在 CI 真实 API + PostgreSQL + Chromium 中走通）：** 首页输入与灵感入口；网页创建作品及网络中断后同键重试；第 1 步候选导入、采纳、保存与审核；第 2 步第 1 集保存与审核；新手与高级编辑切换保留未保存草稿；刷新保留步骤；我的作品真实阶段；项目切换；390px 页面与错误状态。
- **演示可用：** 第 4、5 步的素材均为 Mock 演示素材；合成依赖 `M4_LOCAL_COMPOSE_ENABLED`，默认关闭时页面明确提示。
- **第 3–5 步（E2E 轮补齐）：** 已在 CI 真实 API + Worker + PostgreSQL + FFmpeg + Chrome 中经新手页面完成，见下方 E2E 章节。素材仍是 Mock 演示素材。
- **关闭态，不计为验收：** 角色参考图（依赖未执行的 SQL 草案）——页面显示不可用原因，不提供生成按钮；这只验证了关闭态，不是参考图功能验收。
- **待接入（无后端支持）：** 画风持久化、自然语言修改的执行、预算控制/报价、项目封面、场景标题列表、单集合成任务所属集。

## 测试

| 命令 / 作业 | 结果 | 性质 |
| --- | --- | --- |
| 新增定向测试：`beginner-steps.spec.ts`（9）、`beginner-start.spec.tsx`（8，含我的作品）、`beginner-flow.spec.tsx`（6）、`category-to-creation.spec.tsx` 新增 2 | 通过 | 单测 / 组件（happy-dom + 模拟 fetch，挂载真实原面板，不是真实页面） |
| 回归：`workbench.review.spec.tsx` 58、编剧助手、合成、导出下载、复用、重试等既有 web 测试 | 通过 | 组件 |
| `pnpm verify`（Node 24.21.0） | exit 0；web 188 通过，其余包全部通过 | 本机 |
| `pnpm m3-av-e2e:check` / `m3-av-e2e:outcome` | 通过 / 23 通过 | 本机 |
| `git diff --check` | 无输出 | — |
| 本机 Chromium（路由桩） | 1440、1280、390 四个页面无横向溢出 | Chromium + 模拟 API，仅布局 |
| CI「Beginner creator web」 | 见下表 | 真实 API + 真实 PostgreSQL（专用空库，只应用已有 migration）+ 真实 Chromium；一次网络中断用 `route.abort` 注入；第二个作品为通过 API 准备的测试数据，未计作网页操作 |

修改过的既有断言：`category-center.spec.tsx` 中「用这个方向新建作品」链接由 `/studio?direction=1` 改为 `/create?direction=1`（入口有意迁到新手开始页，同等严格度，并为新入口补了测试）。

首次失败记录：CI run 37571003128（及同提交 push run 37570975471）在「我的作品真实阶段」失败——合成未开启时 `compose-candidates` 返回 `CONFIGURATION_ERROR`，卡片误显示「进度读取失败」。属产品缺陷，已修（`b28c833`）：记录为合成未开启，第 4、5 步明确提示且不计完成；补了组件回归与验收断言。没有放宽断言。

截图（CI artifact `beginner-web-evidence`）：创作页 1440、第 1 步保存后 1440、我的作品 1440，以及 390px 的首页、我的作品、第 1/2/4/5 步、帮助、错误态。截图在 `networkidle` 后拍摄；整页截图里固定底栏出现在页面中部是整页截图的绘制方式，实际视口中位于底部，且验收断言底栏高度不超过正文底部留白。

## CI

代码提交 `b28c833` 的结果（9/9 success）：

| 工作流 | 结论 | Run |
| --- | --- | --- |
| Beginner creator web（pull_request） | success | [37571250475](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250475) |
| Beginner creator web（push） | success | [37571247807](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571247807) |
| Writing assistant API | success | [37571250493](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250493) |
| M1-C integration | success | [37571250510](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250510) |
| M2-A integration | success | [37571250451](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250451) |
| M2-C integration | success | [37571250447](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250447) |
| M3-A integration | success | [37571250501](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250501) |
| M3-B integration | success | [37571250469](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250469) |
| M4 three episode sample end-to-end | success | [37571250484](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37571250484) |

之前的 `b0df61e` 上 Beginner creator web 两次失败（见上文首次失败记录），其余 7 个通过。本报告的文档提交只改 `docs/`，其 CI 以 PR #50 当前 HEAD 为准。

## 后端与 Migration

- 后端：**无修改**。只使用既有只读接口（projects、stories、episodes、characters、locations、workflow-runs、scenes、compose-candidates、composites、cost-summary）。没有新增汇总接口。
- Migration：无；两份草案未修改、未执行。功能开关默认值未改。

## 状态

| 项目 | 状态 |
| --- | --- |
| Commit | YES |
| Push | YES（普通推送功能分支） |
| PR | #50，面向 main；CI 通过后标记可审查 |
| Review | 待独立 Review |
| Merge | NO |
| Deploy | NO |
| Paid calls | NO |
| Migration | NO |

## 剩余与下一步

1. 第 2、3 集未在新手 E2E 中走完（只验证第 1 集）；第 5 步因此整体保持「待补充」，这是真实状态。
2. 待接入能力需要后端设计：画风字段、自然语言修改、封面、场景标题、单集合成所属集、预算控制。
3. 嵌入的原组件仍有部分英文状态词和折叠的「高级 JSON」，后续可在不改业务逻辑的前提下统一措辞。
4. 合并前需要独立 Review。

## BEGINNER_CREATOR_EXPERIENCE_E2E_REPORT（第 3–5 步真实浏览器验收）

### 现场与 SHA

| 项目 | 值 |
| --- | --- |
| 目录 / 分支 | `D:\Projects\ai-drama-studio-beginner-ui`，`feat/beginner-creator-experience`（核验：origin 正确，HEAD 与远端一致，对应 PR #50） |
| 本轮起点 | `efad5b7f7c47d85854aaee5dff20eb196df91cfa`（上一轮报告 HEAD） |
| 验收 SHA | `5cda55b67a7b37c9c72fa5b00f3699adbc203fac`（全部 10 个必需阶段通过的代码与脚本） |
| 报告 SHA | 本报告所在提交（只改 `docs/`；与验收 SHA 的差异仅为文档） |
| PR | https://github.com/xyq-dev/ai-drama-studio/pull/50 |
| AGENTS.md / CLAUDE.md | 不存在 |

主工作区 `fix/v1-reliability-closeout` 未改动；另一条 PR #49 未合并。未 reset/clean/stash/force push。

### 隔离验收环境（复用既有机制）

- GitHub Actions 服务容器提供当次新建的 PostgreSQL 16（库名固定 `ai_drama_beginner_web`，脚本拒绝非空库或其他库名）与 Redis 7。
- 只执行仓库已有正式 migration（`runMigrations`），再用仓库既有命令 `workspace:provision`、`mock-media:provision`、`mock-av:provision` 初始化。未执行 SQL 草案，无新 Migration，不访问任何服务器库。
- 与 M4 E2E 相同的锁定工具链：`ffmpeg=7:6.1.1-3ubuntu5`、`fonts-dejavu-core=2.37-8`、Chrome for Testing（`channel: "chrome"`，用于 H.264 播放）。
- 启动真实 API、Worker（`apps/worker dist/main.js`，就绪检查 queue=ok）、Web（生产构建）。Mock 媒体与本地合成开关只设在这些子进程环境里；产品默认值未改。
- 先以「合成关闭」启动 API 验证关闭态，再以开启状态重启 API 完成后续步骤。
- Mock 对象与合成目录建在 `RUNNER_TEMP` 下的当次目录，结束后删除；API/Worker/Web 日志、截图、`evidence.json`、下载的 MP4 与来源清单作为 artifact 保留。
- 必需阶段：`environment`、`home-and-create`、`step1-story`、`step2-script`、`compose-off-state`、`step3-cast`、`step4-sample`、`step5-prep`、`step5-final`、`layout-390`。任何阶段不是 passed（包括 missing）都使作业失败。

### 修复内容

| 提交 | 内容 | 原因 |
| --- | --- | --- |
| `9ca0a53` | 验收脚本扩展到五步；workflow 加 FFmpeg 与 Chrome；新手步骤按钮补 `aria-label` | 390px 下步骤按钮的可访问名称缺少标题（文字被隐藏），键盘/读屏用户无法分辨步骤；已加组件断言 |
| `457dbbf` | 用对应 Mock 开关运行 provision 命令 | 首次运行 37586040547 在 `mock-media:provision` 失败：`M3_MOCK_IMAGE_ENABLED=true is required` |
| `5cda55b` | 参考图关闭态检查限定在「角色参考图」面板内 | 运行 37587538176：定人物说明文字中也出现同一短语，未限定的文本匹配有两个结果 |

两次失败都分析了当次日志后修改；没有放宽断言或重跑碰绿。没有后端修改，没有 Migration。

### 五步逐项（全部由浏览器在新手路线完成，除标注为准备的部分）

| 步骤 | 浏览器操作 | 实际结果与证据 |
| --- | --- | --- |
| 开始创作 | `/create` 选示例、开始构思、命名、确认创建；第一次 POST 被 `route.abort` 断开后重试 | 只创建 1 个作品，两次请求同一幂等键 |
| 1 定故事 | 编剧助手导入手写候选、采纳、保存新版本、提交审核、通过 | 服务器故事为 APPROVED |
| 2 看剧本 | 第 1 集导入候选并采纳 → 打开高级编辑确认草稿仍在（不在高级页保存）→ 回新手模式 → 保存、审核通过；用场景表单新建场景 | 第 1 集「✓ 已完成」，其他集未被改动；场景 1 个 |
| 合成关闭态 | 合成开关关闭时打开试一段、我的作品 | 显示「当前环境没有开启本地合成」，不提供继续下一步，我的作品仍显示「第 2 步 看剧本」 |
| 3 定人物 | 新建两名角色；切换对象后编辑器显示所选对象；编辑一名角色（状态先为「有未保存修改」，保存带 If-Match 后为「服务器已保存」），刷新后重新读取到新文本；两名角色提交审核并通过；新建场地并带备注退回；进入下一步再返回 | 角色「2/2 已确认」，场地 REJECTED、「0/1 已确认」，步骤显示「！ 需要处理」；参考图面板显示「参考图存储尚未启用」且无生成按钮（关闭态，不计为参考图验收） |
| 4 试一段 | 选场景、审核通过场景、新建镜头、审核通过镜头、点「生成 Mock 视频」（202 受理后 Worker 完成）、在单镜预检中选视频、预检、开始合成（Worker 真实 FFmpeg）、播放、批准成片 | 视频任务与合成任务 SUCCEEDED；成片 1080×1920、1 秒，浏览器从同源 `/api/v1/assets/<id>/content` 读取，readyState 4，播放进度超过 0.2 秒；审核后 APPROVED 且审核哈希等于字节哈希；刷新后第 1 集「✓ 已完成」 |
| 5 准备 | **API 准备（非页面操作）**：第 2 个镜头创建并审核、生成 Mock 视频、单镜预检与合成、批准成片 | 同一项目同一集第二个已批准单镜成片 |
| 5 出成片 | 多镜编排加入两份成片、把第 2 份上移、预检编排、开始多镜合成（Worker FFmpeg）、播放、批准成片、下载 MP4 与来源清单 | 批准前没有下载按钮，导出接口返回 400；成片 2 秒 H.264 1080×1920 + AAC；下载 SHA-256 `eaa79f53…e9662` = 资产记录哈希 = 审核哈希 = 来源清单哈希，字节数一致；来源清单顺序 [第 2 份, 第 1 份] 与上移后的预检顺序一致；任务、attempt、资产属于同一作品，冻结输入含该集 ID；下载前后任务数与费用行数不变；刷新后第 1 集「✓ 已完成」 |
| 390px 与错误态 | 首页、我的作品、五步、帮助逐页检查；不存在的作品 | 横向溢出 0；底部主操作可见且不遮挡正文；错误态显示「作品读取失败」 |

本机另用 ffprobe 复核了 artifact 中的 `episode.mp4`：h264 1080×1920 + aac，时长 2.000000 秒，SHA-256 与证据一致。

### 准备数据与浏览器动作的划分

- 浏览器完成：作品创建、故事与第 1 集剧本的导入/采纳/保存/审核、场景创建与审核、角色与场地的创建/编辑/审核、镜头创建与审核、视频生成提交、单镜预检/合成/播放/审核、多镜编排/预检/合成/播放/审核、两种下载。
- API 准备（明确标注）：第 2 个单镜成片（镜头、审核、视频、预检、合成、批准）；作品切换检查之外不再有其他 API 写入。
- 只读 SQL：仅用于取任务产生的资产 ID 与核对哈希、归属、计数；没有直接写库。

### 测试分类

| 类型 | 内容 | 结果 |
| --- | --- | --- |
| 本机单元/组件（模拟 fetch，happy-dom） | `pnpm verify`：web 188（含新手 24 个与步骤按钮可访问名称断言）、其余包全部通过 | 通过（验收 SHA） |
| 本机脚本检查 | `pnpm m3-av-e2e:check`、`pnpm m3-av-e2e:outcome`（23）、`git diff --check` | 通过 |
| 真实 CI（API + Worker + PostgreSQL + FFmpeg + Chrome） | Beginner creator web，10 个必需阶段 | 通过，见下 |
| 真实模型调用 | 无 | 未执行，Paid calls=NO |

### CI（验收 SHA `5cda55b`）

9/9 success：

| 工作流 | Run | 结论 | 说明 |
| --- | --- | --- | --- |
| Beginner creator web（pull_request，job 112682059976） | [37587853541](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853541) | success | 10/10 必需阶段 passed；artifact 11467700880 |
| Beginner creator web（push） | [37587849882](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587849882) | success |  |
| M4 three episode sample end-to-end | [37587853511](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853511) | success | results.json 52/52 passed，missing/notPassed 为空；artifact 11468976777 |
| Writing assistant API | [37587853615](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853615) | success |  |
| M1-C integration | [37587853609](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853609) | success |  |
| M2-A integration | [37587853584](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853584) | success |  |
| M2-C integration | [37587853505](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853505) | success |  |
| M3-A integration | [37587853611](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853611) | success |  |
| M3-B integration | [37587853644](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37587853644) | success |  |

本轮首次失败记录：run 37586040547（environment：provision 缺少 Mock 开关）、run 37587538176（step3-cast：文本匹配有歧义），均在修复后由 `5cda55b` 通过。

Artifact `beginner-web-evidence`（id 11467700880，来自 Beginner creator web run 37587853541）：截图 `01-create-1440`、`02-step1-saved-1440`、`03-compose-off-studio-1440`、`04-step3-1440`、`05-step4-composed-1440`、`06-step5-composed-1440`、`10-home-390` 至 `17-help-390`（含五步各页）、`18-error-390`、`19-studio-final-1440`；`evidence.json`、`episode.mp4`、`episode-manifest.json`、`api.log`、`worker.log`、`web.log`。截图在 `networkidle` 与内容稳定后拍摄；整页截图中固定底栏出现在页面中部是整页截图的绘制方式。

### 剩余问题与未执行项

1. 角色参考图：依赖未执行草案，只验证了关闭态。
2. 只验收了第 1 集；第 2、3 集剧本与成片未在新手 E2E 中走完，第 5 步整体为「待补充」。
3. 嵌入的原组件仍显示对象 ID 片段（如「镜头 1465a619」）和部分英文状态词，未在本轮改写。
4. 素材均为 Mock 演示素材（约 1 秒），不是真实 AI 生成；无真实 Provider。
5. 画风、自然语言改镜头、封面、预算等无后端支持的能力仍未接入。

### 状态

Commit / Push：YES（普通推送到功能分支，PR #50 已更新）。Review：待 Codex 独立 Review。Merge：NO。Deploy：NO。Migration：NO。Paid calls：NO。

## BEGINNER_REVIEW_FIX_REPORT（PR #50 独立 Review 修复）

审查：https://github.com/xyq-dev/ai-drama-studio/pull/50#pullrequestreview-5440006199 及 23 条行内意见。

### 现场

| 项目 | 值 |
| --- | --- |
| 目录 / 分支 | `D:\Projects\ai-drama-studio-beginner-ui`，`feat/beginner-creator-experience`；开始时本地与远端 HEAD 均为 `52a1811`，无新提交，工作区干净 |
| 起点 | `52a181141a320b0389640428aba0617aabca22cd` |
| 修复提交 | `9e28a86` 后端只读字段、`9095827` 创建输入、`80ccdfc` 进度事实、`557d03f` 原地更新与按对象未保存、`7e4b7fa` E2E 加强 |
| 源码 SHA | `7e4b7fa40e866accd4e4d2646043e47747467616`（全部检查对应此 SHA，见下） |
| 报告 SHA | 本节所在提交，只改 `docs/` |
| AGENTS.md / CLAUDE.md | 不存在；已读 `docs/ENGINEERING_WORKFLOW.md` |

### 逐项

| # | 问题与原因 | 修复行为 | 回归 |
| --- | --- | --- | --- |
| 1 | 创建请求进行中输入仍可编辑，成功后 `clearDraft` 无条件清空并跳转，丢失新输入 | 创建期间冻结想法、名称、模板、方向导入、重新截取与「开始构思」，`remember` 在源头拒绝改动，重复提交被拒；成功时用既有 `releaseSubmittedDraft`，只清理与提交快照一致的草稿；失败或结果未知保留原请求体与幂等键 | 组件：慢请求期间控件禁用、改动不写入；期间另有更新草稿时，旧请求成功后该草稿仍在。**修复前对照：旧实现失败**（控件未冻结） |
| 2 | 所有编辑器共用一个保存状态字符串 | 未保存状态改为读取各编辑器真实保存的草稿（`ads-draft:<作品>:<对象>:<基线>`，编辑器保存成功只释放已提交快照），按对象列出；最后一次事件只补充原因。保存、If-Match、409 规则不变 | 单测：故事有草稿时剧本「已保存」仍显示故事未保存；恢复的草稿显示未保存；保存期间的新输入不被标为已保存。组件：刷新恢复草稿后状态正确，「稍后继续」给出提示 |
| 3 | 合成与审核后父层不刷新；「查看任务进度」不含合成任务；首次定位不等事实 | 单镜、集级合成面板在受理、终态、审核后通知父层（`useChangeNotice`，每个终态只通知一次）；父层只重读一次事实，面板自身轮询不变（串行、终态停止、隐藏暂停、恢复重读）。任务抽屉列出 `MEDIA_COMPOSE`（不提供重试，沿用原规则）。首次步骤与剧集在全部事实读完后才选择；加载恢复成功清除旧错误 | 组件：事实未到前不选步骤；合成任务出现在任务抽屉；加载失败后恢复清除错误。**真实 E2E：单镜批准、集级批准后不 reload 即更新**（页面标记证明未刷新） |
| 4 | 分页：游标被计为候选；成片只看最新 10 条；角色/场地/场景忽略后续页；场景失败当空列表；加载更多可重复 | 有界分页（每页 50、最多 20 页，可在结论确定时提前结束），游标只作扫描位置，空页带游标继续读，重复游标停止；结果标为 ok / unavailable / failed / incomplete，未读完或失败显示「尚未确认」。场景列表读全页并区分失败与空；我的作品「加载更多」请求中禁用并按 id 去重 | 单测：空候选页带游标（**旧实现失败**：被算成已完成）；第 11 条才有 ACTIVE+APPROVED（**旧实现失败**：判为待确认）；第 21 个角色 REJECTED；重复游标与上限；组件：场景加载失败与真实空列表；连续点击加载更多只请求一次 |
| 5 | 一个集级任务让所有集显示处理中 | 后端为 job 视图补只读字段 `composeEpisodeId`（取自冻结输入），按此判断每集；无法确定归属的任务不归给任何集。进入步骤时打开真正需要处理的剧集 | 单测：仅第 1 集运行；无归属任务不影响任何集；剧集选择。组件：第 1 集处理中、第 2、3 集未开始。真实 PostgreSQL：worker 集成断言字段。**真实 E2E：第 1 集合成期间与完成后第 2、3 集都不显示处理中** |
| 6 | 剧本换版后不读历史成片；历史 Job 的 SUCCEEDED 当作待审核；REJECTED 被忽略；失效与完成态动作无去向 | 历史成片对每集都读取（候选仍只在剧本通过时读）；STALE+APPROVED 显示「来源已更新」，ACTIVE+REJECTED 显示「需要处理」；只用正在运行的任务表示处理中，已结束的历史任务不再推导状态。来源已更新：文字步骤引导「修改并保存新版本」，媒体步骤引导重新生成/重新编排；最后一步完成显示「查看并下载成片」 | 单测：剧本 DRAFT 时仍读到 STALE+APPROVED；历史成功/失败任务不再给出待确认/需要处理；各状态动作去向 |
| 7 | 其余讨论 | 见下表 | — |

### 行内讨论逐条

| 讨论 | 结论 |
| --- | --- |
| r4203526528 恢复草稿的保存状态 | 已修复（第 2 项） |
| r4203526537 首次定位等待媒体事实 | 已修复（第 3 项） |
| r4203526547 合成/审核后刷新 | 已修复（第 3 项） |
| r4203526554 任务进度包含合成任务 | 已修复（第 3 项）；集级合成进行中时主按钮改为「查看合成进度」定位到编排面板 |
| r4203526565 我的作品角色/场地分页 | 已修复（第 4 项） |
| r4203526568 ACTIVE+REJECTED 成片 | 已修复（第 6 项） |
| r4203526577 最后一步完成的空按钮 | 已修复（第 6 项） |
| r4203526585 打开需要处理的剧集 | 已修复（第 5 项） |
| r4203526589 加载更多重复 | 已修复（第 4 项） |
| r4204153337 场景分页 | 已修复（第 4 项） |
| r4204153351 场景读取失败当空列表 | 已修复（第 4 项） |
| r4204153356 已换版镜头的历史任务 | 已修复（第 6 项：只看运行中任务） |
| r4204153373 恢复后清除旧错误 | 已修复（第 3 项，共享 hook 只加一行 `setError(null)`） |
| r4204153387 来源已更新的动作 | 已修复（第 6 项） |
| r4204592894 多编辑器共用状态 | 与 r4203526528 重复，已修复（第 2 项） |
| r4204592904 创建中的新输入 | 已修复（第 1 项） |
| r4204592917 刷新失败后的旧事实 | 已修复：每次读取带状态，失败/不完整显示「尚未确认」并提供「重新读取进度」，不再据旧结果判定完成；切换作品先清空事实 |
| r4204592925 无角色时场地问题被忽略 | 已修复（第 6 项相关的 cast 合并） |
| r4204592934 两种合成开关分开 | 已修复：候选与成片分别分类，仅集级关闭时保留单镜事实，提示按各自开关显示 |
| r4205011366 游标计数 | 已修复（第 4 项） |
| r4205011375 只看 10 条成片 | 已修复（第 4 项） |
| r4205011386 换版后读历史 | 已修复（第 6 项） |
| r4205011396 集级任务广播 | 已修复（第 5 项） |

### 后端

`packages/database/src/runtime-store.ts`：job 视图新增只读字段 `composeEpisodeId`。原因：现有 job 视图没有集归属，前端只能猜测。来源为已存在的冻结输入 `input.episodeId`，只对无镜头来源的 `MEDIA_COMPOSE` 有值，其余为 `null`。新增字段，不改既有字段或行为；无数据库结构变更，**无 Migration**。`docs/API_CONTRACT.md` 已注明。

### 测试

| 类型 | 内容 | 结果 |
| --- | --- | --- |
| 本机（Node 24.21.0，engine 检查开启） | `pnpm verify`：web 214（新增步骤/事实/未保存/通知/组件回归）、api 67、worker 68、database 27、domain 78 等全部通过；`pnpm m3-av-e2e:check`；`pnpm m3-av-e2e:outcome` 23 通过；`git diff --check` | 通过（源码 SHA 内容） |
| 模拟（happy-dom + 模拟 fetch / 假分页客户端） | 上表各回归 | 通过 |
| 修复前对照 | 创建丢输入、游标计数、第 11 条成片：在旧实现上运行，3 项均失败；其余用例未做旧实现对照 | — |
| 真实 CI | 见下 | — |

E2E 加强（`scripts/beginner-web-acceptance.mjs`，原 10 个必需阶段不变）：单镜批准后与集级批准后都不 `page.reload`，用页面内标记证明未刷新，检查剧集标签、步骤按钮与下一步动作原地更新；集级合成受理后与完成后检查第 2、3 集不显示「处理中」；合成关闭态改为按集级开关检查（第 5 步提示与「尚未确认」）。创建断网重放与单作品幂等断言保留。

### CI（源码 SHA `7e4b7fa`）

9/9 success，首次运行即通过，没有重跑：

| 工作流 | Run | 结论 | 说明 |
| --- | --- | --- | --- |
| Beginner creator web（pull_request） | [37606560484](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560484) | success | job 112743358379；10/10 必需阶段，含不刷新更新与第 2、3 集不误标；artifact 11474554025 |
| Beginner creator web（push） | [37606556452](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606556452) | success |  |
| M4 three episode sample end-to-end | [37606560747](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560747) | success | results.json 52/52 passed；artifact 11477180673 |
| M1-C integration | [37606560491](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560491) | success | job 112743358477；含 composeEpisodeId 真实 PostgreSQL 断言（media-retry.integration 通过） |
| M2-C integration | [37606560482](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560482) | success | job 112743358500；同上 |
| M2-A integration | [37606560571](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560571) | success |  |
| M3-A integration | [37606560501](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560501) | success |  |
| M3-B integration | [37606560647](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560647) | success |  |
| Writing assistant API | [37606560780](https://github.com/xyq-dev/ai-drama-studio/actions/runs/37606560780) | success |  |

### 遗留

1. 单镜「待确认」（已合成未审核）只能在打开对应镜头后看到：没有不逐个扫描镜头就能读到当前单镜成片审核状态的接口，本轮不新增。
2. 角色参考图仍只验证关闭态；第 2、3 集未在 E2E 中走完。
3. 嵌入的原组件仍显示对象 ID 片段和部分英文状态词。

### 状态

Commit / Push：YES（普通推送原分支）。Merge：NO。Deploy：NO。Migration：NO。Paid calls：NO。等待 Codex 复审。
