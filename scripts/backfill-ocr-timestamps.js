/**
 * Backfill — OCR Timestamps
 * Re-processes all saved photos to extract correct timestamps via OCR.
 * Resets status to 'pending' for modified events so ai-worker recalculates hours.
 */

import sharp from 'sharp';
import Tesseract from 'tesseract.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const RU_MONTHS_BF = {
  'янв':1,'фев':2,'мар':3,'апр':4,'май':5,'мая':5,
  'июн':6,'июл':7,'авг':8,'сен':9,'окт':10,'ноя':11,'дек':12,
};
const EN_MONTHS_BF = {
  'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,
  'jul':7,'aug':8,'sep':9,'oct':10,'nov':11,'dec':12,
};

async function extractOcrTimestamp(buffer, worker) {
  try {
    // Полное изображение, без кропа; resize до 1600px withoutEnlargement (не ×2)
    const preparedBuf = await sharp(buffer)
      .greyscale()
      .normalise()
      .resize({ width: 1600, withoutEnlargement: true, kernel: 'lanczos3' })
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    // Проход 1: shared eng-worker — числовая дата + время
    const ocrResult = await Promise.race([
      worker.recognize(preparedBuf),
      new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 15000)),
    ]).catch(() => null);

    const numText = ocrResult?.data?.text || '';

    const timeMatch = numText.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!timeMatch) return null;
    const [, h, m, s] = timeMatch;

    const dateMatchDMY = numText.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    const dateMatchYMD = numText.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);

    let day, month, year;

    if (dateMatchDMY) {
      [, day, month, year] = dateMatchDMY;
    } else if (dateMatchYMD) {
      [, year, month, day] = dateMatchYMD;
    } else {
      // Проход 2: названия месяцев (rus+eng) — отдельный вызов только при необходимости
      const ocrRus = await Promise.race([
        Tesseract.recognize(preparedBuf, 'rus+eng', { tessedit_pageseg_mode: '6' }),
        new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 15000)),
      ]).catch(() => null);

      const rusText = ocrRus?.data?.text || '';
      const mMatch = rusText.match(/(\d{1,2})\s+([а-яёa-z]{3,})[а-яёa-z]*\.?\s+(\d{4})/i);
      if (mMatch) {
        const key  = mMatch[2].toLowerCase().slice(0, 3);
        const mNum = RU_MONTHS_BF[key] || EN_MONTHS_BF[key];
        if (mNum) {
          day   = mMatch[1];
          month = String(mNum);
          year  = mMatch[3];
        }
      }
    }

    if (!day || !month || !year) return null;

    const moscowMs = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day),
                               parseInt(h), parseInt(m), parseInt(s));
    const utcMs = moscowMs - 3 * 3600 * 1000;
    return new Date(utcMs).toISOString();
  } catch {
    return null;
  }
}

async function downloadPhoto(photoUrl) {
  const url = `${SUPABASE_URL}/storage/v1/object/${photoUrl}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Storage download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function updateEvent(eventId, photoTimestamp, newStatus) {
  const body = { photo_timestamp: photoTimestamp };
  if (newStatus) body.status = newStatus;

  const res = await fetch(`${SUPABASE_URL}/rest/v1/events?id=eq.${eventId}&status=in.(done,needs_review,pending)`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
}

async function logComplete(updated, total) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/logs`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({
      level: 'info',
      source: 'backfill',
      message: 'Backfill complete',
      meta: { events_updated: updated, total: total },
    }),
  });
  if (!res.ok) console.warn('Log write failed:', res.status);
}

async function main() {
  console.log('🔄 Backfill OCR Timestamps started');

  // Один воркер на весь прогон — экономим 3–7 сек на каждом фото
  const worker = await Tesseract.createWorker('eng');

  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/events?photo_url=not.is.null&created_at=gte.2026-05-01T00:00:00Z&select=id,photo_url,photo_timestamp,status,created_at&limit=1000`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

    const events = await res.json();
    console.log(`📦 Found ${events.length} events with photos`);

    let updated = 0;
    let processed = 0;

    for (const ev of events) {
      processed++;
      if (processed % 10 === 0) console.log(`  Processing ${processed}/${events.length}...`);

      try {
        const photo = await downloadPhoto(ev.photo_url);
        const ocrTime = await extractOcrTimestamp(photo, worker);

        if (!ocrTime) continue;

        // Если photo_timestamp был null — всегда обновляем
        const hadNoTimestamp = !ev.photo_timestamp;
        if (!hadNoTimestamp) {
          const diffMs = Math.abs(new Date(ocrTime) - new Date(ev.photo_timestamp));
          if (diffMs / 60000 < 2) continue;
        }

        console.log(`  ✏️  Event ${ev.id}: ${ev.photo_timestamp || 'null'} → ${ocrTime}`);

        const newStatus = (ev.status === 'done' || ev.status === 'needs_review') ? 'pending' : null;
        await updateEvent(ev.id, ocrTime, newStatus);
        updated++;
      } catch (err) {
        console.warn(`  ⚠️  Event ${ev.id}: ${err.message}`);
      }
    }

    console.log(`✅ Backfill complete: ${updated}/${events.length} events updated`);
    await logComplete(updated, events.length);
  } catch (err) {
    console.error('❌ Backfill failed:', err.message);
    process.exit(1);
  } finally {
    await worker.terminate();
  }
}

main();
