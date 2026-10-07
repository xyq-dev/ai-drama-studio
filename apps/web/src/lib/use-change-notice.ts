"use client";

import { useEffect, useRef } from "react";

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);

/**
 * Tells a parent that a compose panel changed facts the parent shows: a job was accepted, reached a terminal state,
 * or its result was reviewed. The panel keeps its own polling; the parent only rereads its facts once per notice.
 * Each terminal state of a job is announced once.
 */
export function useChangeNotice(job: { id: string; state: string } | null, onChanged: (() => void) | undefined) {
  const latest = useRef(onChanged);
  latest.current = onChanged;
  const announced = useRef<string | null>(null);
  const jobId = job?.id ?? null;
  const jobState = job?.state ?? null;
  useEffect(() => {
    if (!jobId || !jobState || !TERMINAL.has(jobState)) return;
    const key = `${jobId}:${jobState}`;
    if (announced.current === key) return;
    announced.current = key;
    latest.current?.();
  }, [jobId, jobState]);
  return () => latest.current?.();
}
