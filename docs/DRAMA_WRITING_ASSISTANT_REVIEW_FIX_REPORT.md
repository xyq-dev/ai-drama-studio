# DRAMA_WRITING_ASSISTANT_REVIEW_FIX_REPORT

本轮修复了编剧助手的输入契约、文件读取竞争、验收库保护和真实网页保存，并同步了前置分支上的场景断言。尚未接通网页一键模型生成，没有发生付费调用。Migration=NO。

## 实际目录与 SHA

| 目录 | 分支 | HEAD | 说明 |
| --- | --- | --- | --- |
| `D:\Projects\ai-drama-studio-writing-assistant` | `feat/drama-writing-assistant` | `988dc8832f335aa3cfc1fd64110743fe52567a59` | PR #43 的已验证提交。审查时的 HEAD 是 `231da048a4ee1b0d658406cef3d75fac7fb9c247`。本段 Run 属于这个 SHA |
| `D:\Projects\ai-drama-studio-commercial-creator-ui` | `feat/commercial-creator-ui` | `40d87f61a999eca9b2f3705f1c49add52db9a60f` | PR #42。审查时的 HEAD 是 `a5651f7ebd5c0c65acc1410a067eb02c61d9b269` |
| `D:\Projects\ai-drama-studio` | `feat/qwen-text-trial` | `7ee5508bf01338ae4b974b7ad9943b1d2f7dff53` | 千问试接分支未改。未跟踪的 `m3-av-e2e-output-ci/` 仍在 |

PR #43 仍是 Draft，base 仍是 `feat/commercial-creator-ui`。PR #42 仍是 Draft，base 仍是 `main`。两条都没有合并，没有推 `main`，没有 force push。

编剧助手分支上的提交顺序：`40d87f6`（只在界面分支提交的场景等待）→ `6b4badf`（普通 merge 到编剧分支）→ `66ccf0a`（契约、读取世代、验收库保护、真实网页脚本）→ `e9097cb`（文本验收只要求 Postgres 与 Redis）→ `758cb6e`（验收 API 监听已编译的 3001 转发）。

保留了已有未跟踪文件：界面工作区的 `.commercial-ui-shots/`、两边的 `apps/web/AGENTS.md` 与 `apps/web/CLAUDE.md`、编剧工作区的 `docs/writing-assistant-shots/browser.json`。没有 reset、clean、stash，也没有覆盖这些文件。远端在本轮开始时没有超出已审查 HEAD 的新提交。

## 逐项修复

1. 已保存故事正文使用 20_000 字上限。`assertSavedBody` 拒绝超限和 NUL，错误写明没有截断，也不要求把原故事改短。领域回归覆盖：合法长故事策划整理成正文后，仍能准备分集指令。
2. 分集请求、创作指令和 `inputFingerprint` 都带上题材、目标观众、人物设定。填写值出现在可复制指令里。准备之后改动任何一项，旧候选不能直接采纳。
3. 文件导入、粘贴校验和重新准备指令都会推进读取世代。异步结果要同时匹配对象、读取世代和准备指令时的冻结指纹。旧成功、旧失败和收尾不会覆盖新候选或新错误。项目切换、集切换、A→B→A 和卸载保护仍在。这些路径没有自动保存，原 If-Match 保持不变。
4. 编剧助手 HTTP 验收不再执行 `DROP SCHEMA public CASCADE`。只允许在名为 `ai_drama_writing` 或 `ai_drama_writing_web` 的专用库上初始化，并且 `current_database()` 必须与 `WRITING_ACCEPTANCE_DATABASE` 一致。`public` 里已有任何业务表就拒绝初始化并退出。重跑使用新的隔离库。只应用仓库里已有的 migration。
5. 领域函数加真实 HTTP 的集成测试保留，并标明它不打开浏览器。真实网页验收在隔离 CI 里启动 Web、API 和 PostgreSQL：故事与分集都从网页导入手写候选；校验、预览、采纳期间没有业务写请求；点击原来的“保存新版本”后才保存；重读 revision，核对正文、原 If-Match 和 DRAFT。桌面与 390px 检查准备指令、校验预览、采纳和保存按钮可操作。这条链路没有 `route.fulfill`，也没有模拟 fetch。批准故事以产生分集是导入窗口之外的准备，保存下来的写作候选本身仍是 DRAFT。
6. PR #42 的场景竞争只改在 `feat/commercial-creator-ui`：重挂载后先等到“场景 scene-1”出现，再断言草稿仍在。终态停止轮询和草稿保留断言都还在，没有加固定 sleep。编剧分支用普通 merge `6b4badf` 带入这一次提交，没有在两条分支各做一份补丁。

既有 52 阶段断言没有放宽。

## 模拟测试与真实测试

| 范围 | 做法 | 证明什么 |
| --- | --- | --- |
| 领域与网页组件 | Vitest。网页组件在 happy-dom 里渲染，不发保存请求 | 长故事、三项指纹、慢文件与快文件、粘贴覆盖、重新准备后的冻结上下文 |
| HTTP 集成 | 进程内 Nest，连隔离的 PostgreSQL，不打开浏览器 | 解析、采纳、`POST /stories`、幂等重放、重读 DRAFT |
| 真实网页 | CI 里的 Next、Nest、PostgreSQL 和 Playwright Chromium | 网页导入手写候选、采纳不写库、点击“保存新版本”后重读正文、If-Match 和 DRAFT；桌面与 390px |

先前本地截图使用过 API 替身，不能当作本轮的保存证明。本轮的网页保存证明是下面 `758cb6e` 的 `web-import-adopt-save`。

## Run 链接

PR #43 已验证提交 `988dc8832f335aa3cfc1fd64110743fe52567a59`：

- push：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37193650808 ，`import-adopt-save` 与 `web-import-adopt-save` 都成功
- pull_request：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37193653310 ，同样两个 job 都成功

同一套验收脚本在父提交 `758cb6e63c591e816b4eb060ae510ca4e9166517` 也通过了：push https://github.com/xyq-dev/ai-drama-studio/actions/runs/37193456066 ，pull_request https://github.com/xyq-dev/ai-drama-studio/actions/runs/37193458253 。`66ccf0a` 与 `e9097cb` 的网页 job 失败，不能代替上面的结果。更早的 `37188059393` 也不属于这些 HEAD。

PR #42 新 HEAD `40d87f61a999eca9b2f3705f1c49add52db9a60f`：

- M1-C：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37192464509 成功。这是 Run `37186782024` / Job `111390271916` 里那次重挂载场景竞争的新结果
- M2-A：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37192464548 成功
- M2-C：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37192464512 成功
- M3-A：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37192464527 成功
- M3-B：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37192464514 成功
- M4：https://github.com/xyq-dev/ai-drama-studio/actions/runs/37192464557 在写这份报告时仍是 `in_progress`，没有结论

旧的 M1-C 失败 Run `37186782024` 只说明审查时的 `a5651f7`，不能说明 `40d87f6`。

## 数据库初始化保护

HTTP job 使用新建的 service 数据库 `ai_drama_writing`。网页 job 使用另一个新建的 service 数据库 `ai_drama_writing_web`。初始化前查询当前库名和 `public` 中的业务表。库名不在允许名单、连错库，或已有业务表，都会失败退出。代码路径里没有清库后继续。当前 CI 用的是新 service 数据库。这里没有发生、也不描述成已经误删过数据。

`apps/api/src/studio/studio.integration.spec.ts` 里原有的 schema 重置没有改动。编剧助手这两条验收都不走它。

## 仍未执行项

- 没有合并 PR #42 或 PR #43，没有推 `main`，没有 pack、部署或付费调用
- 没有新增 migration。Migration=NO
- 没有把模型接到网页
- 本机没有 Docker，因此没有在本机再跑一遍真实网页验收；该链路的结果以上面的 CI 为准
- M4 `37192464557` 在本报告写入时仍是 `in_progress`，没有结论
- 千问试接分支保持不动

`pnpm verify` 在本工作区退出码为 0。`git diff --check` 没有报告空白错误。
