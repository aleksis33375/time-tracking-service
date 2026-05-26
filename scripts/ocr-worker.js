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

async function extractOcrTimestamp(buffer, worker) {
  try {
    const preparedBuf = await sharp(buffer)
      .greyscale()
      .normalise()
      .resize({ width: 1600, withoutEnlargement: true, kernel: 'lanczos3' })
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    // Проход 1: числовая дата + время
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
      // Проход 2: имена месяцев — тот же worker с PSM 11 (сканирует весь кадр)
      await worker.setParameters({ tessedit_pageseg_mode: '11' }).catch(() => {});
      const ocrRus = await Promise.race([
        worker.recognize(preparedBuf),
        new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 15000)),
      ]).catch(() => null);
      await worker.setParameters({ tessedit_pageseg_mode: '3' }).catch(() => {});

      const rusText = ocrRus?.data?.text || '';
      const mMatch = rusText.match(/(\d{1,2})\s+([а-яёa-z]{3,})[а-яёa-z]*\.?,?\s+(\d{4})/i);
      if (mMatch) {
        const key  = mMatch[2].toLowerCase().slice(0, 3);
        const mNum = RU_MONTHS[key] || EN_MONTHS[key];
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

async function updateEvent(eventId, photoTimestamp) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/events?id=eq.${eventId}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify({ photo_timestamp: photoTimestamp }),
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
}

async function main() {
  console.log('🔄 OCR Worker started');

  const worker = await Tesseract.createWorker('rus+eng');

  try {
    const since = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/events?photo_url=not.is.null&photo_timestamp=is.null&created_at=gte.${since}&select=id,photo_url&limit=50`,
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

        if (!ocrTime) continue;

        await updateEvent(ev.id, ocrTime);
        updated++;
        console.log(`  ✏️  Event ${ev.id}: → ${ocrTime}`);
      } catch (err) {
        console.warn(`  ⚠️  Event ${ev.id}: ${err.message}`);
      }
    }

    console.log(`OCR Worker: ${updated}/${events.length} events updated`);
  } catch (err) {
    console.error('❌ OCR Worker failed:', err.message);
    process.exit(1);
  } finally {
    await worker.terminate();
  }
}

main();
