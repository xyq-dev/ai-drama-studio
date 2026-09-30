# Mock 对象存储目录同步修复

## 现场

- 修复先写在 `D:\Projects\ai-drama-studio-fix-mock-object-store-windows`，分支 `fix/mock-object-store-windows`，基线 `6548ffe07f54a03ac2c5547d7b724cb329af5932`。
- 相同的两个 Worker 源文件已纳入 `D:\Projects\ai-drama-studio` 的 `feat/m2-creator-ui`。原 worktree 保留，不另推同一修复。
- 生产禁用保护仍在 `apps/worker/src/runtime/start-runtime.ts`：`NODE_ENV=production` 或非绝对路径会在创建 `LocalMockObjects` 之前抛出。`main.ts` 在 production 下不传入 `mockObjectDir`。本次没有移除或放宽该保护，也没有扩展到真实对象存储。

## 原因与语义

本机 Windows NTFS 上，文件写入、文件 `sync`、rename 和目录打开成功，只有 `directoryHandle.sync()` 返回 `EPERM`。

接受非生产 Windows 上的目录同步限制。文件内容同步仍是强制步骤。该平台不承诺异常断电后的目录项持久性。这不是与完整目录 fsync 等价的保证。

捕获范围只包住 `directoryHandle.sync()`。只有 `process.platform === "win32"` 且 `code === "EPERM"` 才继续，并且目录同步仍会实际调用。文件打开、写入、文件 sync、rename、目录打开和关闭的错误继续抛出。Windows 上的其他目录同步错误，以及其他平台的 `EPERM`，也继续抛出。句柄关闭和临时文件清理保持在 `finally`。key、checksum、重复写入幂等和内容冲突检查未改。

## 源码 diff

```diff
      await rename(temporary, path);
      const directoryHandle = await open(dirname(path), "r");
-      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
+      try {
+        try {
+          await directoryHandle.sync();
+        } catch (error) {
+          // Non-production Windows NTFS rejects directory fsync with EPERM.
+          // File bytes were already synced before rename. Continuing here does
+          // not make the directory entry durable across power loss and is not
+          // equivalent to a successful directory fsync.
+          if (process.platform !== "win32" || !isDirectorySyncEperm(error)) throw error;
+        }
+      } finally {
+        await directoryHandle.close();
+      }
+function isDirectorySyncEperm(error: unknown): boolean {
+  return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
+}
```

## 验证

真实文件系统（本机 Windows NTFS，`os.tmpdir()`）：

- 重复写入幂等、最终字节一致、checksum 冲突和非法 key 仍失败。
- 目录 `sync` 的真实 `EPERM` 被继续处理，临时文件清理，句柄关闭。

注入 I/O 或平台（委托真实文件系统，只替换指定失败；`process.platform` 模拟不是 Linux 实测）：

- 文件 `sync` 的 `EPERM` 失败，且 `rename` 调用次数为 0。
- Windows 目录 `sync` 的 `EIO` 失败。
- 模拟 `linux` 时目录 `sync` 的 `EPERM` 失败。
- rename 失败和目录打开失败继续传播。
- 上述失败路径都关闭句柄并清掉临时文件。

命令与结果：

- 集成前，在修复 worktree：`pnpm --filter @ai-drama/worker exec vitest run src/runtime/local-mock-objects.spec.ts src/runtime/mock-media-guard.spec.ts`：2 files，6 tests，通过。第一次因缺少 `@ai-drama/database` 构建产物使 guard 套件无法加载；构建依赖后重跑通过。该 worktree 的 lint 与 typecheck 通过。
- 集成到 UI 工作区后，`pnpm verify` 退出码 0。其中 `@ai-drama/worker` 测试 22 通过，含 `local-mock-objects.spec.ts` 5 项。
- 未运行会重置 schema 的数据库集成测试。真实浏览器联调未执行。

## 交接

- 修改文件：`apps/worker/src/runtime/local-mock-objects.ts`、`apps/worker/src/runtime/local-mock-objects.spec.ts`、本报告。
- 持久性变化：仅非生产 Windows 在目录 fsync 返回 `EPERM` 时不再让 `put` 失败。其它平台和其它错误不变。
- Migration：未执行。
- 不另推 `fix/mock-object-store-windows`。不创建 PR，不合并 main。
