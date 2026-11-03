import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./cli.mjs";
import { loadStore } from "./store.mjs";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stdout.write(`not ok - ${name}: ${error instanceof Error ? error.message : error}\n`);
  }
}

const dir = mkdtempSync(join(tmpdir(), "grokbot-native-"));
const storePath = join(dir, "store.json");

await test("help", async () => {
  const r = await runCli(["help"]);
  assert(r.ok && r.exitCode === 0, "help should succeed");
  assert(String(r.output.help).includes("create"), "help mentions create");
});

await test("create → list → continue → save-script → status (local)", async () => {
  const created = await runCli([
    "create",
    "--title",
    "雨夜站台",
    "--premise",
    "两个陌生人在末班车误点后交换秘密",
    "--genre",
    "悬疑",
    "--audience",
    "年轻观众",
    "--store",
    storePath,
  ]);
  assert(created.ok, "create ok");
  assert(created.output.project?.id, "project id");
  const projectId = created.output.project.id;

  const listed = await runCli(["list", "--store", storePath]);
  assert(listed.output.projects?.length === 1, "one project");
  assert(listed.output.currentProjectId === projectId, "current set");

  const cont = await runCli(["continue", "--project-id", projectId, "--store", storePath]);
  assert(cont.output.project?.id === projectId, "continue same id");

  const scriptText = [
    "场景：雨夜公交站台。角色：阿宁（女）、周言（男）。",
    "阿宁：末班车又停了。你也在等吗？",
    "周言：等车，也等一个不肯回消息的人。",
    "阿宁：那我们交换一个秘密，好打发这场雨。",
    "周言：……可以。但说完就各自上车，别再见面。",
    "阿宁：成交。",
  ].join("\n");

  const saved = await runCli([
    "save-script",
    "--project-id",
    projectId,
    "--text",
    scriptText,
    "--script-title",
    "样片对白 v1",
    "--store",
    storePath,
  ]);
  assert(saved.ok, "save-script ok");
  assert(saved.output.revision?.reviewStatus === "DRAFT", "draft revision");
  assert(saved.output.revision?.contentHash, "hash present");

  const status = await runCli(["status", "--project-id", projectId, "--store", storePath]);
  assert(status.output.status?.scriptCount === 1, "one script");
  assert(status.output.status?.blockers?.some((b) => b.includes("未 APPROVED")), "blocker for review");
});

await test("dry-run create does not write", async () => {
  const empty = join(dir, "empty.json");
  const r = await runCli(["create", "--title", "不应写入", "--dry-run", "--store", empty]);
  assert(r.output.dryRun === true, "dry-run flag");
  let threw = false;
  try {
    loadStore(empty);
  } catch {
    threw = true;
  }
  // loadStore returns empty if missing — check file not created with project
  const store = loadStore(empty);
  assert(Object.keys(store.projects).length === 0, "no projects after dry-run");
  assert(!threw || true, "ok");
});

await test("live without creds fails closed", async () => {
  const r = await runCli(["list", "--live"], { env: { ...process.env, ADS_SESSION_COOKIE: "", ADS_CSRF_TOKEN: "", ADS_ORIGIN: "" } });
  assert(r.ok === false && r.exitCode === 2, "exit 2");
  assert(String(r.output.error).includes("ADS_SESSION_COOKIE"), "mentions missing cookie");
});

await test("live create without --execute stays dry", async () => {
  const r = await runCli(
    ["create", "--title", "Live试探", "--live"],
    {
      env: {
        ...process.env,
        ADS_SESSION_COOKIE: "session=fake",
        ADS_CSRF_TOKEN: "csrf-fake",
        ADS_ORIGIN: "https://drama.playhubs.cn",
        ADS_LIVE_WRITES: "0",
      },
    },
  );
  assert(r.ok, "ok");
  assert(r.output.dryRun === true, "defaults to dry without execute");
  assert(r.output.plan?.POST === "/projects", "plans POST /projects");
});

await test("text-file save-script", async () => {
  const store2 = join(dir, "store2.json");
  const created = await runCli(["create", "--title", "文件剧本", "--store", store2]);
  const file = join(dir, "script.txt");
  writeFileSync(file, "甲：你好。\n乙：今晚雨很大。\n甲：那就别走。\n乙：……好。");
  const saved = await runCli([
    "save-script",
    "--project-id",
    created.output.project.id,
    "--text-file",
    file,
    "--store",
    store2,
  ]);
  assert(saved.output.revision?.text.includes("今晚雨很大"), "loaded from file");
});

rmSync(dir, { recursive: true, force: true });

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed ? 1 : 0;
