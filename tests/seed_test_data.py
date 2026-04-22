"""
Сидер тестовых данных — вставляет в Supabase синтетические события
для ручной проверки полного пайплайна.

Запуск:
  SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python tests/seed_test_data.py

Что создаёт:
  1. 3 тестовых сотрудника (если не существуют)
  2. Набор событий типа pending, покрывающих все ветки AI Worker:
     - полный день (приход + уход)        → ожидается: done
     - только приход                       → ожидается: needs_review (incomplete_day)
     - неизвестное имя                     → ожидается: needs_review (no employee match)
     - wrong_location флаг уже выставлен   → ожидается: needs_review (fraud_flags)
"""

import os
import json
import sys
import requests
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY  = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SERVICE_KEY:
    print("ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars.", file=sys.stderr)
    sys.exit(1)

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}

NOW_UTC   = datetime.now(timezone.utc)
TODAY_MSK = (NOW_UTC + timedelta(hours=3)).strftime("%Y-%m-%d")


def msk_to_utc(date_str: str, hh: int, mm: int = 0) -> str:
    """Создаёт UTC ISO-строку из МСК-времени."""
    msk = datetime.strptime(f"{date_str} {hh:02d}:{mm:02d}:00", "%Y-%m-%d %H:%M:%S")
    utc = msk - timedelta(hours=3)
    return utc.replace(tzinfo=timezone.utc).isoformat()


def get_or_create_employee(display_name: str, team: str, daily_rate: int) -> str:
    """Возвращает id существующего или только что созданного сотрудника."""
    res = requests.get(
        f"{SUPABASE_URL}/rest/v1/employees",
        headers=HEADERS,
        params={"display_name": f"ilike.{display_name}", "deleted_at": "is.null",
                "select": "id", "limit": 1},
        timeout=10,
    )
    rows = res.json()
    if isinstance(rows, list) and rows:
        eid = rows[0]["id"]
        print(f"  Existing employee: {display_name} ({eid})")
        return eid

    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/employees",
        headers={**HEADERS, "Prefer": "return=representation"},
        json={
            "display_name": display_name,
            "team":         team,
            "daily_rate":   daily_rate,
            "hourly_rate":  round(daily_rate / 8, 2),
        },
        timeout=10,
    )
    created = res.json()
    if isinstance(created, list) and created:
        eid = created[0]["id"]
        print(f"  Created employee: {display_name} ({eid})")
        return eid
    print(f"  WARN: Could not create employee {display_name}: {created}")
    return None


def insert_event(payload: dict) -> None:
    res = requests.post(
        f"{SUPABASE_URL}/rest/v1/events",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json=payload,
        timeout=10,
    )
    if res.status_code not in (200, 201):
        print(f"  WARN: insert_event failed {res.status_code}: {res.text}")


def main() -> None:
    print("=== Seed Test Data ===")
    print(f"Target: {SUPABASE_URL}")
    print(f"Today (MSK): {TODAY_MSK}\n")

    # ── 1. Создаём тестовых сотрудников ──────────────────────────────────────
    print("1. Employees:")
    emp_dima  = get_or_create_employee("ТестДима",   "Тестовая бригада", 2000)
    emp_ivan  = get_or_create_employee("ТестИван",   "Тестовая бригада", 1800)
    emp_olga  = get_or_create_employee("ТестОльга",  "Тестовая бригада", 2200)

    # ── 2. Вставляем события ─────────────────────────────────────────────────
    print("\n2. Events (pending):")

    # Сценарий A: полный день → ожидается status=done
    if emp_dima:
        insert_event({
            "employee_id":    None,   # AI Worker должен найти по имени
            "photo_timestamp": msk_to_utc(TODAY_MSK, 8, 0),
            "status":         "pending",
            "name_from_photo": "ТестДима",
            "event_type_raw":  "начало смены",
            "event_type":      "arrival",
            "fraud_flags":     json.dumps([]),
            "photo_url":       None,
        })
        insert_event({
            "employee_id":    None,
            "photo_timestamp": msk_to_utc(TODAY_MSK, 17, 30),
            "status":         "pending",
            "name_from_photo": "ТестДима",
            "event_type_raw":  "конец смены",
            "event_type":      "departure",
            "fraud_flags":     json.dumps([]),
            "photo_url":       None,
        })
        print("  [A] ТестДима: приход 08:00 + уход 17:30 → ожидается done, hours=9.5")

    # Сценарий B: только приход → ожидается needs_review (incomplete_day)
    if emp_ivan:
        insert_event({
            "employee_id":    None,
            "photo_timestamp": msk_to_utc(TODAY_MSK, 8, 15),
            "status":         "pending",
            "name_from_photo": "ТестИван",
            "event_type_raw":  "начало смены",
            "event_type":      "arrival",
            "fraud_flags":     json.dumps([]),
            "photo_url":       None,
        })
        print("  [B] ТестИван: только приход → ожидается needs_review (incomplete_day)")

    # Сценарий C: неизвестное имя → ожидается needs_review (no match)
    insert_event({
        "employee_id":    None,
        "photo_timestamp": msk_to_utc(TODAY_MSK, 9, 0),
        "status":         "pending",
        "name_from_photo": "ХХХНеизвестный999",
        "event_type_raw":  "начало смены",
        "event_type":      "arrival",
        "fraud_flags":     json.dumps([]),
        "photo_url":       None,
    })
    print("  [C] ХХХНеизвестный999: нет в базе → ожидается needs_review (no match)")

    # Сценарий D: wrong_location флаг → ожидается needs_review (fraud_flags)
    if emp_olga:
        insert_event({
            "employee_id":    None,
            "photo_timestamp": msk_to_utc(TODAY_MSK, 8, 45),
            "status":         "pending",
            "name_from_photo": "ТестОльга",
            "event_type_raw":  "начало смены",
            "event_type":      "arrival",
            "fraud_flags":     json.dumps(["wrong_location"]),
            "postcode_from_photo": "999999",
            "photo_url":       None,
        })
        print("  [D] ТестОльга: wrong_location → ожидается needs_review (fraud_flags)")

    # Сценарий E: нечёткое совпадение имени (опечатка OCR) → ожидается done
    if emp_dima:
        insert_event({
            "employee_id":    None,
            "photo_timestamp": msk_to_utc(TODAY_MSK, 7, 55),
            "status":         "pending",
            "name_from_photo": "ТестДмиа",  # опечатка OCR
            "event_type_raw":  "начало смены",
            "event_type":      "arrival",
            "fraud_flags":     json.dumps([]),
            "photo_url":       None,
        })
        print("  [E] ТестДмиа (опечатка): fuzzy match → ожидается matched к ТестДима")

    print("\n=== Done. Запустите AI Worker для обработки. ===")
    print("   GitHub Actions → workflow_dispatch → 'Process Events'")
    print("   Или локально: python ai-worker/process_events.py\n")
    print("Ожидаемые результаты в Supabase → таблица events:")
    print("  [A] ТестДима (оба события): status=done, hours≈9.5")
    print("  [B] ТестИван: status=needs_review, fraud: incomplete_day")
    print("  [C] ХХХНеизвестный999: status=needs_review, employee_id=null")
    print("  [D] ТестОльга: status=needs_review, fraud: wrong_location")
    print("  [E] ТестДмиа: matched к ТестДима (fuzzy)")


if __name__ == "__main__":
    main()
