import { Body, Controller, Header, HttpCode, Inject, Param, Post, Res } from "@nestjs/common";
import { creatorAgentResolveRequestSchema } from "@ai-drama/contracts";
import { PersistenceError, storeOwnerAccountFilter } from "@ai-drama/database";
import { FEATURE_CONFIG_SERVICE } from "../admin/feature-config.controller";
import type { FeatureConfigService } from "../admin/feature-config.service";
import { chooseCreatorSkill, targetsOtherEpisode } from "./creator-assistant-intent";
import type { StudioService } from "./studio.service";
import { STUDIO_SERVICE } from "./tokens";

@Controller("projects/:projectId/assistant")
export class CreatorAssistantController {
  constructor(
    @Inject(STUDIO_SERVICE) private readonly studio: Pick<StudioService, "getProject">,
    @Inject(FEATURE_CONFIG_SERVICE) private readonly features: Pick<FeatureConfigService, "skillEnabled"> | null,
  ) {}

  @Post("resolve")
  @HttpCode(200)
  @Header("Cache-Control", "private, no-store")
  async resolve(@Param("projectId") projectId: string, @Body() body: unknown,
    @Res({ passthrough: true }) response: { status(code: number): void }) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(projectId)) {
      throw new PersistenceError("VALIDATION_ERROR", "Invalid project ID");
    }
    await this.studio.getProject(projectId, storeOwnerAccountFilter());
    const input = creatorAgentResolveRequestSchema.safeParse(body);
    if (!input.success) throw new PersistenceError("VALIDATION_ERROR", "Invalid assistant instruction");
    const { skill: explicit, command, stage, episodeNo } = input.data;
    if (episodeNo && targetsOtherEpisode(command, episodeNo)) {
      response.status(409);
      return { error: { code: "CREATOR_SKILL_EPISODE_MISMATCH", message: "请先切换到指令指定的集数。" } };
    }
    const skill = explicit ?? chooseCreatorSkill(command, stage);
    if (skill && this.features && !(await this.features.skillEnabled(skill))) {
      response.status(409);
      return { error: { code: "CREATOR_SKILL_DISABLED", message: "这个技能已停用，请选择其他操作。" } };
    }
    return { skill, instruction: command };
  }
}
