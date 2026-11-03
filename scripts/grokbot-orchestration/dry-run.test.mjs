import assert from "node:assert/strict";
import test from "node:test";
import { buildSteps, formatDryRun, assertNoPaidExecution, isLiveAllowed } from "./dry-run.mjs";

test("progress steps are read-only", () => {
  const steps = buildSteps("progress", { projectId: "11111111-1111-4111-8111-111111111111", episodeId: "22222222-2222-4222-8222-222222222222" });
  assert.ok(steps.length >= 5);
  assert.ok(steps.every((s) => s.method === "GET" && s.paid === false));
  assertNoPaidExecution(steps, { allowPaidChecklist: false });
});

test("quote-plan lists paid checklist but script keeps them marked paid", () => {
  const steps = buildSteps("quote-plan", {});
  const paid = steps.filter((s) => s.paid);
  assert.ok(paid.some((s) => s.path.includes("/real-media/generate")));
  assert.ok(paid.some((s) => s.path.includes("/real-media/authorize")));
  assert.equal(assertNoPaidExecution(steps, { allowPaidChecklist: true }), true);
  assert.throws(() => assertNoPaidExecution(steps, { allowPaidChecklist: false }));
});

test("formatDryRun labels PAID-CHECKLIST", () => {
  const text = formatDryRun("quote-plan", buildSteps("quote-plan", {}));
  assert.match(text, /PAID-CHECKLIST/);
  assert.match(text, /never issued by this script/);
});

test("only health may go live", () => {
  assert.equal(isLiveAllowed("health"), true);
  assert.equal(isLiveAllowed("progress"), false);
  assert.equal(isLiveAllowed("quote-plan"), false);
});

test("pause-plan includes provision plan CLI without --execute", () => {
  const steps = buildSteps("pause-plan", { jobId: "j", batchId: "b" });
  const cli = steps.find((s) => s.method === "CLI");
  assert.ok(cli);
  assert.equal(cli.path.includes("--execute"), false);
  assert.equal(cli.paid, false);
});
