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
| 4 试一段 | 剧集选择；场景列表；原场景/镜头面板（素材生成、单镜预检与合成、成片审核）；无场景时引导到任务面板（Mock 生成场景/镜头）或高级编辑；演示素材、约 1 秒、时长提示不等于实际时长、自然语言修改不会自动执行的说明；合成未开启时明确提示 | 浏览器真实闭环未执行（见下） |
| 5 出成片 | 原多镜编排（加入/上移/下移/移除、总时长、预检、提交、任务、审核、MP4 与来源清单下载、历史成片）；2–30 个镜头说明；费用面板 | 浏览器真实闭环未执行（见下） |
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
- **页面已接线、真实浏览器闭环未执行：** 第 3 步人物（原面板接线，组件层未单独测）、第 4 步任务状态与代表性单镜合成、第 5 步编排/审核/合格成片下载。原因：这需要 Worker、Mock 媒体开关、本地 FFmpeg 合成与媒体 worker 同时运行，本轮新增的 CI 作业只启动了 API 与 Web；已有 M4 52 阶段 E2E 覆盖的是高级页面，不能代替新手页面通过。
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

1. 第 3–5 步的真实浏览器闭环：在 CI 中复用 M4 E2E 的 Worker/媒体 worker/FFmpeg 启动方式，让新手页面完成场景与镜头、素材任务、单镜合成审核、编排合成、成片审核与下载。
2. 待接入能力需要后端设计：画风字段、自然语言修改、封面、场景标题、单集合成所属集、预算控制。
3. 嵌入的原组件仍有部分英文状态词和折叠的「高级 JSON」，后续可在不改业务逻辑的前提下统一措辞。
4. 合并前需要独立 Review。
