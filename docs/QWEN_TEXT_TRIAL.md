# 千问文本试写

本工具只在本机生成一集中文短剧的候选剧本草稿。它不接入网页，不写入数据库，也不替代 Mock 文本适配器。

默认是 dry-run：校验输入并打印脱敏调用计划，不读取 `DASHSCOPE_API_KEY`，不访问模型。只有显式 `--execute` 才会发请求。

## 命令

```powershell
corepack pnpm qwen:trial -- --input packages/providers/examples/qwen-text-trial.input.json --output qwen-text-trial-output/run-1
```

执行模式另外需要进程环境里的官方 HTTPS 地址和 API Key，并加上 `--execute`。示例输入不含真实用户数据。输出目录 `qwen-text-trial-output/` 已被 Git 忽略。已存在的输出目录不会被覆盖。

```powershell
$env:DASHSCOPE_API_KEY = "<本机密钥>"
$env:BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
corepack pnpm qwen:trial -- --input packages/providers/examples/qwen-text-trial.input.json --output qwen-text-trial-output/run-1 --execute
```

密钥只放在进程环境。不要写入命令行参数、前端、日志或输出文件。模型默认是 `qwen3.7-plus-2026-05-26`。需要指定另一模型时，设置 `QWEN_TEXT_TRIAL_MODEL`。失败后不会自动更换模型或重试。

成功时目录里有 `draft.json` 和 `receipt.json`。草稿是待人工审核的候选，没有 APPROVED、CURRENT 或 revisionId。`targetDurationSeconds` 只是写作目标。回执里的费用金额保持未知，不记 ACTUAL 0。

API 和 Worker 不读取这些变量，未配置千问时仍可启动。

## 实现边界

客户端在 `packages/providers`，输入和草稿契约在 `packages/contracts`。它不是 `TextGenerationAdapter`，不声明 `REPLAY_SAFE_SYNC`，也不替换 `MockTextAdapter`。一次 `--execute` 只发一个非流式请求，超时、断连或响应超限后不自动再发。本地 runId 不作为服务商去重保证。费用金额保持未知。

本文件不代表真实模型已经调用，不代表网页已经接入，也不代表费用已经验收。Migration=NO。
