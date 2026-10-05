"""Local encode timing and process counters.

Amounts stay unknown until a rate exists. A missing counter stays null.
"""

from __future__ import annotations

import time


def measure_local_encode(started: float) -> dict[str, object]:
    measurement: dict[str, object] = {
        "elapsedMs": int((time.monotonic() - started) * 1000),
        "userCpuMs": None,
        "systemCpuMs": None,
        "maxRss": None,
        "productionCost": {"amount": None, "currency": None, "status": "unknown"},
    }
    try:
        import resource
    except ImportError:
        return measurement
    usage = resource.getrusage(resource.RUSAGE_SELF)
    measurement["userCpuMs"] = int(usage.ru_utime * 1000)
    measurement["systemCpuMs"] = int(usage.ru_stime * 1000)
    measurement["maxRss"] = int(usage.ru_maxrss)
    return measurement
