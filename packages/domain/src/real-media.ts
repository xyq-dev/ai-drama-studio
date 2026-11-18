import { createHash } from "node:crypto";
import { isAutoStoryboardImageConfiguration,type RealMediaCapability,type RealMediaConfiguration,type RealMediaSnapshot } from "@ai-drama/contracts";
import { DomainError } from "./errors";
import { isChineseVideoPrompt } from "./auto-creation-media-capability";

const SCALE = 100_000_000n;
export function realMediaAmountUnits(value: string): bigint {
  if (!/^(0|[1-9]\d{0,7})(\.\d{1,8})?$/.test(value)) throw new DomainError("VALIDATION_ERROR", "Invalid media amount");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(8, "0"));
}
export function realMediaAmount(value: bigint): string {
  if (value < 0) throw new DomainError("VALIDATION_ERROR", "Invalid media amount");
  return `${value / SCALE}.${(value % SCALE).toString().padStart(8, "0")}`;
}
export function estimateRealMedia(configuration: RealMediaConfiguration, text: string): string {
  if (configuration.providerKey === "elevenlabs-media" && configuration.capability === "audio.tts") {
    throw new DomainError("VALIDATION_ERROR", "Music configuration cannot price speech");
  }
  if (configuration.providerKey === "elevenlabs-tts") {
    if (configuration.capability !== "audio.tts" || configuration.model !== "eleven_v4" || configuration.unitType !== "character") {
      throw new DomainError("VALIDATION_ERROR", "ElevenLabs speech is priced only as eleven_v4 characters");
    }
    const spoken = BigInt([...text].length);
    if (spoken < 1 || spoken > 100_000) throw new DomainError("VALIDATION_ERROR", "Invalid media quantity");
    return realMediaAmount(realMediaAmountUnits(configuration.unitPrice) * spoken);
  }
  if (configuration.providerKey === "minimax-tts") {
    if (configuration.capability !== "audio.tts" || configuration.model !== "speech-2.8-hd" || configuration.unitType !== "character") {
      throw new DomainError("VALIDATION_ERROR", "MiniMax speech is priced only as speech-2.8-hd characters");
    }
    const spoken = BigInt([...text].length);
    if (spoken < 1 || spoken > 100_000) throw new DomainError("VALIDATION_ERROR", "Invalid media quantity");
    return realMediaAmount(realMediaAmountUnits(configuration.unitPrice) * spoken);
  }
  const quantity = configuration.unitType === "character" ? BigInt([...text].length * 2)
    : configuration.unitType === "second" ? BigInt(Number(configuration.parameters.duration ?? 5)) : 1n;
  if (quantity < 1 || quantity > 100_000) throw new DomainError("VALIDATION_ERROR", "Invalid media quantity");
  return realMediaAmount(realMediaAmountUnits(configuration.unitPrice) * quantity);
}
export function realMediaInputHash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}
export function realMediaJobKind(capability: RealMediaCapability): "MEDIA_IMAGE" | "MEDIA_VIDEO" | "MEDIA_TTS" | "MEDIA_MUSIC" {
  return ({ "image.generate": "MEDIA_IMAGE", "video.generate": "MEDIA_VIDEO", "audio.tts": "MEDIA_TTS", "audio.music": "MEDIA_MUSIC" } as const)[capability];
}
/** Mirrors the fixed pilot profiles before quote/intent; provider adapters remain responsible for their own validation. */
export function assertRealMediaInput(input:Omit<RealMediaSnapshot,"budget">):void{
  const config=input.configuration;const text=input.sourceText;
  if(!text.trim()||config.capability!==input.capability)throw new DomainError("VALIDATION_ERROR","Media source is empty or mismatched");
  if(input.autoStoryboard&&(!isAutoStoryboardImageConfiguration(config)||input.sourceImage||input.comfyui||input.speech||input.dialogue||input.minimaxSpeech)){
    throw new DomainError("AUTO_STORYBOARD_OPENAI_UNAVAILABLE","Auto storyboard images require the configured OpenAI image profile");
  }
  if(input.capability==="video.generate"&&input.characterReferenceGate==="strict")throw new DomainError("REAL_MEDIA_REFERENCE_PROFILE_UNSUPPORTED","The fixed first-frame video profile cannot prove strict selected character references");
  if(input.capability==="image.generate"&&text.length>2000)throw new DomainError("VALIDATION_ERROR","Image prompt exceeds 2000 characters");
  if(input.capability==="video.generate"){
    if(!input.sourceImage||text.length>800)throw new DomainError("VALIDATION_ERROR","Video requires a first frame and a prompt of at most 800 characters");
    if(!isChineseVideoPrompt(text))throw new DomainError("VALIDATION_ERROR","Video generation prompts must be Chinese");
  }
  if(input.capability==="audio.music"&&text.length>4100)throw new DomainError("VALIDATION_ERROR","Music prompt exceeds 4100 characters");
  if(input.capability==="audio.tts"&&config.providerKey==="elevenlabs-tts"){
    throw new DomainError("REAL_MEDIA_TTS_PATH_UNSUPPORTED","ElevenLabs eleven_v4 scene dialogue is not submitted through the per-line website worker");
  }
  if(input.capability==="audio.tts"&&config.providerKey==="minimax-tts"){
    // Official website path: MiniMax speech-2.8-hd with minimaxSpeech. Never fall back to ElevenLabs or Bailian.
    if(config.model!=="speech-2.8-hd"){
      throw new DomainError("REAL_MEDIA_TTS_PATH_UNSUPPORTED","Official website speech accepts only MiniMax speech-2.8-hd");
    }
    const block=input.minimaxSpeech;
    if(!block||block.schema!=="minimax-tts.speech.v1"||block.text!==text||!block.voiceId.trim()){
      throw new DomainError("REAL_MEDIA_TTS_PATH_UNSUPPORTED","MiniMax speech-2.8-hd requires a minimaxSpeech block on the website path and does not fall back to ElevenLabs or Bailian");
    }
    if([...text].length>2_000)throw new DomainError("VALIDATION_ERROR","Speech supports at most 2000 characters for MiniMax speech-2.8-hd on the website path");
    if(input.speech&&(input.speech.spokenText!==text||input.speech.emotion!=="neutral"||input.speech.speed!==1
      ||input.speech.voice.voiceId!==block.voiceId||input.speech.voice.providerKey!=="minimax-tts"
      ||input.speech.voice.model!=="speech-2.8-hd")){
      throw new DomainError("VALIDATION_ERROR","MiniMax website speech requires neutral normal-speed delivery matching minimaxSpeech");
    }
    if(input.dialogue)throw new DomainError("VALIDATION_ERROR","MiniMax speech does not accept an ElevenLabs dialogue block");
    return;
  }
  if(input.capability==="audio.tts"){
    // Legacy Bailian per-line path. Official commercial voice is MiniMax only.
    const speech=input.speech;
    if([...text].length>600||!["Cherry","Ethan","Serena"].includes(String(speech?.voice.voiceId??config.parameters.voice??"Cherry"))
      ||(speech&&(speech.spokenText!==text||speech.emotion!=="neutral"||speech.speed!==1)))throw new DomainError("VALIDATION_ERROR","Speech supports at most 600 characters, a catalog voice and neutral normal-speed delivery");
  }
}
