"""
Обновляет face_embedding сотрудника из указанного фото.
Использование:
  python ai-worker/update_face_embedding.py "Сайрахмон" "photos/-1003993016756/2643.jpg"
"""
import sys
import os
import json
import tempfile
import requests
import numpy as np
import face_recognition

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}


def download_photo(storage_path: str) -> bytes:
    bucket, _, obj = storage_path.partition("/")
    url = f"{SUPABASE_URL}/storage/v1/object/{bucket}/{obj}"
    resp = requests.get(url, headers=HEADERS, timeout=30)
    if resp.status_code != 200:
        raise RuntimeError(f"Download failed: {resp.status_code} {resp.text[:200]}")
    return resp.content


def compute_encoding(photo_bytes: bytes) -> list:
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(photo_bytes)
        tmp_path = tmp.name
    try:
        image     = face_recognition.load_image_file(tmp_path)
        encodings = face_recognition.face_encodings(image, num_jitters=3)
        if not encodings:
            raise RuntimeError("Лицо на фото не найдено")
        return encodings[0].tolist()
    finally:
        os.unlink(tmp_path)


def main():
    if len(sys.argv) < 3:
        print("Использование: python update_face_embedding.py <имя_сотрудника> <photo_path>")
        sys.exit(1)

    emp_name   = sys.argv[1]
    photo_path = sys.argv[2]

    print(f"Скачиваю фото {photo_path} ...")
    photo_bytes = download_photo(photo_path)
    print(f"  Загружено {len(photo_bytes)} байт")

    print("Вычисляю face encoding ...")
    encoding = compute_encoding(photo_bytes)
    print(f"  Encoding вычислен ({len(encoding)} dim)")

    print(f"Ищу сотрудника '{emp_name}' ...")
    resp = requests.get(
        f"{SUPABASE_URL}/rest/v1/employees?display_name=eq.{emp_name}&deleted_at=is.null&select=id,display_name",
        headers=HEADERS, timeout=10,
    )
    employees = resp.json()
    if not employees:
        print(f"Сотрудник '{emp_name}' не найден!")
        sys.exit(1)
    emp = employees[0]
    print(f"  Найден: {emp['display_name']} ({emp['id']})")

    print("Обновляю face_embedding ...")
    patch = requests.patch(
        f"{SUPABASE_URL}/rest/v1/employees?id=eq.{emp['id']}",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json={"face_embedding": encoding},
        timeout=10,
    )
    if patch.status_code in (200, 204):
        print(f"✓ face_embedding для '{emp_name}' обновлён из {photo_path}")
    else:
        print(f"Ошибка обновления: {patch.status_code} {patch.text[:200]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
