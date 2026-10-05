import time

from media_worker.encode_measurement import measure_local_encode


def test_local_encode_measurement_keeps_cost_unknown() -> None:
    started = time.monotonic()
    time.sleep(0.01)
    measured = measure_local_encode(started)
    assert int(measured["elapsedMs"]) >= 0
    assert measured["productionCost"] == {"amount": None, "currency": None, "status": "unknown"}
    assert measured["productionCost"]["amount"] is None
