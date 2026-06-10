/**
 * OCR Worker — extract photo_timestamp from recent events
 * Runs every 5 min via GitHub Actions, processes events from the last 4 hours.
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

const RU_MONTHS = {
  'янв':1,'фев':2,'мар':3,'апр':4,'май':5,'мая':5,
  'июн':6,'июл':7,'авг':8,'сен':9,'окт':10,'ноя':11,'дек':12,
};
const EN_MONTHS = {
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
    const mNum = RU_MONTHS[key] || EN_MONTHS[key];
    if (mNum) return { found: true, day: full[1], month: mNum, year: full[3], h: full[4], m: full[5], s: full[6] || '0' };
  }

  const time  = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);  // HH:MM:SS
  const timeHM = t.match(/\b(\d{1,2}):(\d{2})\b/);      // HH:MM без секунд
  const dmy   = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  const ymd   = t.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);

  // Нормализуем 2-значный год (26 → 2026)
  function normalizeYear(y) { return y.length === 2 ? String(2000 + parseInt(y)) : y; }

  if (time && dmy) return { found: true, day: dmy[1], month: parseInt(dmy[2]), year: normalizeYear(dmy[3]), h: time[1], m: time[2], s: time[3] };
  if (time && ymd) return { found: true, day: ymd[3], month: parseInt(ymd[2]), year: ymd[1], h: time[1], m: time[2], s: time[3] };
  // HH:MM без секунд — только когда дата тоже найдена
  if (timeHM && dmy) return { found: true, day: dmy[1], month: parseInt(dmy[2]), year: normalizeYear(dmy[3]), h: timeHM[1], m: timeHM[2], s: '0' };
  if (timeHM && ymd) return { found: true, day: ymd[3], month: parseInt(ymd[2]), year: ymd[1], h: timeHM[1], m: timeHM[2], s: '0' };
  return { found: false };
}

function toIso({ day, month, year, h, m, s = '0' }) {
  const moscowMs = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day),
                             parseInt(h), parseInt(m), parseInt(s));
  return new Date(moscowMs - 3 * 3600 * 1000).toISOString();
}

function isValidDate(isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return false;
  if (d > new Date()) return false;                    // будущее → ошибка OCR
  if (d < new Date('2026-01-01T00:00:00Z')) return false; // слишком старое → ошибка OCR
  return true;
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
    // Pass A: полное изображение
    const fullBuf = await sharp(buffer)
      .greyscale()
      .normalise()
      .resize({ width: 1600, withoutEnlargement: true, kernel: 'lanczos3' })
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    await worker.setParameters({ tessedit_pageseg_mode: '6' }).catch(() => {});
    const resA = tryExtract(await ocrBuffer(fullBuf, worker));
    if (resA.found) return toIso(resA);

    // Pass B: угловые вырезки (правые 60% × верх/низ 30%)
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

async function updateEvent(eventId, photoTimestamp, currentFlags, eventStatus) {
  // Убираем no_photo_time — время успешно считано с фото
  const newFlags = (currentFlags || []).filter(f => f !== 'no_photo_time');
  const patch = {
    photo_timestamp: photoTimestamp,
    fraud_flags:     newFlags,
  };
  // Если событие уже обработано — сбрасываем в pending, AI worker пересчитает часы
  if (eventStatus === 'done') {
    patch.status = 'pending';
  }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/events?id=eq.${eventId}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
}

async function main() {
  console.log('🔄 OCR Worker started');

  let worker = null;
  try {
    worker = await Tesseract.createWorker('rus+eng');

    const since = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/events?photo_url=not.is.null&photo_timestamp=is.null&created_at=gte.${since}&select=id,photo_url,fraud_flags,status,event_type&limit=200`,
      { headers: HEADERS }
    );
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

    const events = await res.json();
    console.log(`📦 Found ${events.length} events without timestamp`);

    let updated = 0;

    for (const ev of events) {
      try {
        const photo = await downloadPhoto(ev.photo_url);
        const ocrTime = await extractOcrTimestamp(photo, worker);

        if (!ocrTime) {
          console.log(`  — Event ${ev.id}: OCR found no timestamp`);
          continue;
        }

        if (!isValidDate(ocrTime)) {
          console.warn(`  ⚠️  Event ${ev.id}: invalid/implausible date rejected (${ocrTime})`);
          continue;
        }

        await updateEvent(ev.id, ocrTime, ev.fraud_flags, ev.status);
        updated++;
        console.log(`  ✏️  Event ${ev.id}: → ${ocrTime}`);
      } catch (err) {
        console.warn(`  ⚠️  Event ${ev.id}: ${err.message}`);
      }
    }

    console.log(`✅ OCR Worker: ${updated}/${events.length} events updated`);
  } catch (err) {
    // Не останавливаем pipeline — AI-worker должен запуститься в любом случае
    console.error('❌ OCR Worker failed:', err.message);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
  }
}

// .catch гарантирует что необработанное исключение не даёт exit code 1
main().catch(err => console.error('❌ OCR Worker fatal:', err.message));
