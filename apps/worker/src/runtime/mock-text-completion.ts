import { JobPersistenceService, MockTextService, PersistenceError,
  type ExecutionContext, type MockSceneSnapshot, type MockShotSnapshot } from "@ai-drama/database";

export async function completeMockJob(
  jobs: JobPersistenceService, mockText: MockTextService | undefined,
  execution: ExecutionContext, attemptId: string, traceId: string, responseSnapshot: unknown,
): Promise<void> {
  if (execution.kind !== "MOCK_TEXT_SCENES" && execution.kind !== "MOCK_TEXT_SHOTS") {
    await jobs.succeedJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId, traceId, responseSnapshot });
    return;
  }
  if (!mockText) throw new Error("Mock text completion service unavailable");
  try {
    await jobs.succeedJobWithArtifact<{
      id: string; shotRevisionIds?: string[]; sceneRevisionIds?: string[];
    }>({
      workspaceId: execution.workspaceId, jobId: execution.jobId, attemptId, traceId,
      persistArtifact: (client) => execution.kind === "MOCK_TEXT_SHOTS"
        ? mockText.persistShots(client, execution.workspaceId,
          execution.inputSnapshot as MockShotSnapshot, traceId)
        : mockText.persistScenes(client, execution.workspaceId,
          execution.inputSnapshot as MockSceneSnapshot, traceId),
      artifactResponse: (artifact) => artifact.shotRevisionIds
        ? { shotRevisionIds: artifact.shotRevisionIds }
        : { sceneRevisionIds: artifact.sceneRevisionIds },
    });
  } catch (error) {
    if (!(error instanceof PersistenceError) ||
        !["REVISION_CONFLICT", "SCRIPT_REVIEW_REQUIRED", "EPISODE_SET_INVALID", "VALIDATION_ERROR",
          "MOCK_SCENE_SLOT_OCCUPIED", "MOCK_SHOT_SLOT_OCCUPIED", "REVIEW_REQUIRED", "SOURCE_STALE"].includes(error.code)) {
      throw error;
    }
    await jobs.failJob({ workspaceId: execution.workspaceId, jobId: execution.jobId,
      attemptId, traceId, errorCode: error.code, errorMessage: error.message, retryable: false });
  }
}
