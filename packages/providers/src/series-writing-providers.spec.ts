import { describe, expect, it } from "vitest";
import {
  AUTO_CREATION_PROMPT_VERSION,
  SERIES_PROMPT_MAX_CHARS,
  SERIES_WRITING_CHECKS_VERSION,
  SERIES_WRITING_PROMPT_VERSION,
  autoCreationJsonSchema,
  seriesJsonSchema,
  seriesNormalCalls,
} from "@ai-drama/contracts";
import { ANTHROPIC_MESSAGES_URL, ANTHROPIC_THINKING_HEADROOM_TOKENS, DEEPSEEK_CHAT_COMPLETIONS_URL, OPENAI_RESPONSES_URL, TEXT_WRITING_MAX_OUTPUT_TOKENS, claudeJsonSchema } from "./text-writing";
import { ALL, seriesSetup } from "./series-writing-test-kit";
import type { SeriesFixtureExchange } from "./series-writing-fixtures";

/**
 * What OpenAI, Claude and DeepSeek would actually receive, built by the real adapters and intercepted by the transport
 * (no network, no real model service): the schema of each stage, the versions, the scope of each prompt and the limits.
 */

function sentSchema(exchange: SeriesFixtureExchange): Record<string, unknown> {
  const body = exchange.body as { text?: { format: { schema: Record<string, unknown> } }; output_config?: { format: { schema: Record<string, unknown> } };
    messages?: Array<{ role: string; content: string }> };
  if (body.text) return body.text.format.schema;
  if (body.output_config) return body.output_config.format.schema;
  const system = body.messages!.find((message) => message.role === "system")!.content;
  return JSON.parse(system.slice(system.indexOf("JSON Schema：\n") + "JSON Schema：\n".length)) as Record<string, unknown>;
}

describe("the requests the real adapters build for a series", () => {
  it.each([
    ["openai", OPENAI_RESPONSES_URL],
    ["anthropic", ANTHROPIC_MESSAGES_URL],
    ["deepseek", DEEPSEEK_CHAT_COMPLETIONS_URL],
  ] as const)("%s: every stage carries its own schema, the frozen model, the series versions and the output limit", async (providerKey, url) => {
    const { seen, view, grant } = await seriesSetup({ episodes: 7, providerKey });
    await grant(ALL(7));
    expect((await view()).completion).toBe("text_complete");
    expect(seen).toHaveLength(seriesNormalCalls(7));
    for (const exchange of seen) {
      expect(exchange.url).toBe(url);
      const research = exchange.stage === "research" || exchange.stage === "directions";
      const expected = research
        ? autoCreationJsonSchema(exchange.stage as "research" | "directions", 7, exchange.stage === "research" ? "limited" : null).schema
        : seriesJsonSchema(exchange.stage, 7).schema;
      expect(sentSchema(exchange)).toEqual(providerKey === "anthropic" ? claudeJsonSchema(expected) : expected);
      const body = exchange.body as Record<string, unknown>;
      expect(body.model).toBe("m-1");
      if (providerKey === "openai") expect(body).toMatchObject({ max_output_tokens: TEXT_WRITING_MAX_OUTPUT_TOKENS, store: false, text: { format: { strict: true } } });
      if (providerKey === "anthropic") expect(body.max_tokens).toBe(TEXT_WRITING_MAX_OUTPUT_TOKENS + ANTHROPIC_THINKING_HEADROOM_TOKENS);
      if (providerKey === "deepseek") expect(body).toMatchObject({ max_tokens: TEXT_WRITING_MAX_OUTPUT_TOKENS, response_format: { type: "json_object" }, stream: false });
      expect(exchange.user.length + exchange.system.length).toBeLessThanOrEqual(SERIES_PROMPT_MAX_CHARS);
      if (research) expect(exchange.user).toContain(`提示版本：${AUTO_CREATION_PROMPT_VERSION}`);
      else if (exchange.stage.includes("review")) expect(exchange.user).toContain(SERIES_WRITING_CHECKS_VERSION);
      else expect(exchange.user).toContain(`提示版本：${SERIES_WRITING_PROMPT_VERSION}`);
      // No key, token or connection string ever enters a prompt.
      expect(exchange.user + exchange.system).not.toMatch(/sk-|postgres:\/\/|Bearer/u);
    }
  });

  it("each prompt reads only its own scope: one episode's neighbours, one batch's texts, and no episode text in the final review", async () => {
    const { seen, grant } = await seriesSetup({ episodes: 12 });
    await grant(ALL(12));
    const episode5 = seen.find((item) => item.stage === "episode:5")!.user;
    expect(episode5).toContain("第4集《");
    expect(episode5).toContain("第6集《");
    expect(episode5).not.toContain("第7集《");
    expect(episode5).not.toContain("第1集《");
    expect(episode5).toContain("全剧共 12 集");
    expect(episode5).toContain("每集计划篇幅约 60 秒");
    const batch2 = seen.find((item) => item.stage === "batch_review:2")!.user;
    expect([4, 5, 6].every((number) => batch2.includes(`<<<待审：episode:${String(number)}`))).toBe(true);
    expect(batch2).not.toContain("<<<待审：episode:3");
    expect(batch2).toContain("完整阅读本批每一集的当前正文");
    const final = seen.find((item) => item.stage === "final_review")!.user;
    expect(final).toContain("不读取各集正文");
    expect(final).not.toContain("<<<待审：episode:");
    expect(final).toContain("第12集：");
    const plan = seen.find((item) => item.stage === "plan_review")!.user;
    expect(Array.from({ length: 12 }, (_, index) => plan.includes(`第${String(index + 1)}集《`)).every(Boolean)).toBe(true);
  });
});
