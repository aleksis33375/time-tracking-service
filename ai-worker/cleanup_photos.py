"""
Cleanup Worker — удаление фото из Supabase Storage старше 60 дней.
Запускается GitHub Actions раз в сутки.

Что делает:
- Выбирает из events записи старше 60 дней с непустым photo_url
- Удаляет соответствующие файлы из Storage (bucket: photos)
- Записи в events НЕ трогает — история часов сохраняется
- Записывает в logs количество удалённых файлов
"""
import os
import requests
from datetime import datetime, timezone, timedelta

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}

RETENTION_DAYS  = 60    # фото хранятся 60 дней
DELETE_BATCH    = 100   # объектов за один DELETE-запрос


def log(level: str, message: str, meta: dict | None = None) -> None:
    payload = {
        "level":   level,
        "source":  "cleanup-worker",
        "message": message,
        "meta":    meta or {},
    }
    requests.post(f"{SUPABASE_URL}/rest/v1/logs", headers=HEADERS, json=payload, timeout=10)
    print(f"[{level.upper()}] {message}", flush=True)


def fetch_old_photo_urls(cutoff_iso: str) -> list[str]:
    """
    Возвращает список photo_url из events старше cutoff,
    у которых поле photo_url непустое.
    Постранично — на случай тысяч записей.
    """
    urls   = []
    offset = 0
    limit  = 1000

    while True:
        res = requests.get(
            f"{SUPABASE_URL}/rest/v1/events",
            headers=HEADERS,
            params={
                "select":        "photo_url",
                "photo_url":     "not.is.null",
                "created_at":    f"lt.{cutoff_iso}",
                "limit":         limit,
                "offset":        offset,
                "order":         "created_at.asc",
            },
            timeout=30,
        )
        rows = res.json()
        if not isinstance(rows, list) or not rows:
            break
        urls.extend(r["photo_url"] for r in rows if r.get("photo_url"))
        if len(rows) < limit:
            break
        offset += limit

    return urls


def storage_path_to_object(photo_url: str) -> str | None:
    """
    Преобразует photo_url вида 'photos/chatId/messageId.jpg'
    в объектный путь внутри бакета 'photos': 'chatId/messageId.jpg'.
    Пути из других бакетов (ref-photos) пропускаем — не трогаем.
    """
    if not photo_url or not photo_url.startswith("photos/"):
        return None
    return photo_url[len("photos/"):]   # убираем 'photos/' — остаток = путь внутри бакета


def delete_objects(object_paths: list[str]) -> int:
    """
    Удаляет объекты из бакета 'photos' батчами.
    Возвращает количество успешно удалённых файлов.
    """
    deleted = 0
    for i in range(0, len(object_paths), DELETE_BATCH):
        batch = object_paths[i : i + DELETE_BATCH]
        res = requests.delete(
            f"{SUPABASE_URL}/storage/v1/object/photos",
            headers=HEADERS,
            json={"prefixes": batch},
            timeout=30,
        )
        if res.status_code in (200, 204):
            deleted += len(batch)
            print(f"  Deleted batch {i // DELETE_BATCH + 1}: {len(batch)} file(s)", flush=True)
        else:
            print(f"  Batch {i // DELETE_BATCH + 1} failed: {res.status_code} {res.text}", flush=True)

    return deleted


def clear_photo_urls(photo_urls: list[str]) -> None:
    """
    Обнуляет поле photo_url в events для удалённых файлов,
    чтобы повторные прогоны не пытались удалить их снова.
    Записи в events при этом остаются — история часов сохраняется.
    """
    for url in photo_urls:
        requests.patch(
            f"{SUPABASE_URL}/rest/v1/events",
            headers={**HEADERS, "Prefer": "return=minimal"},
            params={"photo_url": f"eq.{url}"},
            json={"photo_url": None},
            timeout=15,
        )


def main() -> None:
    log("info", "Cleanup Worker started")

    cutoff     = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    cutoff_iso = cutoff.isoformat()
    print(f"Cutoff: {cutoff_iso} (older than {RETENTION_DAYS} days)", flush=True)

    # Собираем photo_url старше 60 дней
    photo_urls = fetch_old_photo_urls(cutoff_iso)
    print(f"Found {len(photo_urls)} photo URL(s) to process", flush=True)

    if not photo_urls:
        log("info", "Cleanup Worker finished — nothing to delete", {"retention_days": RETENTION_DAYS})
        return

    # Преобразуем в пути внутри бакета
    object_paths = [p for url in photo_urls if (p := storage_path_to_object(url))]
    skipped      = len(photo_urls) - len(object_paths)
    if skipped:
        print(f"Skipped {skipped} non-photos path(s)", flush=True)

    # Удаляем файлы из Storage
    deleted = delete_objects(object_paths)

    # Обнуляем photo_url у удалённых записей (только успешно удалённые)
    if deleted:
        deleted_urls = [
            url for url in photo_urls
            if storage_path_to_object(url) in set(object_paths[:deleted])
        ]
        clear_photo_urls(deleted_urls)   # обнуляем ТОЛЬКО успешно удалённые

    log("info", "Cleanup Worker finished", {
        "retention_days": RETENTION_DAYS,
        "found":          len(photo_urls),
        "deleted":        deleted,
        "skipped":        skipped,
    })


if __name__ == "__main__":
    main()
