# M4 预检审查修复报告

## 结论

审查修复已通过更新后的 28 阶段 CI。重新预检会立刻清掉旧结果、哈希和旧错误；失败只显示本次错误，并保留媒体选择。只读阶段比较七张业务表的行数、ID 和完整持久化字段指纹。

没有扩展渲染，没有改数据库结构、Worker、Provider 或 M2 状态机。

## 现场

目录 `D:\Projects\ai-drama-studio`。分支 `feat/m4-compose-preflight`。基线 `d82c537be0aa8cf10556f2e240812037ff35c066` 与当时的 `origin/feat/m4-compose-preflight` 一致，工作区干净。修复开始前没有 reset、clean、stash 或覆盖。

- 实际验收 SHA：`9e457e4962839915fb19eddc6b77020c5a0d9c02`
- 报告提交与该验收 SHA 分开。报告 SHA 是包含本文件的提交，push 后与 `origin/feat/m4-compose-preflight` 核对。
- `origin/feat/m3-lifecycle-acceptance` 仍是 `47166966d86b9b99be28a16daf7ab73763eb2ad3`。

## 修改文件

- `apps/web/src/components/compose-preflight.tsx`：开始新预检时推进世代，并立即清除旧结果和旧错误。当前请求失败后只写入本次错误。选择保持不变。世代不匹配的旧响应直接返回，不会清掉或覆盖新请求结果。
- `apps/web/src/components/compose-preflight.spec.tsx`：挂载组件回归覆盖成功、重新请求等待、拒绝、重试成功。保留 A→B→A、选择变化和资产失效覆盖，并确认旧响应不能覆盖新结果。
- `scripts/m3-av-e2e/compose-preflight.mjs`：七张表用 `row_to_json` 的稳定指纹比较行数、ID 和全部持久化列，包括状态、版本、输入输出、金额和时间。阶段详情只记录计数和指纹。
- `scripts/m3-av-e2e/compose-preflight.test.mjs`：ID 不变但字段指纹改变时，判定失败。产物摘要不含业务行。
- `package.json`：`m3-av-e2e:check` 与 `m3-av-e2e:outcome` 纳入上述回归。

## Migration

Migration=NO。没有新 Migration，没有改既有 migration、Prisma schema、触发器或约束。

## 本机命令

Node `v24.21.0`，pnpm `10.17.0`。本机没有 Docker，因此没有执行 `scripts/m3-av-e2e/run.mjs`。既有会 `DROP SCHEMA` 的 integration 套件没有执行。

| 命令 | 结果 |
| --- | --- |
| Web `compose-preflight.spec.tsx` | 5 passed |
| `pnpm m3-av-e2e:check` | exit 0 |
| `pnpm m3-av-e2e:outcome` | exit 0，22 passed |
| `pnpm verify` | exit 0。lint 9/9，typecheck 14/14，test 14/14，build 9/9。Web 合计 66 passed |
| `node scripts/m3-av-e2e/run.mjs` | 本机未执行 |
| 既有 DROP SCHEMA integration | 未执行 |

## Actions

通过运行的 head SHA 是 `9e457e4962839915fb19eddc6b77020c5a0d9c02`。

- Run https://github.com/xyq-dev/ai-drama-studio/actions/runs/36873348954
- Job https://github.com/xyq-dev/ai-drama-studio/actions/runs/36873348954/job/110406420136 ，id `110406420136`，结论 success
- Artifact `m4-compose-preflight-e2e-evidence` id `11168652510`，4811796 字节，SHA-256 `50275a6766631b701d95a1f6a794ea7d589b36e01c282685e7cf72ae83acb7bb`，expires `2026-10-08T14:15:35Z`
- 下载后的 zip 与上述 SHA-256 一致。`results.ok=true`，`outcome.ok=true`，missing 与 notPassed 为空。28 个必需阶段全部 passed。没有 fatal、restore、cleanup 或 compose down 失败。
- 数据库 `m3av_36873348954a1`，迁移前 public 表数 0。MinIO 对象数 0。

`compose-preflight-readonly` 记录的计数和指纹：

| 表 | 行数 | 指纹 |
| --- | --- | --- |
| generation_job | 38 | `eb00dc718c3b26ddcaa2406a8f5fe3c0e30fc5e1570124ea29fa8aa066bd47af` |
| job_attempt | 38 | `0c9e69be7461e56240b106dd0b79af4f75a6ce226a825bc6fa3db3ba629df5fe` |
| workflow_run | 38 | `ffeacc38fe07d6b39d9ef4e5f453e226371ca68bf2aa7bf0b9f6618023c2cf39` |
| asset | 21 | `6600671cea1be73c0adb82fc2aa16924f91a9fcd30ce3bf41af75626f04a4eae` |
| cost_ledger | 24 | `472bb573ef9054a70dd532dfc21cabcdd92556934bbdfb4a99920bd7ea2f1f33` |
| dispatch_outbox | 38 | `583b5cb2f64660d4bf040019523134a79030e386601e9170dd4687b2d5546d36` |
| domain_event | 303 | `d61d77e2246f283a24cbc11137334d738293035f42487086e6639c0c63aebd44` |

390px 溢出为 0。产物没有完整业务记录。

## 未执行项

本机 Docker harness、既有 DROP SCHEMA integration、main、force push、PR、merge、部署。没有新 Migration。
