# encoding: utf-8
"""
Unit tests for calculate_hours() - Etap B buffer-state algorithm.
Run: python test_calculate_hours.py
"""
import sys
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch, MagicMock

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "stub-key")

# Stub modules that require native libraries
sys.modules.setdefault("face_recognition", MagicMock())

import process_events as pe

BASE_TS = datetime(2026, 5, 1, 8, 0, 0, tzinfo=timezone.utc)
EMP_ID  = "emp-001"

def ts(offset_hours: float = 0.0) -> str:
    return (BASE_TS + timedelta(hours=offset_hours)).isoformat().replace("+00:00", "Z")

def make_ev(event_type: str, offset_hours: float, eid: str) -> dict:
    return {"id": eid, "event_type": event_type, "photo_timestamp": ts(offset_hours)}

def dep(offset_hours: float) -> dict:
    return {"event_type": "departure", "photo_timestamp": ts(offset_hours)}


PASS = 0
FAIL = 0

def check(name: str, got, expected):
    global PASS, FAIL
    ok = got == expected
    status = "OK  " if ok else "FAIL"
    print(f"  [{status}] {name}")
    if not ok:
        print(f"         expected: {expected}")
        print(f"         got:      {got}")
    if ok:
        PASS += 1
    else:
        FAIL += 1


# S1: arrival event type always returns all-None
with patch.object(pe, "sb_get", return_value=[]):
    result = pe.calculate_hours(EMP_ID, {"event_type": "arrival", "photo_timestamp": ts(0)})
    check("S1 arrival -> (None,None,False,False)", result, (None, None, False, False))


# S2: normal pair arr->dep
arr_id = "arr-001"
history_s2 = [make_ev("arrival", 0.0, arr_id)]

with patch.object(pe, "sb_get", return_value=history_s2):
    hours, paired_id, is_double, is_dup = pe.calculate_hours(EMP_ID, dep(9.0))
    check("S2 hours=9.0",             hours,     9.0)
    check("S2 paired_id=arr-001",     paired_id, arr_id)
    check("S2 is_double_shift=False", is_double, False)
    check("S2 is_duplicate=False",    is_dup,    False)


# S3: duplicate departure (arr->dep already closed, another dep comes in)
history_s3 = [
    make_ev("arrival",   0.0, "arr-001"),
    make_ev("departure", 9.0, "dep-001"),
]
with patch.object(pe, "sb_get", return_value=history_s3):
    h, pid, dbl, dup = pe.calculate_hours(EMP_ID, dep(10.0))
    check("S3 hours=None",          h,   None)
    check("S3 paired_id=None",      pid, None)
    check("S3 is_double=False",     dbl, False)
    check("S3 is_duplicate=True",   dup, True)


# S4: double shift arr1->dep1->arr2->dep2(current)
arr2_id = "arr-002"
history_s4 = [
    make_ev("arrival",    0.0, "arr-001"),
    make_ev("departure",  9.0, "dep-001"),
    make_ev("arrival",   10.0, arr2_id),
]
with patch.object(pe, "sb_get", return_value=history_s4):
    hours, paired_id, is_double, is_dup = pe.calculate_hours(EMP_ID, dep(19.0))
    check("S4 hours=9.0",              hours,     9.0)
    check("S4 paired_id=arr-002",      paired_id, arr2_id)
    check("S4 is_double_shift=True",   is_double, True)
    check("S4 is_duplicate=False",     is_dup,    False)


total = PASS + FAIL
print(f"\n{'='*40}")
print(f"Results: {PASS}/{total} passed  {'ALL OK' if FAIL == 0 else 'FAILURES!'}")
if FAIL:
    sys.exit(1)
