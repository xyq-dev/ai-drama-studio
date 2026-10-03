export const MOCK_MEDIA_JOB_KINDS = ["MEDIA_IMAGE", "MEDIA_VIDEO", "MEDIA_TTS", "MEDIA_SUBTITLE", "MEDIA_MUSIC"] as const;

export type MockMediaJobKind = (typeof MOCK_MEDIA_JOB_KINDS)[number];

export const MOCK_MEDIA_ROUTES = {
  MEDIA_IMAGE: {
    capability: "image.generate",
    assetKind: "IMAGE",
    mimeType: "image/png",
    schema: "m3.mock.image.v1",
  },
  MEDIA_VIDEO: {
    capability: "video.generate",
    assetKind: "VIDEO",
    mimeType: "video/mp4",
    schema: "m3.mock.video.v1",
  },
  MEDIA_TTS: {
    capability: "audio.tts",
    assetKind: "AUDIO",
    mimeType: "audio/wav",
    schema: "m3.mock.tts.v1",
  },
  MEDIA_SUBTITLE: {
    capability: "subtitle.generate",
    assetKind: "SUBTITLE",
    mimeType: "text/vtt",
    schema: "m3.mock.subtitle.v1",
  },
  MEDIA_MUSIC: {
    capability: "audio.music",
    assetKind: "MUSIC",
    mimeType: "audio/wav",
    schema: "m3.mock.music.v1",
  },
} as const;

export function isMockMediaJobKind(kind: string): kind is MockMediaJobKind {
  return Object.prototype.hasOwnProperty.call(MOCK_MEDIA_ROUTES, kind);
}

export function mockMediaRoute(kind: string): (typeof MOCK_MEDIA_ROUTES)[MockMediaJobKind] | null {
  return isMockMediaJobKind(kind) ? MOCK_MEDIA_ROUTES[kind] : null;
}
