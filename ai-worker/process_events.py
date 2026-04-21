"""
AI Worker — обработка входящих событий из Telegram.
Запускается GitHub Actions каждые 5 минут.
"""
import os
import json
import tempfile
import requests
import difflib
import numpy as np
import face_recognition
from datetime import datetime, timezone, timedelta

SUPABASE_URL     = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY      = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BOT_TOKEN        = os.environ.get("TELEGRAM_BOT_TOKEN", "")
MANAGER_CHAT_ID  = os.environ.get("MANAGER_CHAT_ID", "")

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}

BATCH_SIZE   = 20   # записей за один прогон
STUCK_AFTER  = 15   # минут до признания записи зависшей


# ── Supabase helpers ──────────────────────────────────────────────────────────

def sb_get(path: str, params: str = "") -> list | dict:
    res = requests.get(f"{SUPABASE_URL}{path}{params}", headers=HEADERS, timeout=15)
    return res.json()


def sb_patch(path: str, body: dict, prefer: str = "return=minimal") -> list | dict:
    res = requests.patch(
        f"{SUPABASE_URL}{path}",
        headers={**HEADERS, "Prefer": prefer},
        json=body,
        timeout=15,
    )
    return res.json() if prefer == "return=representation" else {}


def log(level: str, message: str, meta: dict | None = None) -> None:
    payload = {
        "level":   level,
        "source":  "ai-worker",
        "message": message,
        "meta":    meta or {},
    }
    requests.post(f"{SUPABASE_URL}/rest/v1/logs", headers=HEADERS, json=payload, timeout=10)
    print(f"[{level.upper()}] {message}", flush=True)


# ── п.3 Атомарный захват записей ──────────────────────────────────────────────

def claim_pending_events() -> list[dict]:
    """
    Получаем pending-записи и атомарно переводим в processing.
    Гонки нет: GitHub Actions concurrency group гарантирует
    что одновременно работает только один воркер.
    """
    # Берём IDs ожидающих записей
    rows = sb_get(
        "/rest/v1/events",
        f"?status=eq.pending&select=id&limit={BATCH_SIZE}&order=created_at.asc",
    )
    if not rows or isinstance(rows, dict):
        return []

    ids = [r["id"] for r in rows]
    id_filter = "(" + ",".join(ids) + ")"
    now = datetime.now(timezone.utc).isoformat()

    # Атомарно помечаем как processing + фиксируем время начала
    claimed = sb_patch(
        f"/rest/v1/events?id=in.{id_filter}",
        {"status": "processing", "processing_started_at": now},
        prefer="return=representation",
    )
    return claimed if isinstance(claimed, list) else []


# ── п.4 Восстановление зависших записей ──────────────────────────────────────

def restore_stuck_events() -> int:
    """Возвращает в pending записи, зависшие в processing дольше STUCK_AFTER минут."""
    cutoff = (datetime.now(timezone.utc) - timedelta(minutes=STUCK_AFTER)).isoformat()
    res = sb_patch(
        f"/rest/v1/events?status=eq.processing&processing_started_at=lt.{cutoff}",
        {"status": "pending", "processing_started_at": None},
        prefer="return=representation",
    )
    count = len(res) if isinstance(res, list) else 0
    if count:
        log("warning", f"Restored {count} stuck event(s) to pending", {"cutoff": cutoff})
    return count
# ── п.5 Поиск сотрудника по name_from_photo ──────────────────────────────────

FUZZY_THRESHOLD = 0.72   # минимальная схожесть для нечёткого совпадения

def find_employee_by_name(name: str) -> dict | None:
    """
    Ищет активного сотрудника по имени из OCR.
    Шаг 1: точное совпадение (ilike, без учёта регистра).
    Шаг 2: нечёткое совпадение по всему списку (difflib).
    OCR часто даёт опечатки или лишние символы — fuzzy это покрывает.
    """
    if not name:
        return None

    name_clean = name.strip()

    # Шаг 1 — точный ilike
    rows = sb_get(
        "/rest/v1/employees",
        f"?display_name=ilike.{requests.utils.quote(name_clean)}"
        f"&deleted_at=is.null&select=id,display_name,face_embedding,ref_photo_url&limit=1",
    )
    if isinstance(rows, list) and rows:
        return rows[0]

    # Шаг 2 — загружаем всех активных и ищем нечётко
    all_employees = sb_get(
        "/rest/v1/employees",
        "?deleted_at=is.null&select=id,display_name,face_embedding,ref_photo_url",
    )
    if not isinstance(all_employees, list) or not all_employees:
        return None

    best_emp   = None
    best_ratio = 0.0
    name_lower = name_clean.lower()

    for emp in all_employees:
        ratio = difflib.SequenceMatcher(
            None, name_lower, emp["display_name"].lower()
        ).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_emp   = emp

    if best_ratio >= FUZZY_THRESHOLD:
        return best_emp

    return None

# ── п.6 Face recognition верификация ─────────────────────────────────────────

FACE_TOLERANCE = 0.55   # чем меньше — тем строже (0.6 — стандарт, 0.55 — чуть строже)

def download_storage_photo(storage_path: str) -> bytes | None:
    """Скачивает фото из Supabase Storage по пути 'bucket/path'."""
    bucket, _, obj = storage_path.partition("/")
    res = requests.get(
        f"{SUPABASE_URL}/storage/v1/object/{bucket}/{obj}",
        headers=HEADERS,
        timeout=30,
    )
    return res.content if res.status_code == 200 else None


def parse_embedding(embedding_val) -> np.ndarray | None:
    """Преобразует pgvector строку '[0.1,0.2,...]' или список → numpy array."""
    if embedding_val is None:
        return None
    if isinstance(embedding_val, str):
        return np.array(json.loads(embedding_val))
    if isinstance(embedding_val, list):
        return np.array(embedding_val)
    return None


def compute_face_encoding(image_bytes: bytes) -> np.ndarray | None:
    """Извлекает первый face encoding из изображения."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    try:
        image     = face_recognition.load_image_file(tmp_path)
        encodings = face_recognition.face_encodings(image, num_jitters=1)
        return encodings[0] if encodings else None
    finally:
        os.unlink(tmp_path)


def verify_face(photo_url: str, employee: dict) -> bool | None:
    """
    Верифицирует: лицо на фото события совпадает с эталоном сотрудника?
    Возвращает True / False / None (если верификация невозможна).
    """
    ref_embedding = parse_embedding(employee.get("face_embedding"))
    if ref_embedding is None:
        return None   # нет эталона — пропускаем верификацию

    photo_bytes = download_storage_photo(photo_url)
    if not photo_bytes:
        return None

    event_encoding = compute_face_encoding(photo_bytes)
    if event_encoding is None:
        return None   # лицо не найдено на фото события

    matches = face_recognition.compare_faces(
        [ref_embedding], event_encoding, tolerance=FACE_TOLERANCE
    )
    return bool(matches[0])


# ── п.7 Сборка fraud_flags + маршрутизация на needs_review ───────────────────

def build_fraud_flags(event: dict, face_match: bool | None) -> list[str]:
    """
    Объединяет уже существующие fraud_flags из события
    с новым face_mismatch если лицо не совпало.
    """
    flags = list(event.get("fraud_flags") or [])
    if face_match is False:   # именно False, не None (None = нет эталона)
        if "face_mismatch" not in flags:
            flags.append("face_mismatch")
    return flags


def needs_review(employee: dict | None, face_match: bool | None, fraud_flags: list[str]) -> bool:
    """Запись должна идти на ручную проверку если:
    - сотрудник не найден
    - лицо явно не совпало
    - есть любые fraud_flags
    """
    if employee is None:
        return True
    if face_match is False:
        return True
    if fraud_flags:
        return True
    return False

# ── п.8 event_type из event_type_raw ─────────────────────────────────────────

ARRIVAL_KEYWORDS   = ("начало", "приход", "пришел", "пришёл")
DEPARTURE_KEYWORDS = ("конец", "окончание", "уход", "ушел", "ушёл")

def resolve_event_type(event: dict) -> str | None:
    """
    Берёт тип события из уже распознанного event_type.
    Если он пустой — пробует разобрать event_type_raw.
    Время суток НЕ используется — только текст подписи.
    """
    # Бот уже поставил event_type через OCR — доверяем ему
    et = event.get("event_type")
    if et in ("arrival", "departure"):
        return et

    # Запасной вариант: парсим raw-текст
    raw = (event.get("event_type_raw") or "").lower()
    if any(k in raw for k in ARRIVAL_KEYWORDS):
        return "arrival"
    if any(k in raw for k in DEPARTURE_KEYWORDS):
        return "departure"

    return None   # тип не определён → needs_review

# ── п.9 Расчёт часов ─────────────────────────────────────────────────────────

MOSCOW_OFFSET = timedelta(hours=3)

def moscow_date_of(utc_iso: str) -> str:
    """UTC ISO → дата в московском времени (UTC+3)."""
    dt = datetime.fromisoformat(utc_iso.replace("Z", "+00:00"))
    return (dt + MOSCOW_OFFSET).strftime("%Y-%m-%d")


def calculate_hours(employee_id: str, current_event: dict) -> float | None:
    """
    Часы за день = последний «конец смены» − первый «начало смены».
    Обед НЕ вычитается. Результат дробный (9.5 = 9ч 30м).
    Выходные обрабатываются как будние (п.11 — никакого спецкода не нужно).
    Возвращает None если приход или уход отсутствует (неполный день).
    """
    ts_str = current_event.get("photo_timestamp")
    if not ts_str or not employee_id:
        return None

    moscow_day = moscow_date_of(ts_str)

    # Границы календарного дня в UTC
    day_start = (
        datetime.strptime(moscow_day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        - MOSCOW_OFFSET
    )
    day_end = day_start + timedelta(days=1)

    # Все события сотрудника за этот день (включая текущее — оно уже processing)
    rows = sb_get(
        "/rest/v1/events",
        f"?employee_id=eq.{employee_id}"
        f"&photo_timestamp=gte.{day_start.isoformat()}"
        f"&photo_timestamp=lt.{day_end.isoformat()}"
        f"&status=in.(done,processing)"
        f"&select=event_type,photo_timestamp"
        f"&order=photo_timestamp.asc",
    )
    if not isinstance(rows, list) or not rows:
        return None

    arrivals   = [r for r in rows if r.get("event_type") == "arrival"]
    departures = [r for r in rows if r.get("event_type") == "departure"]

    if not arrivals or not departures:
        return None   # неполный день → п.10 обработает это как needs_review

    def parse_ts(s: str) -> datetime:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))

    first_arrival  = parse_ts(arrivals[0]["photo_timestamp"])
    last_departure = parse_ts(departures[-1]["photo_timestamp"])

    if last_departure <= first_arrival:
        return None   # уход раньше прихода — аномалия

    hours = (last_departure - first_arrival).total_seconds() / 3600
    return round(hours, 2)


# ── п.10 Неполный день + п.11 Выходные ───────────────────────────────────────

def is_incomplete_day(employee: dict | None, event_type: str | None, hours: float | None) -> bool:
    """
    Неполный день — сотрудник найден и тип определён,
    но пара приход/уход за день не сложилась (hours=None).

    П.11: выходные обрабатываются как будние —
    никакой проверки дня недели нет намеренно.
    """
    if employee is None or event_type is None:
        return False   # другие причины для review уже учтены
    return hours is None

# ── п.12 Обновление events: done / п.13 needs_review ─────────────────────────

def finalize_event(
    event_id:    str,
    employee:    dict | None,
    event_type:  str | None,
    hours:       float | None,
    fraud_flags: list[str],
    go_review:   bool,
) -> None:
    """
    П.12: status=done   — всё распознано, часы посчитаны.
    П.13: status=needs_review — сотрудник не найден, fraud_flags или неполный день.
    """
    if go_review:
        body = {
            "status":      "needs_review",
            "fraud_flags": fraud_flags,
        }
        if employee:
            body["employee_id"] = employee["id"]
        if event_type:
            body["event_type"] = event_type
    else:
        body = {
            "status":      "done",
            "employee_id": employee["id"],
            "event_type":  event_type,
            "hours":       hours,
            "fraud_flags": fraud_flags,
        }

    sb_patch(f"/rest/v1/events?id=eq.{event_id}", body)

# ── п.14 Telegram-уведомление руководителю ───────────────────────────────────

def notify_manager(event: dict, employee: dict | None, fraud_flags: list[str]) -> None:
    """Отправляет сообщение руководителю в личку при появлении needs_review."""
    if not BOT_TOKEN or not MANAGER_CHAT_ID:
        return

    name      = (employee or {}).get("display_name") or event.get("name_from_photo") or "неизвестен"
    ts        = event.get("photo_timestamp") or "—"
    flags_str = ", ".join(fraud_flags) if fraud_flags else "нет"

    # Переводим UTC → московское время для отображения
    try:
        dt_utc    = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        dt_moscow = dt_utc + MOSCOW_OFFSET
        ts_human  = dt_moscow.strftime("%d.%m.%Y %H:%M")
    except Exception:
        ts_human = ts

    text = (
        f"⚠️ *Требует проверки*\n\n"
        f"👤 Сотрудник: {name}\n"
        f"🕐 Время фото: {ts_human} МСК\n"
        f"🚩 Причины: {flags_str}\n\n"
        f"Откройте раздел «Проверка» в дашборде."
    )

    try:
        requests.post(
            f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage",
            json={
                "chat_id":    MANAGER_CHAT_ID,
                "text":       text,
                "parse_mode": "Markdown",
            },
            timeout=10,
        )
    except Exception as e:
        print(f"     notify_manager failed: {e}", flush=True)
# TODO п.15: запись в logs


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    log("info", "AI Worker started")

    # Сначала освобождаем зависшие записи (п.4)
    restore_stuck_events()

    events = claim_pending_events()
    if not events:
        print("No pending events.", flush=True)
        return

    log("info", f"Claimed {len(events)} event(s) for processing")

    done_count   = 0
    review_count = 0

    for event in events:
        eid  = event["id"]
        name = event.get("name_from_photo") or ""
        print(f"  → event {eid} | name: {name!r}", flush=True)

        # п.5 Поиск сотрудника
        employee = find_employee_by_name(name)
        if employee:
            print(f"     matched: {employee['display_name']}", flush=True)
        else:
            print(f"     no match for {name!r}", flush=True)

        # п.6 Face recognition верификация
        photo_url  = event.get("photo_url") or ""
        face_match = verify_face(photo_url, employee) if employee else None
        print(f"     face_match: {face_match}", flush=True)

        # п.7 Сборка fraud_flags, маршрутизация на needs_review
        fraud_flags  = build_fraud_flags(event, face_match)
        go_review    = needs_review(employee, face_match, fraud_flags)
        print(f"     fraud_flags: {fraud_flags} | needs_review: {go_review}", flush=True)

        # п.8 Тип события из event_type_raw
        event_type = resolve_event_type(event)
        print(f"     event_type: {event_type}", flush=True)
        if event_type is None:
            go_review = True   # неизвестный тип → тоже на проверку

        # п.9 Расчёт часов (только если сотрудник найден и тип определён)
        hours = None
        if employee and event_type and not go_review:
            hours = calculate_hours(employee["id"], event)
        print(f"     hours: {hours}", flush=True)

        # п.10 Неполный день → needs_review (п.11: выходные = будние, спецкода нет)
        if is_incomplete_day(employee, event_type, hours):
            go_review = True
            print(f"     incomplete day → needs_review", flush=True)

        # п.12/13 Финализация события
        finalize_event(eid, employee, event_type, hours, fraud_flags, go_review)
        print(f"     → {'needs_review' if go_review else 'done'}", flush=True)

        # п.14 Уведомление руководителю если needs_review
        if go_review:
            notify_manager(event, employee, fraud_flags)

        # п.15 Запись бизнес-события в logs
        if go_review:
            log("warning", "Event needs_review", {
                "event_id":    eid,
                "employee":    (employee or {}).get("display_name") or name or None,
                "fraud_flags": fraud_flags,
                "event_type":  event_type,
            })
            review_count += 1
        else:
            log("info", "Event processed successfully", {
                "event_id":   eid,
                "employee":   employee["display_name"],
                "event_type": event_type,
                "hours":      hours,
            })
            done_count += 1

    # Итоговая запись по прогону
    log("info", "AI Worker finished", {
        "total":       len(events),
        "done":        done_count,
        "needs_review": review_count,
    })


if __name__ == "__main__":
    main()
