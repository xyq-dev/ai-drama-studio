import { describe, expect, it } from "vitest";
import { assertJobTransition, canTransitionJob, deriveWorkflowRunState, DomainError } from "./index";

describe("DomainError", () => {
  it("keeps a stable code", () => {
    const error = new DomainError("NOT_READY", "dependency unavailable");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("NOT_READY");
    expect(error.name).toBe("DomainError");
  });
});

describe("GenerationJob state machine", () => {
  it("allows only documented transitions and never reopens terminal jobs", () => {
    expect(canTransitionJob("PENDING", "QUEUED")).toBe(true);
    expect(canTransitionJob("RUNNING", "QUEUED")).toBe(true);
    expect(canTransitionJob("WAITING_EXTERNAL", "SUCCEEDED")).toBe(true);
    expect(canTransitionJob("SUCCEEDED", "QUEUED")).toBe(false);
    expect(canTransitionJob("FAILED", "RUNNING")).toBe(false);
    expect(() => assertJobTransition("CANCELED", "QUEUED")).toThrowError(
      expect.objectContaining({ code: "JOB_INVALID_TRANSITION" }),
    );
  });

  it("preserves canceled workflow outcomes before critical-failure evaluation", () => {
    expect(deriveWorkflowRunState([{ state: "CANCELED", isCritical: true }])).toBe("CANCELED");
    expect(
      deriveWorkflowRunState([
        { state: "SUCCEEDED", isCritical: true },
        { state: "CANCELED", isCritical: true },
      ]),
    ).toBe("CANCELED");
  });

  it("derives failed and partial outcomes from terminal children", () => {
    expect(deriveWorkflowRunState([])).toBe("PENDING");
    expect(deriveWorkflowRunState([{ state: "RUNNING", isCritical: true }])).toBe("RUNNING");
    expect(deriveWorkflowRunState([{ state: "FAILED", isCritical: true }])).toBe("FAILED");
    expect(
      deriveWorkflowRunState([
        { state: "SUCCEEDED", isCritical: true },
        { state: "FAILED", isCritical: false },
      ]),
    ).toBe("PARTIAL_FAILED");
    expect(deriveWorkflowRunState([{ state: "SUCCEEDED", isCritical: true }])).toBe("SUCCEEDED");
  });
});
