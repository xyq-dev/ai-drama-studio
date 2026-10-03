# M3 AV E2E 小范围补强执行单

【执行工具：Cursor｜模型：Grok 4.7 High Fast】

本轮真实 Mock AV 核心闭环已由 Codex 验收通过，见 [M3_AV_E2E_CODEX_ACCEPTANCE.md](M3_AV_E2E_CODEX_ACCEPTANCE.md)。接下来先修验收脚本的假绿风险并补三处证据，不重写产品，不再重装本机 Docker。

## 起点和权限

在 D:\Projects\ai-drama-studio、feat/m3-av-workbench 工作。先核实 status/branch/HEAD，fetch 后从包含 1bf3f362aec56184127447f19df3fe5da5fbe494 和本执行单的最新 feature HEAD 继续，保留所有原有未提交改动，不 reset/clean/stash/覆盖。产品源码基线仍为 2e7dfb9。

允许改 scripts/m3-av-e2e、必要的测试命令和当前独立 feature workflow，以及报告。已有 feature 普通 commit/push 和 CI 新建、已核验空库上的既有 migration/provision 授权继续有效。不操作 main、force、PR、merge、部署、新 Migration、DROP SCHEMA、生产数据、付费模型或 ComfyUI；不改产品 API/Web/Worker/database/fixture 或 infra/compose.yaml。若新增断言暴露产品问题，留证据交 Codex，不擅自扩大修复范围。

## 1. 失败必须一致退出

run.mjs 最终 failed 表达式没有纳入 fatal、restoreError 或缺失/skipped 阶段。修成只有预期阶段全部 passed 且无 fatal、无必需清理错误才允许 ok=true/exit 0。真实错误必须记录 results.json 并退出非零；单列 notRun 项可以维持，不把这些项误当本轮必需阶段。

将结果判定提取为可单测的小函数或等价设计，增加有实际缺陷价值的回归：阶段外 setup/收尾 fatal、缺失/skipped/blocked/failed 阶段、目录恢复失败、compose down 失败、清理异常，以及完全成功。覆盖实际主流程返回的结果和退出码关系，不能只测试另一份未被主流程使用的公式。负例用受控替身即可，不为每个故障重新拉整套服务。

cleanup 在阶段外也可能出错；确保优先保存错误与结果，同时尽力继续清理本次资源。不要靠 catch 忽略失败。保留先断开只读数据库连接、再 compose down 的修复。

## 2. 补真实账本关联和终结字段

扩展只读 jobLedger，读取 job_attempt 的真实 id、finished_at、error_json 及 schema 中已有的状态字段。成功输出应断言成本 job_attempt_id 与当前唯一 attempt.id 相等，provider_request_id 与 attempt/Asset 一致；核对相关 job/source/provider 关联时沿用现有 schema，不能新建列或 SQL 修改成功状态。

两例恢复中，读取实际失败原 attempt 的终结与错误字段，确认 finished_at 非空、错误码一致、retryable=false 的实际存储位置；继续核对唯一 attemptNo/providerRequestId、零 Asset/cost。若现有持久化格式不同，先读代码和 schema，按真实字段比较，不编造字段。结构化 stage detail 保存脱敏的必要只读快照，使 Codex 能独立看见关联结果。不能把 requestId 不变写成测量了 submit 调用次数。

## 3. 补诊断和默认关闭取证

- 在 viewport 仍为 390px 时保存独立截图并记录 viewport/测量；保留现有 document/body/hash 溢出断言。
- 捕获 console 的 location、pageerror 及失败 HTTP/requestfailed 的 URL/状态/阶段，脱敏查询参数和错误内容。不无条件压制 404，也不无依据认定 favicon；明确每条预期门禁失败请求属于哪个负例。
- 新增真正删除环境变量 M3_MOCK_AV_ENABLED 的 API 实例负例，不能传 undefined 后仍继承 true。确认 unset 时拒绝生成且任务数不增长；继续保留显式 false 与 production 测试。
- 诊断采集不应把预期的门禁拒绝当产品失败；必需页面/媒体请求失败和未处理 pageerror 应留证据并按本次验收要求判断。

## 测试与交付

先跑新增结果判定回归、脚本语法与 harness check，再跑 pnpm verify。Node 24.21.0、pnpm 10.17.0，不关闭 engine 检查。本机无 Docker 不阻挡完成和普通 push。

选择性提交、普通 push 当前 feature，触发一次新的真实 CI。在 CI 新建空库仅应用既有 migration/provision，按当前真实服务流程重新取得证据。失败如实报告；成功后更新报告可以再做纯 docs 提交，不虚构新的验收 SHA。若必须再改脚本修失败，分别列出运行，不能把前次失败写成通过。

返回 M3_AV_E2E_HARDENING_REPORT：起点/最终 SHA、改动文件、回归命令与 exit、实际通过的 CI SHA/Run/Job/artifact、final results.ok/fatal/cleanup、真实 attempt/cost 关联快照、390px 截图、默认关闭证据、404/pageerror 来源及未执行范围。给出普通 push 与 fetch 核验。

这轮完成后，下一产品切片按既有 M3_MEDIA_GENERATION_DESIGN 的 M3-C 补字幕/音乐 Mock；本轮先不实现它们，也不提前进入 M4 合成。
