export interface StaleRecalculationSource {
  continueStaleRecalculation(): Promise<boolean>;
}

export function startStaleRecalculationPolling(
  source: StaleRecalculationSource,
  intervalMs = 1000,
  onError: (error: unknown) => void = (error) => {
    console.error(`stale propagation failed: ${error instanceof Error ? error.name : "unknown"}`);
  },
): { shutdown(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const tick = (): void => {
    if (stopped || inFlight) return;
    inFlight = source
      .continueStaleRecalculation()
      .then(() => undefined)
      .catch(onError)
      .finally(() => {
        inFlight = undefined;
      });
  };

  const timer = setInterval(tick, intervalMs);
  tick();
  return {
    shutdown: async () => {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
