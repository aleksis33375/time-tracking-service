"""
Compute face embeddings for employees who have a ref photo but no embedding yet.
Runs as GitHub Actions cron job every 10 minutes.
"""
import os
import sys
import tempfile

import requests
import face_recognition

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

HEADERS = {
    "apikey":        SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type":  "application/json",
}


# ── Logging ──────────────────────────────────────────────────────────────────

def log(level: str, message: str, meta: dict | None = None) -> None:
    payload = {
        "level":   level,
        "source":  "face-embedding-worker",
        "message": message,
        "meta":    meta or {},
    }
    try:
        requests.post(f"{SUPABASE_URL}/rest/v1/logs", headers=HEADERS, json=payload, timeout=10)
    except Exception:
        pass
    print(f"[{level.upper()}] {message}", flush=True)


# ── Supabase helpers ──────────────────────────────────────────────────────────

def get_pending_employees() -> list[dict]:
    res = requests.get(
        f"{SUPABASE_URL}/rest/v1/employees"
        "?select=id,display_name,ref_photo_url"
        "&ref_photo_url=not.is.null"
        "&face_embedding=is.null"
        "&deleted_at=is.null",
        headers=HEADERS,
        timeout=15,
    )
    data = res.json()
    return data if isinstance(data, list) else []


def download_photo(storage_path: str) -> bytes | None:
    """storage_path = 'ref-photos/uuid/ref.jpg'"""
    bucket, _, obj = storage_path.partition("/")
    res = requests.get(
        f"{SUPABASE_URL}/storage/v1/object/{bucket}/{obj}",
        headers=HEADERS,
        timeout=30,
    )
    if res.status_code != 200:
        return None
    return res.content


def save_embedding(employee_id: str, embedding: list[float]) -> bool:
    # pgvector accepts the vector as a string: "[0.1,0.2,...]"
    vec_str = "[" + ",".join(f"{v:.8f}" for v in embedding) + "]"
    res = requests.patch(
        f"{SUPABASE_URL}/rest/v1/employees?id=eq.{employee_id}",
        headers={**HEADERS, "Prefer": "return=minimal"},
        json={"face_embedding": vec_str},
        timeout=15,
    )
    return res.status_code in (200, 204)


# ── Core logic ────────────────────────────────────────────────────────────────

def compute_embedding(image_bytes: bytes) -> list[float] | None:
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    try:
        image     = face_recognition.load_image_file(tmp_path)
        encodings = face_recognition.face_encodings(image, num_jitters=2)
        return encodings[0].tolist() if encodings else None
    finally:
        os.unlink(tmp_path)


def main() -> None:
    employees = get_pending_employees()
    if not employees:
        print("No employees pending embedding.", flush=True)
        return

    log("info", f"Embedding run started: {len(employees)} employee(s) to process")
    ok = fail = 0

    for emp in employees:
        eid  = emp["id"]
        name = emp["display_name"]
        path = emp["ref_photo_url"]
        print(f"  → {name} ({eid})", flush=True)

        photo = download_photo(path)
        if photo is None:
            log("warning", f"Cannot download photo for {name}", {"employee_id": eid})
            fail += 1
            continue

        embedding = compute_embedding(photo)
        if embedding is None:
            log("warning", f"No face detected in photo for {name}", {"employee_id": eid})
            fail += 1
            continue

        if save_embedding(eid, embedding):
            log("info", f"Embedding saved for {name}", {"employee_id": eid})
            ok += 1
        else:
            log("error", f"Failed to save embedding for {name}", {"employee_id": eid})
            fail += 1

    log("info", f"Embedding run complete: {ok} ok, {fail} failed", {"ok": ok, "fail": fail})


if __name__ == "__main__":
    main()
