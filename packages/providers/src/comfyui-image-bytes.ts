import { COMFYUI_IMAGE_MAX_BYTES } from "./comfyui-workflows";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2]);
const MAX_REFERENCE_EDGE = 4096;

function invalid(): never {
  throw new Error("COMFYUI_IMAGE_BYTES_INVALID");
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
    bytes.length < 45 ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    invalid();
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  let offset = 33;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    offset += length + 12;
    if (offset > bytes.length) invalid();
    if (type === "IDAT" && length > 0) hasImageData = true;
    // ComfyUI's SaveImage is still PNG. Avoid animated reference uploads and animated output.
    if (type === "acTL" || type === "IHDR") invalid();
    if (type === "IEND" && hasImageData && length === 0 && offset === bytes.length)
      return { width, height };
  }
  return invalid();
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 12 ||
    bytes.readUInt16BE(0) !== 0xffd8 ||
    bytes.readUInt16BE(bytes.length - 2) !== 0xffd9
  )
    invalid();
  let offset = 2;
  let size: { width: number; height: number } | undefined;
  while (offset + 4 < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid();
    while (bytes[offset] === 0xff) offset += 1;
    if (offset + 3 >= bytes.length) invalid();
    const marker = bytes[offset++]!;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length >= bytes.length || marker === 0 || marker === 0xd9) invalid();
    if (marker === 0xda && size) return size;
    if (JPEG_SOF.has(marker)) {
      if (length < 8 || size) invalid();
      size = { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return invalid();
}

/** Bounded container and dimensions check. The Worker also decodes the image before use. */
export function assertComfyUiSourceImage(
  input: Uint8Array,
  mimeType: "image/png" | "image/jpeg",
): { width: number; height: number } {
  if (input.byteLength > COMFYUI_IMAGE_MAX_BYTES) invalid();
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const size =
    mimeType === "image/png"
      ? pngDimensions(bytes)
      : mimeType === "image/jpeg"
        ? jpegDimensions(bytes)
        : invalid();
  if (
    size.width < 1 ||
    size.height < 1 ||
    size.width > MAX_REFERENCE_EDGE ||
    size.height > MAX_REFERENCE_EDGE
  )
    invalid();
  return size;
}
