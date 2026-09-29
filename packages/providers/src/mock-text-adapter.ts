import type { SceneBatchOutput, ShotBatchOutput, TextAdapterResult, TextGenerationAdapter,
  TextGenerationRequest } from "@ai-drama/contracts";

export class MockTextAdapter implements TextGenerationAdapter {
  readonly providerKey = "mock-text";
  readonly replayPolicy = "REPLAY_SAFE_SYNC";

  async generate(request: TextGenerationRequest): Promise<TextAdapterResult> {
    let output: SceneBatchOutput | ShotBatchOutput;
    if (request.kind === "SCENES") {
      output = { schema: "m2.text.scenes.output.v1", scenes: request.sources.map((source) => ({
        projectId: request.projectId, episodeId: source.episodeId, episodeNo: source.episodeNo,
        sourceScriptRevisionId: source.scriptRevisionId, ordinal: 1,
        heading: `Episode ${source.episodeNo} · Opening`,
        summary: `Mock draft based on approved Script revision ${source.scriptRevisionId}.`,
      })) };
    } else {
      output = { schema: "m2.text.shots.output.v1", shots: request.sources.map((source) => ({
        projectId: request.projectId, episodeId: source.episodeId, episodeNo: source.episodeNo,
        sceneId: source.sceneId, sourceSceneRevisionId: source.sceneRevisionId, ordinal: 1,
        shotType: "WIDE", camera: "static", action: `Opening beat for episode ${source.episodeNo}.`,
        promptText: `Mock storyboard frame based on approved Scene revision ${source.sceneRevisionId}.`,
      })) };
    }
    return { kind: "succeeded", output };
  }
}
