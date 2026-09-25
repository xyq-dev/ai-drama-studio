# Release and Rollback

## 原则

GitHub 是版本与回滚控制中心：

```text
main
→ Release Gate
→ Stable Tag / GitHub Release
→ CI/CD 部署指定 Tag
→ Smoke Test
→ Monitoring
```

发生线上异常时：

```text
告警 / 人工确认异常
→ 选择上一稳定 GitHub Release Tag
→ Rollback Gate
→ CI/CD 重新部署该 Tag
→ Smoke Test
→ 恢复监控
```

当前仓库尚未配置生产部署目标，因此现阶段只启用 **Release Gate** 与 **Rollback Gate**。
Rollback Gate 只验证“目标 Release 是否可安全作为回滚版本”，不会伪造或执行生产重部署。

## Release

### 进入条件

- 目标 Commit 必须等于 `main` 当前 HEAD；
- CI / integration 通过；
- Prisma validate / generate 通过；
- JavaScript workspace `pnpm verify` 通过；
- Python media worker tests 通过；
- 数据库 Migration 已经过 Review；
- 不存在未处理的阻塞性 Review finding。

### GitHub 操作

在 Actions 中手动运行 **Release Gate**：

- `release_tag`：例如 `v0.1.0`
- `target_sha`：准备发布的 `main` HEAD SHA

Gate 成功后才创建：
- Git tag
- GitHub Release
- release manifest artifact

创建 Release **不等于生产部署**。

## Deploy

生产 Deployment Adapter 尚未实现。

未来部署工作流必须满足：

1. 输入只能是已有 GitHub Release / Stable Tag；
2. 不允许直接从任意 feature branch 部署生产；
3. 部署完成后执行 Smoke Test；
4. Smoke Test 失败则停止扩大流量，并进入回滚流程；
5. 生产环境凭据只能来自 GitHub Environment / Secrets，不得写入仓库。

## Rollback

在 Actions 中手动运行 **Rollback Gate**：

- `release_tag`：上一稳定 Release Tag
- `confirm`：必须输入 `ROLLBACK`
- `incident_ref`：可选，记录事故/工单引用

Rollback Gate 会：

1. 验证 GitHub Release 存在；
2. checkout 该稳定 Tag；
3. 重新运行完整验证；
4. 生成 rollback manifest artifact；
5. 明确输出目标 Commit。

当前阶段 **不会执行部署**。生产 Deployment Adapter 接入后，应由部署工作流消费该稳定 Tag。

## 数据库回滚策略

数据库和应用代码分开处理：

- 默认只允许 additive / backward-compatible Migration；
- 代码回滚不自动执行 down migration；
- schema 问题优先 forward-fix；
- 需要数据恢复时必须：
  - 明确事故范围；
  - 确认备份时间点；
  - 评估 RPO / RTO；
  - 获得显式授权；
  - 在隔离环境验证恢复流程后再处理生产。

禁止通过 Git 回退 SQL 文件来假装数据库已经回滚。

## Smoke Test

未来 Deploy / Rollback 后至少检查：

- Web 可访问；
- API live / ready；
- Worker live / ready；
- PostgreSQL / Redis / MinIO readiness；
- 关键 API 最小闭环；
- 最新错误日志无异常突增。

## Monitoring

最低监控范围：

- 服务可用性；
- 5xx / 未捕获异常；
- Job failure / retry；
- PostgreSQL 连接与错误；
- Redis / Queue；
- Worker lease / reconciliation；
- Provider 调用失败；
- 关键业务 DomainEvent；
- 部署版本 / Git SHA。

所有生产告警必须能追溯到具体 GitHub Release / Commit。
