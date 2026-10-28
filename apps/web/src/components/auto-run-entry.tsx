"use client";

import { useEffect, useState } from "react";
import { AutoCreationClient, autoHeadline, type AutoCreationRunView } from "../lib/auto-creation-client";

const defaultClient = new AutoCreationClient();

/**
 * On a work made by AI automatic creation: a lasting way back to its run (after the story review, the run is where the
 * episode scripts are written). It only reads the stored run; it never starts, resumes or writes anything, and it is
 * absent when the work has no run or the run cannot be read.
 */
export function AutoRunEntry({ projectId, client = defaultClient }: { projectId: string; client?: AutoCreationClient }) {
  const [run, setRun] = useState<AutoCreationRunView | null>(null);

  useEffect(() => {
    setRun(null);
    const controller = new AbortController();
    client.latest(projectId, controller.signal)
      .then((latest) => { if (!controller.signal.aborted) setRun(latest && latest.projectId === projectId ? latest : null); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [client, projectId]);

  if (!run) return null;
  const placed = run.stages.some((stage) => stage.scriptSave === "saved");
  const hint = run.storySave === "saved" && run.state !== "running" && !placed ? "故事人工审核通过后，回到任务里把分集剧本写入作品。" : null;
  return (
    <p className="mt-3 rounded-[12px] border border-[#E7E5E0] bg-white p-3 text-[15px]" data-testid="auto-run-entry">
      <a className="underline" href={`/projects/${projectId}/auto`}>回到 AI 自动创作任务</a>
      <span className="text-[#5F5D66]">（{autoHeadline(run)}）</span>
      {hint ? <span className="block text-[#5F5D66]">{hint}</span> : null}
    </p>
  );
}
