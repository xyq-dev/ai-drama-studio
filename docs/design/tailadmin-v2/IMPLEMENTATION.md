# 红果 TailAdmin V2 实现与验收

日期：2026-11-12。范围：公共布局与「我的作品」；业务接口、鉴权、后台任务和数据库结构保持兼容。

## 设计来源

- [桌面1600×1000](https://www.figma.com/design/Bh40hsPnp1r9GDqB0KEB1d?node-id=3-146)
- [手机390×844](https://www.figma.com/design/Bh40hsPnp1r9GDqB0KEB1d?node-id=3-877)
- [归类确认](https://www.figma.com/design/Bh40hsPnp1r9GDqB0KEB1d?node-id=3-819)
- [回收站确认](https://www.figma.com/design/Bh40hsPnp1r9GDqB0KEB1d?node-id=3-855)
- [新建分类](https://www.figma.com/design/Bh40hsPnp1r9GDqB0KEB1d?node-id=6-404)
- 布局参考：[TailAdmin Next.js 免费版](https://github.com/TailAdmin/free-nextjs-admin-dashboard)。使用项目原有组件重新实现，不引入整套演示数据、Pro 功能或新的包依赖。

## 落地内容

280px 单侧栏、72px 顶栏、品牌红 #C94438、浅灰底色、白色圆角列表；分类收进主导航，桌面可收起侧栏，小于1024px改为抽屉。抽屉和弹窗保留焦点陷阱、Escape及背景 inert。

作品保留真实标题、56×84竖版缩略图、集数、分类、五步创作阶段、更新时间及三个真实入口：继续创作、剧本工作台、高级编辑。缺失封面不填充样片。

搜索位于桌面顶栏、移动正文；两者只渲染一个输入框。搜索、排序、分类、刷新、分页继续使用现有服务端查询。加载、空列表、读取失败和分类未启用状态均保留。

底部全选仅包含已显示作品，加载更多不会自动选中新作品，换分类或搜索清空选择。小于640px底栏固定并保留安全区和正文底部空间。归类弹窗冻结作品及 revision，选目标不会写入，确认后逐部提交；同分类也经过服务端版本校验。删除继续逐项预检，运行中项目跳过，保留恢复入口、局部失败报告及不确定写入不自动重试。

新建分类使用弹窗，丢失响应后重试复用同一个客户端分类ID。批量完成原按钮变禁用时将焦点落回正文；取消时返回原按钮。

## 对照说明

同尺寸、两部已选状态截图见本目录 desktop.png、mobile.png。示例作品与矢量封面仅由本地浏览器 fixture 提供；不代表线上数据或部署完成。

相对效果稿保留的实际产品差异：账户显示现有“管理员”和退出登录；阶段显示现有五步名称及真实状态标记；移动卡片继续展示分类、更新时间、进度和高级编辑。平板宽度低于1024px也采用卡片，避免六列表格挤压。字体使用 Noto Sans SC / Noto Sans CJK SC 及系统中文回退，不请求外部字体服务。

## 本地验证

- Web 74个测试文件、1051项测试通过，覆盖搜索分页、真实封面回退、分类幂等重试、快照冻结、并发revision校验、删除预检、局部失败与键盘焦点。
- Web lint、typecheck及包含工作区依赖的production build通过。
- Chromium实际组件与本地API fixture：1600、1280、1024、768、390、320px，无页面横向溢出；检查动作按钮不重叠、搜索/排序/分类/分页、新建分类、归类确认、未分类、空/错误状态、运行中作品跳过、桌面折叠、手机抽屉切换弹窗及底栏最后一项可滚动到达。
- storage-settings-ui-check.mjs 与 real-production-ui-check.mjs通过：公共Shell下设置与现有生产控制的桌面/手机回归，无真实模型或供应商调用。
- 所有浏览器数据均为隔离fixture，未读写生产数据库、未执行Migration、未部署。

复现：
```sh
corepack pnpm --filter @ai-drama/web... build
corepack pnpm --filter @ai-drama/web lint
corepack pnpm --filter @ai-drama/web typecheck
corepack pnpm --filter @ai-drama/web test
node scripts/project-library-ui-check.mjs
node scripts/storage-settings-ui-check.mjs
node scripts/real-production-ui-check.mjs
```
