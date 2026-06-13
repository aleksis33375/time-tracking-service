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

function prepareText(raw) {
  return raw
    // OCR шум: ведущая "1" перед временем (" 123:55:30" → " 23:55:30")
    .replace(/\s1(\d{2}:\d{2}:\d{2})/g, ' $1')
    .replace(/(\d{2})1(\d{2}):(\d{2})/g, '$1:$2:$3')
    // Латинские OCR-замены для названий месяцев
    .replace(/(\d{1,2})\s*mas\s*(\d{4})/gi, '$1 мая $2')
    .replace(/(\d{1,2})\s*mai\s*(\d{4})/gi, '$1 мая $2')
    .replace(/(\d{1,2})\s*map\s*(\d{4})/gi, '$1 мар $2')
    .replace(/(\d{1,2})\s*waa\s*(\d{4})/gi, '$1 мая $2')   // "Waa" → "мая"
    .replace(/(\d{1,2})\s*was\s*(\d{4})/gi, '$1 мая $2')   // "Was" → "мая"
    .replace(/г[;,]/g, 'г.')
    .replace(/([а-яё]{3,4})\.\s*/gi, '$1 ')   // "июн. " → "июн "
    .replace(/(\d{4})\s*г\.\s*/g, '$1 ')       // "2026 г. " → "2026 "
    // Мусорная цифра/символ сразу после 4-значного года ("20261 "→"2026 ", "20260."→"2026.")
    .replace(/(\d{4})[01]([.\s,;])/g, '$1$2')
    // Точка сразу после года ("2026." → "2026 ")
    .replace(/(\d{4})\./g, '$1 ')
    // Изолированный "1" или "l" между годом и временем ("2026 1," → "2026 ")
    .replace(/(\d{4})\s+[1l][,\s]/gi, '$1 ');
}

function tryExtract(text) {
  const t = prepareText(text);

  // Формат: DD месяц YYYY HH:MM[:SS]
  const full = t.match(/(\d{1,2})\s*([а-яёa-z]{3,})\s*(\d{4})[^0-9]+(\d{1,2}):(\d{2})(?::(\d{2}))?/i);
  if (full) {
    const key  = full[2].toLowerCase().slice(0, 3);
    const mNum = RU_MONTHS_BF[key] || EN_MONTHS_BF[key];
    if (mNum) return { found: true, day: full[1], month: mNum, year: full[3], h: full[4], m: full[5], s: full[6] || '0' };
  }

  const time   = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);   // HH:MM:SS
  const timeHM = t.match(/\b(\d{1,2}):(\d{2})\b/);        // HH:MM без секунд
  const dmy    = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  const ymd    = t.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);

  function normalizeYear(y) { return y.length === 2 ? String(2000 + parseInt(y)) : y; }

  if (time && dmy) return { found: true, day: dmy[1], month: parseInt(dmy[2]), year: normalizeYear(dmy[3]), h: time[1], m: time[2], s: time[3] };
  if (time && ymd) return { found: true, day: ymd[3], month: parseInt(ymd[2]), year: ymd[1], h: time[1], m: time[2], s: time[3] };
  if (timeHM && dmy) return { found: true, day: dmy[1], month: parseInt(dmy[2]), year: normalizeYear(dmy[3]), h: timeHM[1], m: timeHM[2], s: '0' };
  if (timeHM && ymd) return { found: true, day: ymd[3], month: parseInt(ymd[2]), year: ymd[1], h: timeHM[1], m: timeHM[2], s: '0' };
  return { found: false };
}

function toIso({ day, month, year, h, m, s = '0' }) {
  const moscowMs = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day),
                             parseInt(h), parseInt(m), parseInt(s));
  return new Date(moscowMs - 3 * 3600 * 1000).toISOString();
}

async function ocrBuffer(buf, worker) {
  const r = await Promise.race([
    worker.recognize(buf),
    new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 15000)),
  ]).catch(() => null);
  return r?.data?.text || '';
}

async function extractOcrTimestamp(buffer, worker) {
  try {
    // Pass A: full image
    const fullBuf = await sharp(buffer)
      .greyscale()
      .normalise()
      .resize({ width: 1600, withoutEnlargement: true, kernel: 'lanczos3' })
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
    const resA = tryExtract(await ocrBuffer(fullBuf, worker));
    if (resA.found) return toIso(resA);

    // Pass B: corner crops (right 60% × top/bottom 30%)
    const meta  = await sharp(buffer).metadata();
    const cropL = Math.floor(meta.width * 0.40);
    const cropW = meta.width - cropL;
    const cornH = Math.floor(meta.height * 0.30);

    const makeCornerBuf = (top) =>
      sharp(buffer)
        .extract({ left: cropL, top, width: cropW, height: cornH })
        .greyscale()
        .normalise()
        .resize({ width: 900, kernel: 'lanczos3' })
        .sharpen({ sigma: 1.5 })
        .toBuffer();

    const resTop = tryExtract(await ocrBuffer(await makeCornerBuf(0), worker));
    if (resTop.found) return toIso(resTop);

    const resBot = tryExtract(await ocrBuffer(await makeCornerBuf(meta.height - cornH), worker));
    if (resBot.found) return toIso(resBot);

    // Pass C: нижняя полоса полной ширины — водяной знак в любом горизонтальном положении
    const stripTop = Math.floor(meta.height * 0.75);
    const stripH   = meta.height - stripTop;
    const resStrip = tryExtract(await ocrBuffer(
      await sharp(buffer)
        .extract({ left: 0, top: stripTop, width: meta.width, height: stripH })
        .greyscale().normalise()
        .resize({ width: 1200, kernel: 'lanczos3' })
        .sharpen({ sigma: 2 })
        .toBuffer(),
      worker
    ));
    if (resStrip.found) return toIso(resStrip);

    // Pass D: левый нижний угол, PSM 7 — Android-водяной знак слева
    await worker.setParameters({ tessedit_pageseg_mode: '7' }).catch(() => {});
    const resLeftBot = tryExtract(await ocrBuffer(
      await sharp(buffer)
        .extract({ left: 0, top: Math.floor(meta.height * 0.70),
                   width: Math.floor(meta.width * 0.60), height: Math.floor(meta.height * 0.30) })
        .greyscale().normalise()
        .resize({ width: 900, kernel: 'lanczos3' })
        .sharpen({ sigma: 2 })
        .toBuffer(),
      worker
    ));
    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
    if (resLeftBot.found) return toIso(resLeftBot);

    // Pass E: нижняя полоса с инверсией — тёмный текст на светлом фоне
    const resInv = tryExtract(await ocrBuffer(
      await sharp(buffer)
        .extract({ left: 0, top: stripTop, width: meta.width, height: stripH })
        .greyscale().normalise().negate()
        .resize({ width: 1200, kernel: 'lanczos3' })
        .sharpen({ sigma: 2 })
        .toBuffer(),
      worker
    ));
    if (resInv.found) return toIso(resInv);

    return null;
  } catch {
    return null;
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {});
  }
}

async function downloadPhoto(photoUrl) {
  const url = `${SUPABASE_URL}/storage/v1/object/${photoUrl}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Storage download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function updateEvent(eventId, photoTimestamp, newStatus, currentFlags) {
  const body = { photo_timestamp: photoTimestamp };
  if (newStatus) body.status = newStatus;

  if (newStatus === 'pending') {
    // Сброс к pending означает полную переоценку — очищаем все флаги.
    // ai-worker пересчитает double_shift, face_mismatch и др. с новым корректным timestamp.
    body.fraud_flags = [];
  } else if (currentFlags && currentFlags.length > 0) {
    // Просто обновляем timestamp (статус не меняется) — убираем только timestamp-флаги.
    const TIMESTAMP_FLAGS = new Set(['no_photo_time', 'time_from_telegram']);
    const remaining = currentFlags.filter(f => !TIMESTAMP_FLAGS.has(f));
    if (remaining.length !== currentFlags.length) {
      body.fraud_flags = remaining;
    }
  }

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
  const worker = await Tesseract.createWorker('rus+eng');

  try {
    // BUG-050: пагинация — Supabase отдаёт максимум 1000 строк за раз
    const PAGE_SIZE = 1000;
    let offset = 0;
    let events = [];
    while (true) {
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/events?photo_url=not.is.null&photo_timestamp=is.null&created_at=gte.2026-05-01T00:00:00Z&select=id,photo_url,photo_timestamp,status,created_at,fraud_flags&order=id.asc&limit=${PAGE_SIZE}&offset=${offset}`,
        { headers: HEADERS }
      );
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const page = await res.json();
      events = events.concat(page);
      if (page.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }
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

        // Отклоняем даты явно в будущем (+6ч grace — OCR на недавних фото не ошибается)
        if (new Date(ocrTime) > new Date(Date.now() + 6 * 3600 * 1000)) {
          console.warn(`  ⚠️  Event ${ev.id}: future date rejected (${ocrTime})`);
          continue;
        }

        // Отклоняем даты раньше 2026-01-01 — тоже явная ошибка OCR
        if (new Date(ocrTime) < new Date('2026-01-01T00:00:00Z')) {
          console.warn(`  ⚠️  Event ${ev.id}: implausible date rejected (${ocrTime})`);
          continue;
        }

        // Если photo_timestamp был null — всегда обновляем
        const hadNoTimestamp = !ev.photo_timestamp;
        if (!hadNoTimestamp) {
          const diffMs = Math.abs(new Date(ocrTime) - new Date(ev.photo_timestamp));
          if (diffMs / 60000 < 2) continue;
        }

        console.log(`  ✏️  Event ${ev.id}: ${ev.photo_timestamp || 'null'} → ${ocrTime}`);

        const newStatus = (ev.status === 'done' || ev.status === 'needs_review') ? 'pending' : null;
        await updateEvent(ev.id, ocrTime, newStatus, ev.fraud_flags);
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
