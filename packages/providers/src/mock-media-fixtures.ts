import { createHash } from "node:crypto";

// Fixed Mock fixtures. The MP4 is the offline preflight H.264 Constrained Baseline clip:
// ffmpeg 6.1.1, lavfi color=c=black:s=16x16:r=5:d=1, 5 frames, yuv420p, avc1, faststart, no audio.
// ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=16x16:r=5:d=1 -frames:v 5 -c:v libx264 -profile:v baseline -level:v 3.0 -pix_fmt yuv420p -movflags +faststart -an h264-baseline-16x16-5frames.mp4
// Probe and Chrome 154 playback: 16x16, 1000 ms, 5 frames, ended. It is a black test clip, not AI video.
// The WAV remains 100 ms of mono PCM16 silence at 8 kHz. It does not speak the saved dialogue.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYGAAAAAEAAH2FzhVAAAAAElFTkSuQmCC";
const H264_MP4 = "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAM3bW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAmF0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAABAAAAAQAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAHZbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAAoAAAAKABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAABhG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAURzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAABAAEABIAAAASAAAAAAAAAABFUxhdmM2MC4zMS4xMDIgbGlieDI2NAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAe/+EAFmdCwB7ZHsBEAAADAAQAAAMAKDxYuSABAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAABVIAAAVSAAAABhzdHRzAAAAAAAAAAEAAAAFAAAIAAAAABRzdHNzAAAAAAAAAAEAAAABAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAFAAAAAQAAAChzdHN6AAAAAAAAAAAAAAAFAAACgwAAAAoAAAAKAAAACQAAAAkAAAAUc3RjbwAAAAAAAAABAAADZwAAAGJ1ZHRhAAAAWm1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALWlsc3QAAAAlqXRvbwAAAB1kYXRhAAAAAQAAAABMYXZmNjAuMTYuMTAwAAAACGZyZWUAAAKxbWRhdAAAAnAGBf//bNxF6b3m2Ui3lizYINkj7u94MjY0IC0gY29yZSAxNjQgcjMxMDggMzFlMTlmOSAtIEguMjY0L01QRUctNCBBVkMgY29kZWMgLSBDb3B5bGVmdCAyMDAzLTIwMjMgLSBodHRwOi8vd3d3LnZpZGVvbGFuLm9yZy94MjY0Lmh0bWwgLSBvcHRpb25zOiBjYWJhYz0wIHJlZj0zIGRlYmxvY2s9MTowOjAgYW5hbHlzZT0weDE6MHgxMTEgbWU9aGV4IHN1Ym1lPTcgcHN5PTEgcHN5X3JkPTEuMDA6MC4wMCBtaXhlZF9yZWY9MSBtZV9yYW5nZT0xNiBjaHJvbWFfbWU9MSB0cmVsbGlzPTEgOHg4ZGN0PTAgY3FtPTAgZGVhZHpvbmU9MjEsMTEgZmFzdF9wc2tpcD0xIGNocm9tYV9xcF9vZmZzZXQ9LTIgdGhyZWFkcz0xIGxvb2thaGVhZF90aHJlYWRzPTEgc2xpY2VkX3RocmVhZHM9MCBucj0wIGRlY2ltYXRlPTEgaW50ZXJsYWNlZD0wIGJsdXJheV9jb21wYXQ9MCBjb25zdHJhaW5lZF9pbnRyYT0wIGJmcmFtZXM9MCB3ZWlnaHRwPTAga2V5aW50PTI1MCBrZXlpbnRfbWluPTUgc2NlbmVjdXQ9NDAgaW50cmFfcmVmcmVzaD0wIHJjX2xvb2thaGVhZD00MCByYz1jcmYgbWJ0cmVlPTEgY3JmPTIzLjAgcWNvbXA9MC42MCBxcG1pbj0wIHFwbWF4PTY5IHFwc3RlcD00IGlwX3JhdGlvPTEuNDAgYXE9MToxLjAwAIAAAAALZYiEBHyYoAA2I4AAAAAGQZo4CPqAAAAABkGaVAI+oAAAAAVBmmAQ9QAAAAVBmoA/1A==";

function silentWav(): Buffer {
  const samples = 800;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8000, 24);
  bytes.writeUInt32LE(16000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  return bytes;
}

const videoBytes = Buffer.from(H264_MP4, "base64");
const audioBytes = silentWav();

export const MOCK_VIDEO_FIXTURE = {
  mimeType: "video/mp4" as const,
  bytes: videoBytes,
  byteLength: videoBytes.length,
  checksumSha256: createHash("sha256").update(videoBytes).digest("hex"),
  width: 16,
  height: 16,
  durationMs: 1000,
};

export const MOCK_AUDIO_FIXTURE = {
  mimeType: "audio/wav" as const,
  bytes: audioBytes,
  byteLength: audioBytes.length,
  checksumSha256: createHash("sha256").update(audioBytes).digest("hex"),
  width: null,
  height: null,
  durationMs: 100,
};

export function mockMediaFixture(mimeType: string): Buffer {
  switch (mimeType) {
    case "image/png": return Buffer.from(PNG, "base64");
    case "video/mp4": return Buffer.from(MOCK_VIDEO_FIXTURE.bytes);
    case "audio/wav": return Buffer.from(MOCK_AUDIO_FIXTURE.bytes);
    case "application/json": return Buffer.from('{"valid":true,"source":"mock-media"}\n');
    case "text/vtt": return Buffer.from("WEBVTT\n\n00:00:00.000 --> 00:00:00.100\nMock subtitle\n");
    default: throw new Error(`Unsupported mock media MIME type: ${mimeType}`);
  }
}
