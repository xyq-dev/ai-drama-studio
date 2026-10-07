import { describe, expect, it, vi } from "vitest";
import { RecoveryStopped, describeRecoveryError, isProcessStopping, runRecoveryModules } from "./recovery-modules";

function options(overrides: Partial<Parameters<typeof runRecoveryModules>[1]> = {}) {
  const reports: Array<[string, unknown]> = [];
  return { reports, value: { running: () => true, report: (module: string, error: unknown) => { reports.push([module, error]); },
    ...overrides } };
}

describe("runRecoveryModules (closeout item 6)", () => {
  it.each([["mock-media", ["character-reference"]], ["character-reference", ["mock-media"]]])(
    "runs the other module when %s throws, and reports the failure under its own name", async (failing, others) => {
      const ran: string[] = [];
      const fault = new Error("connection reset");
      const { reports, value } = options();
      const failed = await runRecoveryModules(["mock-media", "character-reference"].map((name) => ({
        name, run: async () => { ran.push(name); if (name === failing) throw fault; },
      })), value);
      expect(ran).toEqual(["mock-media", "character-reference"]);
      expect(failed).toEqual([failing]);
      expect(reports).toEqual([[failing, fault]]);
      expect(others.every((name) => ran.includes(name))).toBe(true);
    });

  it("runs modules one after another, never in parallel", async () => {
    let active = 0;
    let peak = 0;
    const module = (name: string) => ({ name, run: async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    } });
    await runRecoveryModules([module("a"), module("b")], options().value);
    expect(peak).toBe(1);
  });

  it("stops the pass and rethrows when shutdown begins or the pool is closed", async () => {
    let running = true;
    const second = vi.fn(async () => undefined);
    const { reports, value } = options({ running: () => running });
    await expect(runRecoveryModules([
      { name: "a", run: async () => { running = false; throw new Error("aborted"); } },
      { name: "b", run: second },
    ], value)).rejects.toThrow("aborted");
    expect(second).not.toHaveBeenCalled();
    expect(reports).toEqual([]);

    const closed = new Error("Cannot use a pool after calling end on the pool");
    const after = vi.fn(async () => undefined);
    await expect(runRecoveryModules([{ name: "a", run: async () => { throw closed; } }, { name: "b", run: after }],
      options().value)).rejects.toBe(closed);
    expect(after).not.toHaveBeenCalled();

    await expect(runRecoveryModules([{ name: "a", run: after }], options({ running: () => false }).value))
      .rejects.toBeInstanceOf(RecoveryStopped);
  });

  it("rethrows a fault the caller marks fatal without running the rest", async () => {
    const fatal = new Error("configuration missing");
    const after = vi.fn(async () => undefined);
    await expect(runRecoveryModules([{ name: "a", run: async () => { throw fatal; } }, { name: "b", run: after }],
      options({ fatal: (error) => error === fatal }).value)).rejects.toBe(fatal);
    expect(after).not.toHaveBeenCalled();
  });

  it("reports names, not messages", () => {
    const aggregate = new AggregateError([new TypeError("secret path /x"), new RangeError("id 123")], "wrapped");
    expect(describeRecoveryError("mock-media", aggregate)).toBe("mock-media recovery failed: AggregateError (TypeError,RangeError)");
    expect(isProcessStopping(new RecoveryStopped())).toBe(true);
    expect(isProcessStopping(new Error("timeout"))).toBe(false);
  });
});
