"""Select and freeze the actual Simplified Chinese font face used for captions.

TTC face zero is often Japanese. Extracting the explicitly named SC face into a
standalone SFNT file lets FFmpeg use that exact face with no fontconfig fallback.
The SFNT/TTC reader uses only the Python standard library.
"""

from __future__ import annotations

import hashlib
import struct
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from media_worker.compose_cli import ComposeFailure, _directory

FAMILY = "Noto Sans CJK SC"
MAX_FONT_BYTES = 64 * 1024 * 1024
DEFAULT_FONT_PATHS = (
    Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"),
    Path("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc"),
    Path("/usr/local/share/fonts/NotoSansCJKsc-Regular.otf"),
)


@dataclass(frozen=True)
class VoiceFont:
    path: Path
    family: str
    sha256: str
    source_sha256: str
    source_face_index: int


def _unavailable() -> None:
    raise ComposeFailure("COMPOSE_FONT_UNAVAILABLE", False)


def _u16(data: bytes, offset: int) -> int:
    return struct.unpack_from(">H", data, offset)[0]


def _u32(data: bytes, offset: int) -> int:
    return struct.unpack_from(">I", data, offset)[0]


def _face_offsets(data: bytes) -> list[int]:
    if data[:4] == b"ttcf":
        count = _u32(data, 8)
        if not 1 <= count <= 64 or 12 + count * 4 > len(data):
            _unavailable()
        return [_u32(data, 12 + index * 4) for index in range(count)]
    return [0]


def _tables(data: bytes, offset: int) -> tuple[bytes, dict[bytes, bytes]]:
    scaler = data[offset:offset + 4]
    if scaler not in (b"OTTO", b"\0\1\0\0", b"true"):
        _unavailable()
    count = _u16(data, offset + 4)
    if not 1 <= count <= 512 or offset + 12 + count * 16 > len(data):
        _unavailable()
    tables = {}
    for index in range(count):
        record = offset + 12 + index * 16
        tag = data[record:record + 4]
        location, length = _u32(data, record + 8), _u32(data, record + 12)
        if tag in tables or location + length > len(data):
            _unavailable()
        tables[tag] = data[location:location + length]
    return scaler, tables


def _families(name: bytes) -> set[str]:
    count, storage = _u16(name, 2), _u16(name, 4)
    if count > 4096 or 6 + count * 12 > len(name):
        _unavailable()
    families = set()
    for index in range(count):
        offset = 6 + index * 12
        platform, encoding, _language, name_id, length, relative = struct.unpack_from(">6H", name, offset)
        if name_id not in (1, 16):
            continue
        raw = name[storage + relative:storage + relative + length]
        if len(raw) != length:
            _unavailable()
        if platform == 0 or platform == 3 and encoding in (0, 1, 10):
            families.add(raw.decode("utf-16-be", errors="strict"))
        elif platform == 1:
            families.add(raw.decode("mac_roman", errors="strict"))
    return families


def _cmap_subtable(cmap: bytes) -> bytes:
    count = _u16(cmap, 2)
    if count > 128 or 4 + count * 8 > len(cmap):
        _unavailable()
    candidates = []
    for index in range(count):
        platform, encoding, offset = struct.unpack_from(">HHI", cmap, 4 + index * 8)
        if platform != 0 and not (platform == 3 and encoding in (1, 10)):
            continue
        form = _u16(cmap, offset)
        if form == 12:
            length = _u32(cmap, offset + 4)
            priority = 2
        elif form == 4:
            length = _u16(cmap, offset + 2)
            priority = 1
        else:
            continue
        if offset + length > len(cmap):
            _unavailable()
        candidates.append((priority, cmap[offset:offset + length]))
    if not candidates:
        _unavailable()
    return max(candidates, key=lambda entry: entry[0])[1]


def _glyph(cmap: bytes, codepoint: int) -> int:
    if _u16(cmap, 0) == 12:
        count = _u32(cmap, 12)
        if count > 1_000_000 or 16 + count * 12 > len(cmap):
            _unavailable()
        low, high = 0, count - 1
        while low <= high:
            index = (low + high) // 2
            start, end, glyph = struct.unpack_from(">III", cmap, 16 + index * 12)
            if codepoint < start:
                high = index - 1
            elif codepoint > end:
                low = index + 1
            else:
                return glyph + codepoint - start
        return 0
    if codepoint > 0xFFFF:
        return 0
    count = _u16(cmap, 6) // 2
    if count <= 0 or 16 + count * 8 > len(cmap):
        _unavailable()
    ends, starts, deltas, ranges = 14, 16 + count * 2, 16 + count * 4, 16 + count * 6
    for index in range(count):
        end, start = _u16(cmap, ends + index * 2), _u16(cmap, starts + index * 2)
        if start <= codepoint <= end:
            delta = _u16(cmap, deltas + index * 2)
            word = ranges + index * 2
            relative = _u16(cmap, word)
            if not relative:
                return (codepoint + delta) & 0xFFFF
            glyph = _u16(cmap, word + relative + (codepoint - start) * 2)
            return (glyph + delta) & 0xFFFF if glyph else 0
    return 0


def _checksum(data: bytes) -> int:
    padded = data + b"\0" * (-len(data) % 4)
    return sum(value[0] for value in struct.iter_unpack(">I", padded)) & 0xFFFFFFFF


def _standalone(scaler: bytes, tables: dict[bytes, bytes]) -> bytes:
    # TTC signatures cover the original container and are intentionally omitted
    # from the extracted face. The actual staged face gets its own content hash.
    selected = {tag: bytes(value) for tag, value in tables.items() if tag != b"DSIG"}
    if b"head" not in selected or len(selected[b"head"]) < 12:
        _unavailable()
    head = bytearray(selected[b"head"])
    head[8:12] = b"\0" * 4
    selected[b"head"] = bytes(head)
    count = len(selected)
    exponent = count.bit_length() - 1
    header = scaler + struct.pack(">4H", count, (1 << exponent) * 16, exponent, count * 16 - (1 << exponent) * 16)
    location = 12 + count * 16
    directory, body, head_location = bytearray(), bytearray(), 0
    for tag, content in sorted(selected.items()):
        directory.extend(tag + struct.pack(">3I", _checksum(content), location, len(content)))
        if tag == b"head":
            head_location = location
        padded = content + b"\0" * (-len(content) % 4)
        body.extend(padded)
        location += len(padded)
    result = bytearray(header + directory + body)
    result[head_location + 8:head_location + 12] = struct.pack(">I", (0xB1B0AFBA - _checksum(result)) & 0xFFFFFFFF)
    return bytes(result)


def select_font_face(data: bytes, text: str) -> tuple[bytes, int]:
    """Return only the explicitly named SC face, with every printable glyph."""
    try:
        for index, offset in enumerate(_face_offsets(data)):
            scaler, tables = _tables(data, offset)
            if FAMILY not in _families(tables.get(b"name", b"")):
                continue
            cmap = _cmap_subtable(tables.get(b"cmap", b""))
            count = _u16(tables.get(b"maxp", b""), 4)
            for character in set(text):
                if character.isspace() or unicodedata.category(character).startswith("C"):
                    continue
                glyph = _glyph(cmap, ord(character))
                if not 0 < glyph < count:
                    _unavailable()
            return _standalone(scaler, tables), index
    except (struct.error, UnicodeError, ValueError, IndexError, OverflowError) as error:
        raise ComposeFailure("COMPOSE_FONT_UNAVAILABLE", False) from error
    _unavailable()


def find_voice_font(operator_path: Path | None = None) -> Path:
    candidates = (operator_path,) if operator_path is not None else DEFAULT_FONT_PATHS
    for path in candidates:
        if path is not None and path.is_absolute() and path.is_file() and not path.is_symlink():
            try:
                _directory(path.parent)
                return path
            except ComposeFailure:
                continue
    _unavailable()


def stage_voice_font(root: Path, text: str, operator_path: Path | None = None) -> VoiceFont:
    path = find_voice_font(operator_path)
    try:
        size = path.stat().st_size
        if not 1 <= size <= MAX_FONT_BYTES:
            _unavailable()
        with path.open("rb") as source:
            original = source.read(MAX_FONT_BYTES + 1)
        if len(original) != size:
            _unavailable()
        face, index = select_font_face(original, text)
        target = root / ("voice-font.otf" if face[:4] == b"OTTO" else "voice-font.ttf")
        with target.open("xb") as destination:
            destination.write(face)
    except (OSError, ValueError) as error:
        raise ComposeFailure("COMPOSE_FONT_UNAVAILABLE", False) from error
    return VoiceFont(target, FAMILY, hashlib.sha256(face).hexdigest(), hashlib.sha256(original).hexdigest(), index)
