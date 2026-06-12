"""
AI Worker — обработка входящих событий из Telegram.
Запускается GitHub Actions каждые 5 минут.
"""
import os
import re
import json
import signal
import tempfile
import functools
import threading
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

BATCH_SIZE   = 40   # записей за один прогон; 40×25=1000 сек < 20 мин (timeout теперь 22 мин)
STUCK_AFTER  = 15   # минут до признания записи зависшей
FACE_TIMEOUT = 25   # секунд timeout для face recognition операций


class TimeoutError(Exception):
    pass


def timeout_handler(signum, frame):
    raise TimeoutError("Face recognition operation timed out")


def with_timeout(seconds):
    """Декоратор таймаута: SIGALRM на Linux, threading-фолбэк на Windows (BUG-041)."""
    def decorator(func):
        @functools.wraps(func)
        def wrapper(*args, **kwargs):
            if not hasattr(signal, 'SIGALRM'):
                # Windows: threading-based fallback
                result_box = [None]
                exc_box    = [None]
                def _run():
                    try:
                        result_box[0] = func(*args, **kwargs)
                    except Exception as e:
                        exc_box[0] = e
                t = threading.Thread(target=_run, daemon=True)
                t.start()
                t.join(seconds)
                if t.is_alive():
                    raise TimeoutError("Face recognition operation timed out")
                if exc_box[0]:
                    raise exc_box[0]
                return result_box[0]
            # Linux/macOS: SIGALRM (production path — GitHub Actions Ubuntu)
            signal.signal(signal.SIGALRM, timeout_handler)
            signal.alarm(seconds)
            try:
                result = func(*args, **kwargs)
            finally:
                signal.alarm(0)  # отключаем alarm
            return result
        return wrapper
    return decorator


# ── Supabase helpers ──────────────────────────────────────────────────────────

def sb_get(path: str, params: str = "") -> list | dict:
    try:
        res = requests.get(f"{SUPABASE_URL}{path}{params}", headers=HEADERS, timeout=15)
        return res.json()
    except requests.exceptions.RequestException as e:
        print(f"[NETWORK ERROR] GET {path}: {e}", flush=True)
        return []


def sb_patch(path: str, body: dict, prefer: str = "return=minimal") -> list | dict:
    try:
        res = requests.patch(
            f"{SUPABASE_URL}{path}",
            headers={**HEADERS, "Prefer": prefer},
            json=body,
            timeout=15,
        )
        if not res.ok:
            msg = f"[PATCH ERROR] {res.status_code} {path}: {res.text[:300]}"
            print(msg, flush=True)
            # Write to Supabase logs so error is visible without GitHub Actions access
            try:
                requests.post(
                    f"{SUPABASE_URL}/rest/v1/logs",
                    headers=HEADERS,
                    json={"level": "error", "source": "ai-worker", "message": "PATCH failed",
                          "meta": {"status": res.status_code, "path": path, "body": res.text[:300]}},
                    timeout=10,
                )
            except Exception:
                pass
        return res.json() if prefer == "return=representation" else {}
    except requests.exceptions.RequestException as e:
        print(f"[NETWORK ERROR] PATCH {path}: {e}", flush=True)
        return {}


def sb_post(path: str, body: dict) -> dict:
    """POST в Supabase REST API, возвращает созданную запись."""
    try:
        res = requests.post(
            f"{SUPABASE_URL}{path}",
            headers={**HEADERS, "Prefer": "return=representation"},
            json=body,
            timeout=15,
        )
        data = res.json()
        if isinstance(data, list) and data:
            return data[0]
        return data
    except requests.exceptions.RequestException as e:
        print(f"[NETWORK ERROR] POST {path}: {e}", flush=True)
        return {}


def log(level: str, message: str, meta: dict | None = None) -> None:
    payload = {
        "level":   level,
        "source":  "ai-worker",
        "message": message,
        "meta":    meta or {},
    }
    try:
        requests.post(f"{SUPABASE_URL}/rest/v1/logs", headers=HEADERS, json=payload, timeout=10)
    except requests.exceptions.RequestException:
        pass  # не можем логировать — хотя бы пишем в stdout
    print(f"[{level.upper()}] {message}", flush=True)


def _ts_for_url(dt: datetime) -> str:
    """ISO timestamp safe for URL query strings (Z for UTC, %2B for others)."""
    return dt.isoformat().replace("+00:00", "Z").replace("+", "%2B")


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
    cutoff = _ts_for_url(datetime.now(timezone.utc) - timedelta(minutes=STUCK_AFTER))
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
TOKEN_THRESHOLD = 0.82   # минимальная схожесть при пофрагментном совпадении

# Слова, которые бригадир пишет рядом с именем — тип события, предлоги
_STRIP_TOKENS = frozenset({
    "начало", "начал", "конец", "конес", "конц", "конца",
    "окончание", "смены", "смена", "смену", "смене",
    "приход", "уход", "ушел", "ушёл", "пришел", "пришёл",
})


def _clean_name(raw: str) -> str:
    """Убирает слова типа события из подписи, оставляет только имя.
    «Конец смены Андрей» → «андрей», «Мирали конес смены» → «мирали».
    """
    tokens = raw.lower().split()
    clean = [t.strip(".,!-") for t in tokens if t.strip(".,!-") not in _STRIP_TOKENS]
    return " ".join(clean)


def _norm_cyr(s: str) -> str:
    """Нормализует часто путаемые кириллические символы (ь/ъ, ё/е)."""
    return s.replace("ь", "ъ").replace("ё", "е")


def _prefix_sim(a: str, b: str, min_prefix: int = 3) -> float:
    """Схожесть двух слов с учётом никнеймов («Тоха» ≈ «Тохир»).
    Возвращает 1.0 при точном совпадении, 0.9 при совпадении префикса
    (≥ min_prefix символов, длины слов отличаются не более чем на 2),
    иначе — стандартный difflib ratio.
    """
    if a == b:
        return 1.0
    pfx = 0
    for c1, c2 in zip(a, b):
        if c1 == c2:
            pfx += 1
        else:
            break
    if pfx >= min_prefix and pfx >= min(len(a), len(b)) - 1 and abs(len(a) - len(b)) <= 2:
        return 0.9
    return difflib.SequenceMatcher(None, a, b).ratio()


def find_employee_by_name(name: str, employees_cache: list | None = None) -> dict | None:
    """
    Ищет активного сотрудника по имени из подписи бригадира.
    Шаги (от точного к нечёткому):
      1. Точный ilike (или точное совпадение по кэшу).
      1.5. Подстрока: «Саша» → «Саша (РР от Ярика)».
      1.6. Подстрока по очищенному имени: «Конец смены Андрей» → «андрей».
      1.7. Пофрагментное совпадение с никнеймами и нормализацией ь/ъ.
      2. Полный fuzzy по очищенному нормализованному имени.
    employees_cache — предзагруженный список сотрудников из main(), избегает N+1 запросов.
    """
    if not name:
        return None

    name_clean = name.strip()

    if employees_cache is not None:
        # Используем кэш — без запросов в БД
        all_employees = employees_cache
        if not all_employees:
            return None
        # Шаг 1 — точное совпадение по кэшу (ilike = case-insensitive)
        name_lower_exact = name_clean.lower()
        for emp in all_employees:
            if emp["display_name"].lower() == name_lower_exact:
                return emp
    else:
        # Шаг 1 — точный ilike через БД (старый путь без кэша)
        rows = sb_get(
            "/rest/v1/employees",
            f"?display_name=ilike.{requests.utils.quote(name_clean)}"
            f"&deleted_at=is.null&select=id,display_name,face_embedding,ref_photo_url&limit=1",
        )
        if isinstance(rows, list) and rows:
            return rows[0]

        # Загружаем всех активных сотрудников
        all_employees = sb_get(
            "/rest/v1/employees",
            "?deleted_at=is.null&select=id,display_name,face_embedding,ref_photo_url,aliases",
        )
        if not isinstance(all_employees, list) or not all_employees:
            return None

    name_lower    = name_clean.lower()
    name_for_match = _clean_name(name_clean)   # без слов типа события

    # Шаг 1.4 — точное совпадение с aliases (никнеймы: «Саша» → «Петрукович Александр»)
    for emp in all_employees:
        emp_aliases = emp.get("aliases") or []
        if any(a.lower() == name_lower for a in emp_aliases):
            return emp

    # Шаг 1.5/1.6 — однозначная подстрока (оригинал, затем очищенное имя)
    for candidate in dict.fromkeys([name_lower, name_for_match]):  # уникальные, по порядку
        if not candidate:
            continue
        hits = [e for e in all_employees if candidate in e["display_name"].lower()]
        if len(hits) == 1:
            return hits[0]

    # Шаг 1.7 — пофрагментное совпадение: каждый токен имени vs каждый токен display_name.
    # Обрабатывает никнеймы («Тоха»→«Тохир») и опечатки («Неьматулло»→«Неъматулло»).
    search_tokens = (name_for_match or name_lower).split()
    best_token_emp   = None
    best_token_score = 0.0
    for emp in all_employees:
        emp_tokens = emp["display_name"].lower().split()
        for nt in search_tokens:
            nt_norm = _norm_cyr(nt)
            for dt in emp_tokens:
                score = _prefix_sim(nt_norm, _norm_cyr(dt))
                if score > best_token_score:
                    best_token_score = score
                    best_token_emp   = emp

    if best_token_score >= TOKEN_THRESHOLD:
        return best_token_emp

    # Шаг 2 — полный fuzzy по очищенному + нормализованному имени
    best_emp   = None
    best_ratio = 0.0
    compare_name = _norm_cyr(name_for_match or name_lower)

    for emp in all_employees:
        ratio = difflib.SequenceMatcher(
            None, compare_name, _norm_cyr(emp["display_name"].lower())
        ).ratio()
        if ratio > best_ratio:
            best_ratio = ratio
            best_emp   = emp

    if best_ratio >= FUZZY_THRESHOLD:
        return best_emp

    return None


def auto_create_employee(name: str) -> dict | None:
    """
    Создаёт нового сотрудника автоматически если имя валидно.
    Дефолты: team='Авто', daily_rate=5000, hourly_rate=625.
    Admin корректирует роль/зарплату вручную в разделе Сотрудники.
    """
    clean = _clean_name(name).strip()
    if not clean:
        clean = name.strip()
    if len(clean) < 2:
        return None
    # Имя должно содержать хотя бы одну букву (не просто цифры/символы)
    if not re.search(r'[а-яА-ЯёЁa-zA-Z]', clean):
        return None
    # Нормальный регистр: "киселёв леонид" → "Киселёв Леонид"
    display_name = " ".join(w.capitalize() for w in clean.split())
    result = sb_post(
        "/rest/v1/employees",
        {
            "display_name": display_name,
            "team":         "Авто",
            "daily_rate":   0,   # 0 = не задано; руководитель назначает вручную
        },
    )
    if not isinstance(result, dict) or "id" not in result:
        log("warning", f"auto_create_employee failed for {display_name!r}", {"result": str(result)})
        return None
    log("info", f"Auto-created employee: {display_name!r}", {"employee_id": result["id"]})
    return result

# ── п.6 Face recognition верификация ─────────────────────────────────────────

FACE_TOLERANCE = float(os.environ.get("FACE_TOLERANCE", "0.55"))  # чем меньше — тем строже

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
    try:
        if isinstance(embedding_val, str):
            arr = np.array(json.loads(embedding_val))
        elif isinstance(embedding_val, list):
            arr = np.array(embedding_val)
        else:
            return None
        return arr if arr.shape == (128,) else None
    except (json.JSONDecodeError, ValueError):
        return None


@with_timeout(FACE_TIMEOUT)
def compute_face_encoding(image_bytes: bytes) -> np.ndarray | None:
    """Извлекает первый face encoding из изображения (с timeout)."""
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

    # Проверяем валидность embedding (должен быть array формы (128,))
    if not isinstance(ref_embedding, np.ndarray) or ref_embedding.shape != (128,):
        return None   # невалидный embedding

    photo_bytes = download_storage_photo(photo_url)
    if not photo_bytes:
        return None

    try:
        event_encoding = compute_face_encoding(photo_bytes)
    except TimeoutError:
        raise  # пробрасываем — вызывающий код добавит флаг face_timeout

    if event_encoding is None:
        return False  # нет лица на фото → считаем несовпадением

    matches = face_recognition.compare_faces(
        [ref_embedding], event_encoding, tolerance=FACE_TOLERANCE
    )
    return bool(matches[0])


def bootstrap_face_embedding(employee: dict, photo_url: str) -> bool:
    """
    Первое фото сотрудника (face_embedding отсутствует) → сохраняем как эталон.
    Возвращает True если embedding успешно сохранён.
    """
    if not photo_url:
        return False

    photo_bytes = download_storage_photo(photo_url)
    if not photo_bytes:
        return False

    try:
        encoding = compute_face_encoding(photo_bytes)
    except TimeoutError:
        return False

    if encoding is None:
        return False  # лицо не найдено на фото

    sb_patch(
        f"/rest/v1/employees?id=eq.{employee['id']}",
        {
            "face_embedding": encoding.tolist(),
            "ref_photo_url":  photo_url,
        },
    )
    log("info", f"Face embedding bootstrapped: {employee['display_name']}", {
        "employee_id": employee["id"],
        "photo_url":   photo_url,
    })
    return True


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


# Флаги реального мошенничества → needs_review.
# no_photo_time и incomplete_day — технические ограничения, не мошенничество → done.
_FRAUD_REVIEW_FLAGS = {"face_mismatch", "double_shift", "no_photo", "face_timeout", "unknown_event_type"}

def needs_review(employee: dict | None, face_match: bool | None, fraud_flags: list[str]) -> bool:
    """Запись идёт на ручную проверку ТОЛЬКО при реальных аномалиях:
    - сотрудник не найден
    - лицо явно не совпало
    - fraud-флаг из _FRAUD_REVIEW_FLAGS
    no_photo_time и incomplete_day — информационные флаги, не блокируют автоматику.
    """
    if employee is None:
        return True
    if face_match is False:
        return True
    if any(f in _FRAUD_REVIEW_FLAGS for f in fraud_flags):
        return True
    return False

# ── п.8 event_type из event_type_raw / name_from_photo ───────────────────────

ARRIVAL_KEYWORDS   = ("начало", "начал", "приход", "пришел", "пришёл")
DEPARTURE_KEYWORDS = ("конец", "конес", "конц", "конца", "окончание", "уход", "ушел", "ушёл")

def resolve_event_type(event: dict) -> str | None:
    """
    Берёт тип события из уже распознанного event_type.
    Если он пустой — пробует разобрать event_type_raw, затем name_from_photo.
    Время суток НЕ используется — только текст подписи.
    Включает опечатки: «конес», «конц» и т.п.
    """
    # Бот уже поставил event_type через OCR — доверяем ему
    et = event.get("event_type")
    if et in ("arrival", "departure"):
        return et

    # Запасной вариант: парсим event_type_raw, затем name_from_photo
    for source in (event.get("event_type_raw"), event.get("name_from_photo")):
        text = (source or "").lower()
        if not text:
            continue
        if any(k in text for k in ARRIVAL_KEYWORDS):
            return "arrival"
        if any(k in text for k in DEPARTURE_KEYWORDS):
            return "departure"

    return None   # тип не определён → needs_review

# ── п.9 Расчёт часов ─────────────────────────────────────────────────────────

MOSCOW_OFFSET = timedelta(hours=3)

def moscow_date_of(utc_iso: str) -> str:
    """UTC ISO → дата в московском времени (UTC+3)."""
    dt = datetime.fromisoformat(utc_iso.replace("Z", "+00:00"))
    return (dt + MOSCOW_OFFSET).strftime("%Y-%m-%d")


def calculate_hours(employee_id: str, current_event: dict) -> tuple[float | None, str | None, bool, bool]:
    """
    Для departure: buffer-state алгоритм детекции дублей и двойных смен.
    Возвращает (hours, paired_arrival_id, is_double_shift, is_duplicate).
    """
    if current_event.get("event_type") != "departure":
        return (None, None, False, False)

    ts_str = current_event.get("photo_timestamp")
    if not ts_str or not employee_id:
        return (None, None, False, False)

    def parse_ts(s: str) -> datetime:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))

    dep_ts = parse_ts(ts_str)
    window_start = dep_ts - timedelta(hours=24)

    rows = sb_get(
        "/rest/v1/events",
        f"?employee_id=eq.{employee_id}"
        f"&photo_timestamp=gte.{_ts_for_url(window_start)}"
        f"&photo_timestamp=lt.{_ts_for_url(dep_ts)}"
        f"&status=in.(done,processing,needs_review)"
        f"&select=id,event_type,photo_timestamp"
        f"&order=photo_timestamp.asc",
    )

    if not isinstance(rows, list):
        rows = []

    open_arrival_id = None
    closed_pairs    = 0

    for ev in rows:
        ev_type = ev.get("event_type")
        if ev_type == "arrival":
            open_arrival_id = ev["id"]        # последний необработанный arrival
        elif ev_type == "departure":
            if open_arrival_id is not None:
                open_arrival_id = None
                closed_pairs += 1

    if open_arrival_id is None:
        return (None, None, False, True)      # нет открытого arrival → дубль

    arr_row = next((r for r in rows if r["id"] == open_arrival_id), None)
    if arr_row is None:
        return (None, None, False, False)

    arr_ts = parse_ts(arr_row["photo_timestamp"])
    hours  = round((dep_ts - arr_ts).total_seconds() / 3600, 2)
    return (hours, open_arrival_id, closed_pairs >= 1, False)


def _flag_previous_pair_as_double(employee_id: str, dep_ts: datetime) -> None:
    """
    JSONB read-modify-write: добавляет 'double_shift' к fraud_flags всех 'done'
    событий сотрудника за [dep_ts-24h, dep_ts) и переводит их в needs_review.
    """
    window_start = dep_ts - timedelta(hours=24)
    rows = sb_get(
        "/rest/v1/events",
        f"?employee_id=eq.{employee_id}"
        f"&photo_timestamp=gte.{_ts_for_url(window_start)}"
        f"&photo_timestamp=lt.{_ts_for_url(dep_ts)}"
        f"&status=eq.done"
        f"&select=id,fraud_flags",
    )
    if not isinstance(rows, list):
        return
    for ev in rows:
        flags = list(ev.get("fraud_flags") or [])
        if "double_shift" not in flags:
            flags.append("double_shift")
        sb_patch(
            f"/rest/v1/events?id=eq.{ev['id']}",
            {"status": "needs_review", "fraud_flags": flags},
        )


# ── Фаза 12: детект дублирующего arrival ─────────────────────────────────────

def check_duplicate_arrival(employee_id: str, current_event: dict) -> bool:
    """
    Возвращает True если в окне 24 ч уже есть открытый arrival без парного departure.
    Открытый arrival = arrival после которого нет departure (сотрудник ещё «внутри»).
    """
    if current_event.get("event_type") != "arrival":
        return False

    ts_str = current_event.get("photo_timestamp")
    if not ts_str or not employee_id:
        return False

    def parse_ts(s: str) -> datetime:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))

    arr_ts       = parse_ts(ts_str)
    window_start = arr_ts - timedelta(hours=24)

    rows = sb_get(
        "/rest/v1/events",
        f"?employee_id=eq.{employee_id}"
        f"&photo_timestamp=gte.{_ts_for_url(window_start)}"
        f"&photo_timestamp=lt.{_ts_for_url(arr_ts)}"
        f"&status=in.(done,processing,needs_review)"
        f"&select=id,event_type,photo_timestamp"
        f"&order=photo_timestamp.asc",
    )

    if not isinstance(rows, list):
        return False

    open_arrival = False
    for ev in rows:
        ev_type = ev.get("event_type")
        if ev_type == "arrival":
            open_arrival = True
        elif ev_type == "departure":
            open_arrival = False

    return open_arrival


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
        if hours is not None:
            body["hours"] = hours             # сохраняем для double_shift-агрегации
    else:
        body = {
            "status":      "done",
            "employee_id": employee["id"],
            "event_type":  event_type,
            "hours":       hours,
            "fraud_flags": fraud_flags,
        }

    result = sb_patch(f"/rest/v1/events?id=eq.{event_id}", body, prefer="return=representation")
    expected_status = "needs_review" if go_review else "done"
    if isinstance(result, list) and result:
        actual = result[0].get("status")
        if actual != expected_status:
            print(f"[FINALIZE WARN] event {event_id}: expected {expected_status}, got {actual}", flush=True)
            try:
                requests.post(
                    f"{SUPABASE_URL}/rest/v1/logs",
                    headers=HEADERS,
                    json={"level": "error", "source": "ai-worker", "message": "finalize status mismatch",
                          "meta": {"event_id": event_id, "expected": expected_status, "actual": actual}},
                    timeout=10,
                )
            except Exception:
                pass
    elif not isinstance(result, list):
        print(f"[FINALIZE WARN] event {event_id}: PATCH returned non-list: {str(result)[:100]}", flush=True)

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

    # Загружаем всех сотрудников один раз для всего батча — fix BUG-024 N+1
    employees_cache = sb_get(
        "/rest/v1/employees",
        "?deleted_at=is.null&select=id,display_name,face_embedding,ref_photo_url,aliases",
    )
    if not isinstance(employees_cache, list):
        employees_cache = []
    print(f"  employees cache: {len(employees_cache)} records loaded", flush=True)

    done_count   = 0
    review_count = 0

    for event in events:
        eid  = event["id"]
        name = event.get("name_from_photo") or ""
        print(f"  → event {eid} | name: {name!r}", flush=True)

        # п.5 Поиск сотрудника; если не найден — создаём автоматически
        employee = find_employee_by_name(name, employees_cache)
        if employee:
            print(f"     matched: {employee['display_name']}", flush=True)
        else:
            print(f"     no match for {name!r}", flush=True)
            if name:
                employee = auto_create_employee(name)
                if employee:
                    print(f"     auto-created: {employee['display_name']} ({employee['id']})", flush=True)

        # п.6 Face recognition верификация
        photo_url = event.get("photo_url") or ""
        face_timed_out = False

        if not photo_url:
            # Фото не было загружено — пропускаем распознавание, продолжаем обработку
            face_match = None
            print(f"     no photo — skipping face recognition", flush=True)
        elif employee and not employee.get("face_embedding"):
            # Первое фото этого сотрудника — сохраняем как эталон
            bootstrapped = bootstrap_face_embedding(employee, photo_url)
            print(f"     bootstrap embedding: {'ok' if bootstrapped else 'failed'}", flush=True)
            if not bootstrapped:
                # Нет лица на фото → на проверку, не duplicate
                reject_body = {
                    "status":      "needs_review",
                    "fraud_flags": ["no_face_detected"],
                    "employee_id": employee["id"],
                }
                sb_patch(f"/rest/v1/events?id=eq.{eid}", reject_body)
                log("warning", "No face detected during bootstrap — event rejected", {
                    "event_id": eid, "employee": employee.get("display_name"),
                })
                review_count += 1
                continue
            face_match = None  # верифицировать не с чем — пропускаем
        else:
            try:
                face_match = verify_face(photo_url, employee) if employee else None
            except TimeoutError:
                face_match = None
                face_timed_out = True
                log("warning", "Face recognition timeout — routed to needs_review", {"event_id": eid})
        print(f"     face_match: {face_match}", flush=True)

        # п.7 Сборка fraud_flags, маршрутизация на needs_review
        fraud_flags = build_fraud_flags(event, face_match)
        if not photo_url and "no_photo" not in fraud_flags:
            fraud_flags.append("no_photo")  # страховка: webhook мог не поставить флаг
        if face_timed_out and "face_timeout" not in fraud_flags:
            fraud_flags.append("face_timeout")
        go_review    = needs_review(employee, face_match, fraud_flags)
        print(f"     fraud_flags: {fraud_flags} | needs_review: {go_review}", flush=True)

        # п.8 Тип события из event_type_raw
        event_type = resolve_event_type(event)
        print(f"     event_type: {event_type}", flush=True)
        if event_type is None:
            if "unknown_event_type" not in fraud_flags:
                fraud_flags.append("unknown_event_type")
            go_review = True   # неизвестный тип → тоже на проверку

        # п.9 Расчёт часов — всегда если сотрудник и тип известны
        hours             = None
        paired_arrival_id = None
        is_double_shift   = False
        is_duplicate      = False
        if employee and event_type:
            hours, paired_arrival_id, is_double_shift, is_duplicate = calculate_hours(
                employee["id"], event
            )
        print(f"     hours: {hours} | double: {is_double_shift} | dup: {is_duplicate}", flush=True)

        # Дублирующий departure → status=duplicate, дальше не обрабатываем
        if is_duplicate:
            dup_flags = list(fraud_flags)
            if "duplicate" not in dup_flags:
                dup_flags.append("duplicate")
            body = {"status": "duplicate", "fraud_flags": dup_flags}
            if employee:
                body["employee_id"] = employee["id"]
            if event_type:
                body["event_type"] = event_type
            sb_patch(f"/rest/v1/events?id=eq.{eid}", body)
            log("warning", "Duplicate departure detected", {
                "event_id": eid, "employee": (employee or {}).get("display_name"),
            })
            notify_manager(event, employee, dup_flags)
            review_count += 1
            continue

        # Фаза 12: дублирующий arrival (два arrival подряд без departure между ними)
        if event_type == "arrival" and employee and not go_review:
            if check_duplicate_arrival(employee["id"], event):
                dup_flags = list(fraud_flags)
                if "duplicate" not in dup_flags:
                    dup_flags.append("duplicate")
                sb_patch(f"/rest/v1/events?id=eq.{eid}", {
                    "status":      "duplicate",
                    "fraud_flags": dup_flags,
                    "employee_id": employee["id"],
                    "event_type":  event_type,
                })
                log("warning", "Duplicate arrival detected", {
                    "event_id": eid, "employee": employee.get("display_name"),
                })
                notify_manager(event, employee, dup_flags)
                print(f"     → duplicate arrival", flush=True)
                review_count += 1
                continue

        # Двойная смена → флагуем предыдущую пару + текущее departure идёт на проверку
        if is_double_shift:
            dep_ts_dt = datetime.fromisoformat(
                (event.get("photo_timestamp") or "").replace("Z", "+00:00")
            )
            _flag_previous_pair_as_double(employee["id"], dep_ts_dt)
            if "double_shift" not in fraud_flags:
                fraud_flags.append("double_shift")
            go_review = True
            print(f"     double shift detected → needs_review", flush=True)

        # п.10 Неполный день — информационный флаг, НЕ блокирует автоматику
        if is_incomplete_day(employee, event_type, hours):
            if "incomplete_day" not in fraud_flags:
                fraud_flags.append("incomplete_day")
            print(f"     incomplete day — flagged, auto-approved", flush=True)

        # п.12/13 Финализация события
        finalize_event(eid, employee, event_type, hours, fraud_flags, go_review)
        print(f"     → {'needs_review' if go_review else 'done'}", flush=True)

        # Парный arrival: часы записываем ВСЕГДА — departure может быть на проверке, но часы корректны
        if paired_arrival_id:
            if is_double_shift:
                sb_patch(
                    f"/rest/v1/events?id=eq.{paired_arrival_id}",
                    {"status": "needs_review", "fraud_flags": ["double_shift"], "hours": hours},
                )
            else:
                arrival_status = "needs_review" if go_review else "done"
                sb_patch(
                    f"/rest/v1/events?id=eq.{paired_arrival_id}",
                    {"status": arrival_status, "hours": hours},
                )

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
