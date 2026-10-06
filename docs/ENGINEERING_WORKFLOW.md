# Engineering Workflow

AI Drama Studio 统一采用以下研发闭环：

```text
需求
→ 技术设计
→ 分支开发
→ 本地验证
→ Push
→ GitHub Actions CI
→ Code Review
→ 修复 Review findings
→ Merge 到 main
→ Release Gate
→ GitHub Release / Stable Tag
→ Deploy
→ Smoke Test
→ Monitoring
→ 必要时 Rollback
```

## 角色

| 角色 | 职责 |
| --- | --- |
| 用户 / Owner | 产品优先级、业务决策、最终高风险授权 |
| Codex | 技术设计、实现与测试、数据库/API/并发审查、PR Review、Git 操作与已配置环境部署 |
| Cursor | 已确定方案的代码实现、本地测试、Git 操作 |
| GitHub Actions | CI、集成测试、Release Gate、Rollback Gate |
| GitHub | 代码真相、PR、Review、Release、Stable Tag、回滚入口 |
| Deployment / Monitoring | 生产部署、Smoke Test、运行监控、告警 |

## 强制质量门

1. CI 不通过，不得 Merge。
2. Code Review 存在未处理的 P0/P1 correctness finding，不得 Merge。
3. 数据库变更必须说明 Migration 风险、兼容性和验证方式。
4. 生产数据修改、Migration 执行和数据库恢复仍需专门授权；常规 Git 操作与指定站点部署采用下方持续授权。
5. Release 必须指向 `main` 当前 HEAD，并通过 Release Gate。
6. 生产回滚以已验证的 GitHub Stable Tag / Release 为版本来源。
7. 数据库不做“跟着代码自动向下回滚”；默认 forward-fix，恢复备份必须单独授权。

## 分支与 PR

- `main`：已通过 Review 和 CI 的集成主线。
- 功能开发：`feat/*`
- 修复：`fix/*`
- 工程基础设施：`chore/*`

所有开发通过 PR 进入 `main`。禁止为赶进度跳过 CI / Review。

## Git 与部署持续授权（2026-10-06 起）

Owner 已明确要求：“以后自动提交、推送或部署，更新到服务器页面”。该约定适用于本仓库后续已交办的开发任务，并取代历史执行单中“每轮再确认 commit / push / deploy”的限制。

- 完成必要验证后，Codex / Cursor 自动选择性提交本轮文件、普通推送功能分支、创建或更新 PR；Review 与当前提交的 CI 通过后，按普通 merge commit 合入 `main`。这些常规步骤不再逐项请求许可。
- 对已有且明确指定的 `https://drama.playhubs.cn` 测试站点，自动把已验收的主线提交更新到服务器，执行所需构建、服务重启和页面 / health 验证，并记录实际运行的 SHA。保留部署前版本，发布失败时可恢复同一站点的上一代码版本，不倒退数据库。
- 每轮结果报告提交、推送、合并、部署和页面检查的实际状态。GitHub CI 通过、权限已授权或仓库文档更新均不能代替服务器发布证据。尚无可用服务器连接或发布入口时，先完成可执行的 Git 工作，明确报告连接阻塞，不声称页面已更新。
- 继续保留已有未提交文件、密钥、环境配置和数据。只部署本项目；不修改同服务器的其他项目。无需 force push、reset、clean 或清空工作区来完成普通更新。
- 本授权不增加付费模型调用、数据库破坏性操作、新 Migration 执行、凭据公开或未指定生产环境的权限。新迁移与真实付费调用仍按各自已有授权执行。

这是一项持续执行约定，不表示仓库已经安装自动部署服务。现有 Release Gate 创建 GitHub Release，不能当作服务器更新入口。测试站点可部署通过 PR / CI 的精确主线 SHA；正式生产 Release 继续遵守上方 Release Gate 和 Stable Tag 规则。

## Definition of Done

单个任务完成至少满足：

- 需求/Issue 验收标准达成；
- 必要测试已补充；
- lint / typecheck / unit / integration / build 中适用项通过；
- Review finding 已处理或明确记录为非阻塞债务；
- PR 已 Merge；
- 如属于可发布变更，Release / Deploy / Smoke Test 状态已记录。

项目级完成以 `docs/IMPLEMENTATION_PLAN.md` 当前规划范围为准，而不是以单个 PR 完成为准。
