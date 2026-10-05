# 千问编剧候选

本工具在本机生成网页编剧助手可导入的候选文件。它有两个模式：

- 故事策划，候选 schema 为 `ads.writing.story-plan.v1`
- 单集剧本，候选 schema 为 `ads.writing.episode-draft.v1`

网页仍由使用者比较候选、采纳到草稿，再点击原来的「保存新版本」。本工具不增加网页生成按钮、API 路由、数据库表或 Worker 任务，不接入会员、计费或账户，也不替换 `MockTextAdapter`。

默认是 dry-run：校验输入并打印脱敏调用计划。dry-run 不读取 `DASHSCOPE_API_KEY`，不访问模型，不创建输出目录。只有显式 `--execute` 才会发请求。

## 命令

故事策划：

```powershell
corepack pnpm qwen:writing -- --input packages/providers/examples/qwen-writing-story.input.json --output qwen-writing-output/story-1
```

单集剧本：

```powershell
corepack pnpm qwen:writing -- --input packages/providers/examples/qwen-writing-episode.input.json --output qwen-writing-output/episode-1
```

执行模式使用与旧试接相同的进程环境，并加上 `--execute`。示例输入不含真实用户数据。输出目录 `qwen-writing-output/` 已被 Git 忽略。已存在的输出目录不会被覆盖，也不会发出请求。

```powershell
$env:DASHSCOPE_API_KEY = "<本机密钥>"
$env:BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"
corepack pnpm qwen:writing -- --input packages/providers/examples/qwen-writing-story.input.json --output qwen-writing-output/story-1 --execute
```

密钥只放在进程环境。不要写入命令行参数、前端、日志或输出文件。默认模型仍是 `qwen3.7-plus-2026-05-26`。新入口只发送 `max_completion_tokens`，上限 4096。失败后不会自动更换模型或重试。

成功时目录里有 `candidate.json` 和 `receipt.json`。`candidate.json` 经过与网页相同的解析和格式化校验后，才能在回执里标记 `candidateAccepted=true`。把它粘贴到编剧助手的 JSON 候选框即可。回执里的费用金额保持未知，不记 ACTUAL 0。本地 runId 不是服务商幂等保证。请求发出后如果结果不确定或本地保存失败，回执说明可能已经产生费用，不建议无条件重新请求。

旧命令 `pnpm qwen:trial` 仍生成原来的 `qwen.text.trial.draft.v1`，不会改名成编剧助手 schema。两个命令共用同一个 HTTP 客户端。

本文件不代表真实模型已经调用，也不代表网页已经一键调用模型。Migration=NO。
