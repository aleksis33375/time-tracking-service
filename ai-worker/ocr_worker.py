#!/usr/bin/env python3
"""
OCR Worker — extract photo_timestamp from events using EasyOCR.
Replaces scripts/ocr-worker.js (Tesseract) with EasyOCR for better scene text recognition.

Usage:
  python ai-worker/ocr_worker.py            — recent events (last 4h, max 50)
  python ai-worker/ocr_worker.py --backfill — all events since 2026-05-01, paginated
"""

import sys
import re
import io
import os
import argparse
from datetime import datetime, timezone, timedelta

import numpy as np
from PIL import Image
import requests
import easyocr

SUPABASE_URL = os.environ["SUPABASE_URL"]
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}

RU_MONTHS = {
    'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4, 'май': 5, 'мая': 5,
    'июн': 6, 'июл': 7, 'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
}
EN_MONTHS = {
    'jan': 1, 'feb': 2, 'mar': 3, 'apr': 4, 'may': 5, 'jun': 6,
    'jul': 7, 'aug': 8, 'sep': 9, 'oct': 10, 'nov': 11, 'dec': 12,
}


def prepare_text(raw: str) -> str:
    t = raw
    # OCR шум: ведущая "1" перед временем (" 123:55:30" → " 23:55:30")
    t = re.sub(r'\s1(\d{2}:\d{2}:\d{2})', r' \1', t)
    t = re.sub(r'(\d{2})1(\d{2}):(\d{2})', r'\1:\2:\3', t)
    # Латинские OCR-замены для названий месяцев
    t = re.sub(r'(\d{1,2})\s*mas\s*(\d{4})',  r'\1 мая \2', t, flags=re.IGNORECASE)
    t = re.sub(r'(\d{1,2})\s*mai\s*(\d{4})',  r'\1 мая \2', t, flags=re.IGNORECASE)
    t = re.sub(r'(\d{1,2})\s*map\s*(\d{4})',  r'\1 мар \2', t, flags=re.IGNORECASE)
    t = re.sub(r'(\d{1,2})\s*waa\s*(\d{4})',  r'\1 мая \2', t, flags=re.IGNORECASE)
    t = re.sub(r'(\d{1,2})\s*was\s*(\d{4})',  r'\1 мая \2', t, flags=re.IGNORECASE)
    # Пунктуация после названий месяцев: "июн." "июн," "июн:" "июн;" → "июн "
    t = re.sub(r'([а-яёa-z]{3,4})[!.:;,]\s*', r'\1 ', t, flags=re.IGNORECASE)
    # Убираем "г." "г," "г:" "г;" "г!" после года: "2026 г:" → "2026 "
    t = re.sub(r'(\d{4})\s*[гпrР][.!,:;]\s*', r'\1 ', t)
    # Мусорная цифра/символ сразу после 4-значного года ("20261 " → "2026 ")
    t = re.sub(r'(\d{4})[01]([.\s,;])', r'\1\2', t)
    # Точка сразу после года ("2026." → "2026 ")
    t = re.sub(r'(\d{4})\.', r'\1 ', t)
    # Изолированный "1" или "l" между годом и временем ("2026 1," → "2026 ")
    t = re.sub(r'(\d{4})\s+[1l][,\s]', r'\1 ', t, flags=re.IGNORECASE)
    # Время с точками/запятыми вместо двоеточий: "18.04.11" → "18:04:11"
    # Negative lookahead (?!\d) защищает даты "13.06.2026" от замены
    def _dot_to_colon(m):
        h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if h <= 23 and mi <= 59 and s <= 59:
            return f'{m.group(1)}:{m.group(2)}:{m.group(3)}'
        return m.group(0)
    t = re.sub(r'\b(\d{1,2})[.,](\d{2})[.,](\d{2})(?!\d)', _dot_to_colon, t)
    return t


def try_extract(text: str, created_date: str = None) -> dict:
    t = prepare_text(text)

    # Формат: DD месяц YYYY HH:MM[:SS]
    full = re.search(
        r'(\d{1,2})\s*([а-яёa-z]{3,})\s*(\d{4})[^0-9]+(\d{1,2}):(\d{2})(?::(\d{2}))?',
        t, re.IGNORECASE
    )
    if full:
        key  = full.group(2).lower()[:3]
        mnum = RU_MONTHS.get(key) or EN_MONTHS.get(key)
        if mnum:
            return {
                'found': True, 'day': full.group(1), 'month': mnum,
                'year':  full.group(3), 'h': full.group(4),
                'm':     full.group(5), 's': full.group(6) or '0',
            }

    time_  = re.search(r'(\d{1,2}):(\d{2}):(\d{2})', t)
    timehm = re.search(r'\b(\d{1,2}):(\d{2})\b', t)
    dmy    = re.search(r'(\d{1,2})[./](\d{1,2})[./](\d{2,4})', t)
    ymd    = re.search(r'(\d{4})[-./](\d{2})[-./](\d{2})', t)

    def norm_year(y): return str(2000 + int(y)) if len(y) == 2 else y

    if time_ and dmy:
        return {'found': True, 'day': dmy.group(1), 'month': int(dmy.group(2)),
                'year': norm_year(dmy.group(3)), 'h': time_.group(1), 'm': time_.group(2), 's': time_.group(3)}
    if time_ and ymd:
        return {'found': True, 'day': ymd.group(3), 'month': int(ymd.group(2)),
                'year': ymd.group(1), 'h': time_.group(1), 'm': time_.group(2), 's': time_.group(3)}
    if timehm and dmy:
        return {'found': True, 'day': dmy.group(1), 'month': int(dmy.group(2)),
                'year': norm_year(dmy.group(3)), 'h': timehm.group(1), 'm': timehm.group(2), 's': '0'}
    if timehm and ymd:
        return {'found': True, 'day': ymd.group(3), 'month': int(ymd.group(2)),
                'year': ymd.group(1), 'h': timehm.group(1), 'm': timehm.group(2), 's': '0'}

    # Fallback: год + время (без даты) — берём дату из created_at
    if created_date:
        yt = re.search(r'\b(\d{4})\b[^0-9]*(\d{1,2}):(\d{2})(?::(\d{2}))?', t)
        if yt:
            y, h, m, s = yt.group(1), yt.group(2), yt.group(3), yt.group(4) or '0'
            if y == created_date[:4]:
                return {'found': True, 'day': created_date[8:10], 'month': int(created_date[5:7]),
                        'year': y, 'h': h, 'm': m, 's': s}

    return {'found': False}


def to_iso(r: dict) -> str:
    moscow = datetime(
        int(r['year']), int(r['month']), int(r['day']),
        int(r['h']), int(r['m']), int(r['s']),
        tzinfo=timezone(timedelta(hours=3))
    )
    return moscow.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def is_valid_date(iso_str: str) -> bool:
    try:
        d = datetime.fromisoformat(iso_str.replace('Z', '+00:00'))
    except Exception:
        return False
    now = datetime.now(timezone.utc)
    if d > now + timedelta(hours=6):
        return False
    if d < datetime(2026, 1, 1, tzinfo=timezone.utc):
        return False
    return True


def extract_ocr_timestamp(image_bytes: bytes, reader: easyocr.Reader, created_date: str = None, debug: bool = False):
    try:
        img     = Image.open(io.BytesIO(image_bytes)).convert('RGB')
        img_arr = np.array(img)

        # Pass A: EasyOCR на полном изображении (RGB)
        results = reader.readtext(img_arr)
        text_a  = ' '.join(t for _, t, _ in results)
        if debug:
            print(f'    [DEBUG] Pass A raw: {repr(text_a[:300])}')
            print(f'    [DEBUG] Pass A prepared: {repr(prepare_text(text_a)[:300])}')
        res_a   = try_extract(text_a, created_date)
        if res_a['found']:
            return to_iso(res_a)

        # Pass B: grayscale + повтор
        gray     = np.array(img.convert('L'))
        results2 = reader.readtext(gray)
        text_b   = ' '.join(t for _, t, _ in results2)
        if debug:
            print(f'    [DEBUG] Pass B raw: {repr(text_b[:300])}')
        res_b    = try_extract(text_b, created_date)
        if res_b['found']:
            return to_iso(res_b)

    except Exception as e:
        print(f'    EasyOCR error: {e}')

    return None


def download_photo(photo_url: str) -> bytes:
    url = f"{SUPABASE_URL}/storage/v1/object/{photo_url}"
    r   = requests.get(url, headers=HEADERS, timeout=30)
    if not r.ok:
        raise RuntimeError(f"Storage download failed: {r.status_code}")
    return r.content


def update_event(event_id: int, photo_timestamp: str, current_flags, event_status: str):
    flags = [f for f in (current_flags or []) if f != 'no_photo_time']
    patch = {'photo_timestamp': photo_timestamp, 'fraud_flags': flags}
    if event_status == 'done':
        patch['status'] = 'pending'
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/events?id=eq.{event_id}",
        headers=HEADERS, json=patch, timeout=15,
    )
    if not r.ok:
        raise RuntimeError(f"Update failed: {r.status_code}")


def _process_events(events: list, reader: easyocr.Reader, debug: bool = False) -> int:
    updated = 0
    for ev in events:
        try:
            photo       = download_photo(ev['photo_url'])
            moscow_date = (
                datetime.fromisoformat(ev['created_at'].replace('Z', '+00:00'))
                + timedelta(hours=3)
            ).strftime('%Y-%m-%d')

            ocr_time = extract_ocr_timestamp(photo, reader, moscow_date, debug=debug)

            if not ocr_time:
                print(f"  — Event {ev['id']}: no timestamp found")
                continue

            if not is_valid_date(ocr_time):
                print(f"  ⚠️  Event {ev['id']}: invalid date rejected ({ocr_time})")
                continue

            update_event(ev['id'], ocr_time, ev.get('fraud_flags'), ev['status'])
            updated += 1
            print(f"  ✏️  Event {ev['id']}: → {ocr_time}")

        except Exception as e:
            print(f"  ⚠️  Event {ev['id']}: {e}")

    print(f"  Updated {updated}/{len(events)}")
    return updated


def run_regular(reader: easyocr.Reader, debug: bool = False):
    since = (datetime.now(timezone.utc) - timedelta(hours=4)).isoformat().replace('+00:00', 'Z')
    url   = (
        f"{SUPABASE_URL}/rest/v1/events"
        f"?photo_url=not.is.null&photo_timestamp=is.null"
        f"&created_at=gte.{since}"
        f"&select=id,photo_url,fraud_flags,status,event_type,created_at"
        f"&limit=50&order=created_at.desc"
    )
    r = requests.get(url, headers=HEADERS, timeout=30)
    if not r.ok:
        raise RuntimeError(f"Fetch failed: {r.status_code}")
    events = r.json()
    print(f"📦 Found {len(events)} events without timestamp")
    _process_events(events, reader, debug=debug)


def run_debug(reader: easyocr.Reader):
    """Берёт 5 случайных фото без timestamp и печатает что EasyOCR реально видит."""
    url = (
        f"{SUPABASE_URL}/rest/v1/events"
        f"?photo_url=not.is.null&photo_timestamp=is.null"
        f"&select=id,photo_url,fraud_flags,status,event_type,created_at"
        f"&limit=5&order=created_at.desc"
    )
    r = requests.get(url, headers=HEADERS, timeout=30)
    if not r.ok:
        raise RuntimeError(f"Fetch failed: {r.status_code}")
    events = r.json()
    print(f"🔍 DEBUG: проверяю {len(events)} фото")
    _process_events(events, reader, debug=True)


def run_backfill(reader: easyocr.Reader):
    print("📦 Backfill: processing all events without timestamp since 2026-05-01")
    since     = "2026-05-01T00:00:00Z"
    page_size = 1000
    offset    = 0
    total_updated = 0
    total_seen    = 0

    while True:
        url = (
            f"{SUPABASE_URL}/rest/v1/events"
            f"?photo_url=not.is.null&photo_timestamp=is.null"
            f"&created_at=gte.{since}"
            f"&select=id,photo_url,fraud_flags,status,event_type,created_at"
            f"&limit={page_size}&offset={offset}&order=created_at.asc"
        )
        r = requests.get(url, headers=HEADERS, timeout=30)
        if not r.ok:
            raise RuntimeError(f"Fetch page failed: {r.status_code}")

        events = r.json()
        if not events:
            break

        print(f"  Page {offset // page_size + 1}: {len(events)} events")
        updated       = _process_events(events, reader)
        total_updated += updated
        total_seen    += len(events)
        offset        += page_size

        if len(events) < page_size:
            break

    print(f"✅ Backfill done: {total_updated}/{total_seen} events updated")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--backfill', action='store_true',
                        help='Process all events since 2026-05-01')
    parser.add_argument('--debug', action='store_true',
                        help='Show raw EasyOCR output for 5 recent photos (no DB writes)')
    args = parser.parse_args()

    print("🔄 OCR Worker (EasyOCR) started")
    print("  Loading EasyOCR models (ru + en) ...")
    reader = easyocr.Reader(['ru', 'en'], gpu=False)
    print("  Models loaded ✓")

    try:
        if args.debug:
            run_debug(reader)
        elif args.backfill:
            run_backfill(reader)
        else:
            run_regular(reader)
    except Exception as e:
        print(f"❌ OCR Worker failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
