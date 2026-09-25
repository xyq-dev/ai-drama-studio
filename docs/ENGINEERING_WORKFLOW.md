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
| Codex | 技术设计、数据库/API/并发审查、PR Review、风险判断 |
| Cursor | 已确定方案的代码实现、本地测试、Git 操作 |
| GitHub Actions | CI、集成测试、Release Gate、Rollback Gate |
| GitHub | 代码真相、PR、Review、Release、Stable Tag、回滚入口 |
| Deployment / Monitoring | 生产部署、Smoke Test、运行监控、告警 |

## 强制质量门

1. CI 不通过，不得 Merge。
2. Code Review 存在未处理的 P0/P1 correctness finding，不得 Merge。
3. 数据库变更必须说明 Migration 风险、兼容性和验证方式。
4. 生产数据修改、Migration 执行、部署和回滚必须是显式授权动作。
5. Release 必须指向 `main` 当前 HEAD，并通过 Release Gate。
6. 生产回滚以已验证的 GitHub Stable Tag / Release 为版本来源。
7. 数据库不做“跟着代码自动向下回滚”；默认 forward-fix，恢复备份必须单独授权。

## 分支与 PR

- `main`：已通过 Review 和 CI 的集成主线。
- 功能开发：`feat/*`
- 修复：`fix/*`
- 工程基础设施：`chore/*`

所有开发通过 PR 进入 `main`。禁止为赶进度跳过 CI / Review。

## Definition of Done

单个任务完成至少满足：

- 需求/Issue 验收标准达成；
- 必要测试已补充；
- lint / typecheck / unit / integration / build 中适用项通过；
- Review finding 已处理或明确记录为非阻塞债务；
- PR 已 Merge；
- 如属于可发布变更，Release / Deploy / Smoke Test 状态已记录。

项目级完成以 `docs/IMPLEMENTATION_PLAN.md` 当前规划范围为准，而不是以单个 PR 完成为准。
