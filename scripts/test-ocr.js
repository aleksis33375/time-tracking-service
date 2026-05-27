/**
 * OCR Test — compares full-image [A], corner-crop [B], and combined [C].
 * Run: node scripts/test-ocr.js
 */

import sharp from 'sharp';
import Tesseract from 'tesseract.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HEADERS      = {
  apikey:        SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
};

const RU = { 'янв':1,'фев':2,'мар':3,'апр':4,'май':5,'мая':5,'июн':6,'июл':7,'авг':8,'сен':9,'окт':10,'ноя':11,'дек':12 };
const EN = { 'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,'jul':7,'aug':8,'sep':9,'oct':10,'nov':11,'dec':12 };

async function downloadPhoto(photoUrl) {
  const url = `${SUPABASE_URL}/storage/v1/object/${photoUrl}`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function prepareText(raw) {
  // Нормализуем частые ошибки OCR:
  // "22101:56" → "22:01:56" (цифра 1 вместо двоеточия)
  // "mas"/"mai" → "мая" (латиница вместо кириллицы)
  return raw
    .replace(/(\d{2})1(\d{2}):(\d{2})/g, '$1:$2:$3')  // 22101:56 → 22:01:56
    .replace(/(\d{1,2})\s*mas\s*(\d{4})/gi, '$1 мая $2')
    .replace(/(\d{1,2})\s*mai\s*(\d{4})/gi, '$1 мая $2')
    .replace(/(\d{1,2})\s*map\s*(\d{4})/gi, '$1 мар $2')
    .replace(/г[;,]/g, 'г.');
}

function tryExtract(text) {
  const t = prepareText(text);

  // Полный штамп: "26 мая 2026 г. 22:01:56"
  const full = t.match(/(\d{1,2})\s*([а-яёa-z]{3,})\s*(\d{4})[^0-9]+(\d{1,2}):(\d{2}):(\d{2})/i);
  if (full) {
    const key  = full[2].toLowerCase().slice(0, 3);
    const mNum = RU[key] || EN[key];
    if (mNum) {
      return { found: true, result: `${full[1]} ${full[2]} ${full[3]} ${full[4]}:${full[5]}:${full[6]}`, type: 'full-ru' };
    }
  }

  // Числовая дата + время
  const time = t.match(/(\d{1,2}):(\d{2}):(\d{2})/);
  const dmy  = t.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
  const ymd  = t.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);
  if (time && (dmy || ymd)) {
    const d = dmy ? `${dmy[1]}.${dmy[2]}.${dmy[3]}` : `${ymd[1]}-${ymd[2]}-${ymd[3]}`;
    return { found: true, result: `${d} ${time[0]}`, type: 'numeric' };
  }
  if (time) {
    return { found: false, partial: `только время: ${time[0]}` };
  }
  return { found: false };
}

async function ocrImage(buf, worker, psm = '6') {
  await worker.setParameters({ tessedit_pageseg_mode: psm }).catch(() => {});
  const result = await Promise.race([
    worker.recognize(buf),
    new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 15000)),
  ]).catch(() => null);
  return result?.data?.text || '';
}

async function prepareFullImage(buffer) {
  return sharp(buffer)
    .greyscale()
    .normalise()
    .resize({ width: 1600, withoutEnlargement: true, kernel: 'lanczos3' })
    .sharpen({ sigma: 1.5 })
    .toBuffer();
}

async function prepareCorners(buffer) {
  const meta  = await sharp(buffer).metadata();
  const imgW  = meta.width;
  const imgH  = meta.height;
  const cropL = Math.floor(imgW * 0.40);
  const cropW = imgW - cropL;
  const cornH = Math.floor(imgH * 0.30);

  const makeCorner = (top) =>
    sharp(buffer)
      .extract({ left: cropL, top, width: cropW, height: cornH })
      .greyscale()
      .normalise()
      .resize({ width: 900, kernel: 'lanczos3' })
      .sharpen({ sigma: 1.5 })
      .toBuffer();

  return [
    await makeCorner(0),               // top-right
    await makeCorner(imgH - cornH),    // bottom-right
  ];
}

async function main() {
  console.log('=== OCR Test: [A] full / [B] crop / [C] combined+fix ===\n');

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/events?photo_url=not.is.null&photo_timestamp=is.null&select=id,photo_url&limit=3&order=created_at.desc`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const events = await res.json();

  if (events.length === 0) { console.log('Нет событий для теста.'); return; }
  console.log(`Тестируем ${events.length} фото.\n`);

  const worker = await Tesseract.createWorker('rus+eng');

  let cSuccess = 0;

  try {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      console.log(`── Фото ${i+1}/3 (event ${ev.id}) ──`);

      const buffer = await downloadPhoto(ev.photo_url);
      const meta   = await sharp(buffer).metadata();
      console.log(`  Размер: ${meta.width}×${meta.height}px`);

      // [A] Полное изображение
      const fullBuf  = await prepareFullImage(buffer);
      const fullText = await ocrImage(fullBuf, worker, '6');
      const resA     = tryExtract(fullText);
      console.log(`  [A] читает: "${fullText.replace(/\n/g,' ').trim().slice(0,100)}"`);
      console.log(`  [A] → ${resA.found ? '✅ ' + resA.result : resA.partial ? '⚠️  ' + resA.partial : '❌ не найдено'}`);

      // [B] Кроп углов
      const [topBuf, botBuf] = await prepareCorners(buffer);
      const topText = await ocrImage(topBuf, worker, '6');
      const botText = await ocrImage(botBuf, worker, '6');
      const resTop  = tryExtract(topText);
      const resBot  = tryExtract(botText);
      console.log(`  [B] top: "${topText.replace(/\n/g,' ').trim().slice(0,80)}"`);
      console.log(`  [B] bot: "${botText.replace(/\n/g,' ').trim().slice(0,80)}"`);
      console.log(`  [B] top → ${resTop.found ? '✅ ' + resTop.result : resTop.partial ? '⚠️  ' + resTop.partial : '❌'}`);
      console.log(`  [B] bot → ${resBot.found ? '✅ ' + resBot.result : resBot.partial ? '⚠️  ' + resBot.partial : '❌'}`);

      // [C] Комбинированный — первый успешный из A, B-top, B-bot
      const combined = [resA, resTop, resBot].find(r => r.found);
      if (combined) {
        console.log(`  [C] ✅ ИТОГ: ${combined.result}`);
        cSuccess++;
      } else {
        console.log(`  [C] ❌ Ни один подход не нашёл штамп`);
      }

      console.log('');
    }
  } finally {
    await worker.terminate();
  }

  console.log(`=== Итог: [C] нашёл штамп в ${cSuccess}/3 фото ===`);
}

main().catch(err => { console.error('Ошибка:', err.message); process.exit(1); });
