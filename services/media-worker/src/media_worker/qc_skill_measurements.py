"""FFmpeg measurement parsers from kajisho5/qc-skill 1.4.5.

Source: https://github.com/kajisho5/qc-skill/tree/df73a07105fba979192273cfb863dc72cbd634b6
Extracted from src/qc_skill/measurements/{video,audio}.py. The host bounds and
owns the FFmpeg process while reusing the upstream BLACK and SILENCE parsers.

MIT License

Copyright (c) 2026 kajisho5

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
"""

from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

_BLACK_RE = re.compile(
    r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)\s+black_duration:\s*([\d.]+)"
)
_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_END_RE = re.compile(r"silence_end:\s*(-?[\d.]+)\s*\|\s*silence_duration:\s*([\d.]+)")


def black_segments(stderr: str) -> list[dict[str, float]]:
    black_segments = []
    for match in _BLACK_RE.finditer(stderr):
        start, end, duration = (float(x) for x in match.groups())
        black_segments.append({"start": start, "end": end, "duration": duration})
    return black_segments


def silence_segments(stderr: str, duration_sec: Optional[float]) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    pending_start: Optional[float] = None

    # Interleave start/end events in the order they appear in stderr.
    tokens = []
    for m in _SILENCE_START_RE.finditer(stderr):
        tokens.append((m.start(), "start", float(m.group(1)), None))
    for m in _SILENCE_END_RE.finditer(stderr):
        tokens.append((m.start(), "end", float(m.group(1)), float(m.group(2))))
    tokens.sort(key=lambda t: t[0])

    for _, kind, value, duration in tokens:
        if kind == "start":
            pending_start = value
        else:
            end = value
            start = pending_start if pending_start is not None else max(end - (duration or 0.0), 0.0)
            events.append({"start": start, "end": end, "duration": duration})
            pending_start = None

    if pending_start is not None:
        end = duration_sec
        events.append(
            {
                "start": pending_start,
                "end": end,
                "duration": (end - pending_start) if end is not None else None,
            }
        )

    epsilon = 0.05
    for seg in events:
        if seg["start"] is not None and seg["start"] <= epsilon:
            seg["position"] = "leading"
        elif duration_sec is not None and seg["end"] is not None and seg["end"] >= duration_sec - epsilon:
            seg["position"] = "trailing"
        elif seg["end"] is None:
            seg["position"] = "trailing"
        else:
            seg["position"] = "internal"

    return events
