# 分类中心第一版

## 现场与范围

- 工作目录：`/workspace/scratch/62f2be8edb46/ai-drama-studio-merge-review`
- 开发分支：`feat/classification-center`
- 开始时从 GitHub 核实的 main：`f4a7a8b316abc998be672b0a4a50c736c5a439f3`。
- 开始时工作区干净。未改 Windows 工作区或服务器。
- 参考：用户提供的「短剧分类中心」图片。
- Migration=NO，API/Worker/数据库及模型调用未改。

## 交付

新增 `/categories` 并接入共用创作导航。新页为红白配色、题材插画卡片、六组标签、创作提示侧栏和窄屏抽屉。插画为原创内联 SVG，不下载第三方图片，不依赖图片服务。保留 AI Drama Studio 品牌，不虚构登录身份、管理员账号、通知或未实现的管理入口。

12 个一级分类与图一致。六组标签分别为 12/16/12/10/8/6，共 64 个；具体标签为本产品参考词库，不宣称是外部平台官方分类。页面数量直接从词库计算。

搜索可匹配中文题材、英文编码与标签。题材详情提供解释、写作切入问题和推荐标签。用户可选择一个主分类、多个标签，移除、清空和复制创作方向。4–6 个标签是建议，不是强制限制。复制失败时提供可选择的文本。迟到的复制反馈不能标记新选择为已复制。

选择使用浏览器 localStorage 的独立版本键保存；恢复时校验版本和 ID。损坏内容不会在读取时被覆盖；存储不可用时仍可当页操作并明确提示。它不会修改项目、审核、版本、If-Match、账本，也不自动调用模型。跨账号、跨设备和服务端持久化不在本轮。

一级分类固定，因此主按钮进入真实创作中心。没有加入无法保存的新建分类表单。其他既有页面仅增加分类入口；原主题与业务逻辑保留。共用抽屉和新分类详情改为在 inert 清理后恢复焦点。

## 验证

Node 24.21.0，pnpm 10.17.0，未关闭 engine 检查。

| 检查 | 结果 |
| --- | --- |
| Web 全套 test | 18 files / 133 tests passed |
| 焦点修复后的页面定向回归 | 2 files / 14 tests passed |
| Web typecheck | exit 0 |
| Web lint | exit 0 |
| Web build | exit 0，新增 `/categories` 静态路由 |
| git diff --check | 通过 |

单元测试为 happy-dom 和浏览器存储替身，不代表 API 联调。既有 Web 测试仍打印模拟连接的 ECONNREFUSED，套件通过。

真实浏览器为 Chromium 153.0.8010.0，访问本轮实际启动的本地 Next.js 页面。执行搜索、题材弹窗、选择题材与标签、刷新恢复、组筛选、剪贴板失败回退、手机抽屉 Escape 和焦点恢复。分类页面未发出 `/api/` 请求；pageerror 为 0。

320、390、768、1024、1280、1440、1920px 视口的横向溢出均为 0。截图及本轮浏览器结果保存在 `.category-ui-shots/`（desktop、mobile、detail、mobile-detail 和 browser.json）。截图环境安装了 Noto Sans CJK 字体，仅用于验收，不增加产品字体依赖。

浏览器第一次检查发现抽屉同步调用 focus 时背景仍 inert；修复后重跑真实流程通过。首次新组件测试有四项按钮定位器错误：装饰性加号被 aria-hidden 隐藏后，定位器仍包含该字符；改为真实无障碍名称后通过。

## 未执行

未重跑全仓 pnpm verify、52 阶段 M4、真实 API、数据库或模型闭环；本轮仅为 Web 分类与本地创作方向。未执行 Migration、付费调用、部署或修改服务器配置。

上述为本地 UI 验收记录。后续用户已授权自动提交、推送和指定站点部署，约定已更新在 `docs/ENGINEERING_WORKFLOW.md`。GitHub PR / CI 与服务器发布分别核验；本地页面通过不表示服务器已更新。自动生成的 Web AGENTS.md / CLAUDE.md 和截图留在工作区，未纳入提交。
