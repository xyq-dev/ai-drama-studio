# Web 生产构建环境修复

## 已复现的问题

基线 `07351347102ba72841a367a1007f2a5398b3970f`，Node 24.21.0、pnpm 10.17.0、Next 16.3.6、React/ReactDOM 19.3.0，使用锁定依赖。在独立 worktree 中首次安装依赖、无 `.env` 文件和 `.next` 缓存：

| 构建入口 | 继承的 NODE_ENV | 结果 |
| --- | --- | --- |
| 原 `next build` | 未设置 | 首次冷构建通过，14/14 静态页 |
| 原 `next build` | development | 冷构建失败，`/_global-error` 的 `useContext` 为 null，digest `3755795656`，退出码 1 |
| 新 Web build 入口 | development | 冷构建通过，14/14 静态页 |
| 新 Web build 入口 | 未设置 | 冷构建通过，14/14 静态页 |

每轮先清理隔离目录的 `.next`；没有修改运行中的服务目录。Next CLI 保留已经设置的 `NODE_ENV`，因此部署 shell 继承的开发模式能污染生产构建。项目 `public-env.ts` 已明确跳过写入 `NODE_ENV`，本次没有修改它。

## 修复范围

`apps/web/scripts/build.mjs` 使用当前 Node 运行项目安装的 Next CLI，仅对子进程设置 `NODE_ENV=production`。其余环境变量、普通命令参数和退出码保留；失败不重试、不吞掉错误。`pnpm --filter @ai-drama/web... build` 和工作区构建都会使用此入口。

Creator UI CI 的既有构建步骤显式继承 `development`，真实覆盖修复前会失败的场景；其他 CI 的默认环境构建仍保留作为对照。未修改页面、鉴权、API/Worker 运行模式、环境文件、依赖或锁文件。Migration=NO。

本地另通过 Web lint、入口语法检查；无效 Next 参数和禁止的诊断构建参数均返回退出码 1，确认失败不会被当作成功。构建包含 TypeScript 检查；本次不重复运行与构建入口无关的业务单元测试。

## 诊断和部署边界

服务器报告的两次首次构建失败尚无原始日志，不能据此断言均由同一原因造成。本次修复的是已复现的环境继承问题；若服务器仍失败，需保留首个异常、完整栈、digest、退出码/信号以及构建进程实际的 `NODE_ENV`。只记录这些必要值，禁止输出完整环境或密钥文件。

生产构建使用项目 `build` 脚本；直接执行 `pnpm exec next build` 会绕过该入口。新入口明确拒绝 `--debug-prerender`，不会静默丢弃该参数。诊断时可在隔离目录显式使用 `pnpm --filter @ai-drama/web exec next build --debug-prerender`：Next 会再次切换开发诊断模式，该产物禁止部署。

参考官方说明：[NODE_ENV](https://nextjs.org/docs/messages/non-standard-node-env)、[Next CLI 调试预渲染](https://nextjs.org/docs/app/api-reference/cli/next#debugging-prerender-errors)。

本轮未连接服务器、未部署、未操作生产数据。用户主动移入回收站的 32 部作品保持原状态。
