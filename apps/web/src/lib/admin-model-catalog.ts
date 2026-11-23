import { WRITING_MODEL_CHANNELS, type TitleWritingProviderKey } from "@ai-drama/contracts";

/** The legacy allowlist editor uses name/note fields; selectable IDs come from the channel catalog. */
export type ModelCandidate = { id: string; name: string; note: string };

function legacyCandidates(provider: TitleWritingProviderKey): ModelCandidate[] {
  return WRITING_MODEL_CHANNELS[provider].models.map(({ id, label }) => ({ id, name: label, note: "" }));
}

export const MODEL_CANDIDATES: Readonly<Record<TitleWritingProviderKey, readonly ModelCandidate[]>> = {
  openai: legacyCandidates("openai"),
  anthropic: legacyCandidates("anthropic"),
  deepseek: legacyCandidates("deepseek"),
};

export function candidateFor(providerKey: TitleWritingProviderKey, id: string): ModelCandidate | undefined {
  return MODEL_CANDIDATES[providerKey].find((candidate) => candidate.id === id);
}
