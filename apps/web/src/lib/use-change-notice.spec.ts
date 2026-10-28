// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useChangeNotice } from "./use-change-notice";

describe("useChangeNotice", () => {
  it("announces each terminal state of a job once and lets the panel announce accept and review", () => {
    const onChanged = vi.fn();
    const { rerender, result } = renderHook(({ job }) => useChangeNotice(job, onChanged), {
      initialProps: { job: { id: "a", state: "QUEUED" } as { id: string; state: string } | null },
    });
    expect(onChanged).not.toHaveBeenCalled();
    rerender({ job: { id: "a", state: "RUNNING" } });
    rerender({ job: { id: "a", state: "SUCCEEDED" } });
    rerender({ job: { id: "a", state: "SUCCEEDED" } });
    expect(onChanged).toHaveBeenCalledTimes(1);
    result.current();
    expect(onChanged).toHaveBeenCalledTimes(2);
    rerender({ job: { id: "b", state: "FAILED" } });
    expect(onChanged).toHaveBeenCalledTimes(3);
    rerender({ job: null });
    expect(onChanged).toHaveBeenCalledTimes(3);
  });
});
