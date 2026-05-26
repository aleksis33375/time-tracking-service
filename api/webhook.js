/**
 * Telegram Webhook Handler — Vercel Serverless Function
 * POST /api/webhook
 */

import { timingSafeEqual } from 'crypto';
import sharp from 'sharp';
import exifReader from 'exif-reader';
import Tesseract from 'tesseract.js';
import { waitUntil } from '@vercel/functions';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN            = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET       = process.env.TELEGRAM_WEBHOOK_SECRET;
const TG_API               = `https://api.telegram.org/bot${BOT_TOKEN}`;

const SUPABASE_HEADERS = {
  apikey:         SUPABASE_SERVICE_KEY,
  Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

const MAX_PHOTO_BYTES = 150 * 1024; // 150 КБ

// ── Entry point ───────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  // Validate secret token (BUG-038: constant-time compare prevents timing attacks)
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (!WEBHOOK_SECRET || !secret) {
    return res.status(403).end();
  }
  const secretBuf   = Buffer.from(secret);
  const expectedBuf = Buffer.from(WEBHOOK_SECRET);
  if (secretBuf.length !== expectedBuf.length || !timingSafeEqual(secretBuf, expectedBuf)) {
    return res.status(403).end();
  }

  // Отвечаем 200 сразу — Telegram не будет повторять запрос
  res.status(200).json({ ok: true });

  // waitUntil гарантирует что Vercel не заморозит функцию до завершения обработки
  const update = req.body;
  waitUntil(
    processUpdate(update).catch(err => {
      console.error('Webhook error:', err);
      return logToSupabase('error', 'webhook-handler', `Unhandled error: ${err.message}`, { stack: err.stack });
    })
  );
}

// ── Update router ─────────────────────────────────────────────────────────────

async function processUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return;

  // Обрабатываем только фото
  if (!msg.photo || msg.photo.length === 0) return;

  await handlePhoto(msg);
}

// ── Photo handler ─────────────────────────────────────────────────────────────

async function handlePhoto(msg) {
  const chatId    = msg.chat.id;
  const messageId = msg.message_id;
  console.log('Photo received', { chatId, messageId });

  const largest = msg.photo[msg.photo.length - 1];

  let compressedBuffer = null;
  let photoUrl         = null;
  let stampTimestamp   = null;
  let timeSource       = 'none';

  let originalBuffer;
  try {
    originalBuffer = await downloadTelegramPhoto(largest.file_id);
  } catch (err) {
    await logToSupabase('error', 'webhook-handler', `Download failed: ${err.message}`, { chatId, messageId });
    return;
  }

  try {
    // EXIF читаем с оригинала (compression strip-ит метаданные)
    const exif = await extractExifTimestamp(originalBuffer);
    if (exif) {
      stampTimestamp = exif;
      timeSource = 'exif';
    }

    // Сжимаем до ~1200px — OCR запускается на сжатом фото
    compressedBuffer = await compressPhoto(originalBuffer);
    const originalKb   = Math.round(originalBuffer.length   / 1024);
    const compressedKb = Math.round(compressedBuffer.length / 1024);
    console.log(`Photo: ${originalKb} KB → ${compressedKb} KB`);
  } catch (err) {
    await logToSupabase('warn', 'webhook-handler', `Photo processing failed: ${err.message}`, { chatId, messageId });
  }

  // OCR timestamp — только если EXIF не нашёл дату
  if (!stampTimestamp && compressedBuffer) {
    const ocr = await extractOcrTimestamp(compressedBuffer);
    if (ocr) {
      stampTimestamp = ocr;
      timeSource = 'ocr';
    }
  }

  console.log(`time_source: ${timeSource}, stamp: ${stampTimestamp || 'none'}`);

  // Третий проход: имя + тип события с фото (rus+eng), fallback — Telegram caption
  let caption = parseCaptionText(msg.caption || '');
  if (compressedBuffer) {
    const ocrCaption = await extractOcrCaption(compressedBuffer);
    if (ocrCaption.nameFromPhoto || ocrCaption.eventType) {
      caption = {
        nameFromPhoto: ocrCaption.nameFromPhoto || caption.nameFromPhoto,
        eventType:     ocrCaption.eventType     || caption.eventType,
        eventTypeRaw:  ocrCaption.eventTypeRaw  || caption.eventTypeRaw,
        rawCaption:    ocrCaption.rawCaption,
      };
    }
  }
  console.log('Caption:', caption);

  if (compressedBuffer) {
    photoUrl = await uploadPhotoToStorage(compressedBuffer, chatId, messageId);
    if (!photoUrl) {
      await logToSupabase('warn', 'webhook-handler', 'Failed to upload photo to storage', { chatId, messageId });
    }
  }

  if (!stampTimestamp) {
    await logToSupabase('warn', 'webhook-handler',
      'No photo timestamp (no EXIF, no OCR date+time). Saving as pending.', {
        chatId, messageId, name: caption.nameFromPhoto,
      });
  }

  // Всегда status:'pending' — даже если штамп не прочитался
  await insertEvent({
    photo_url:       photoUrl,
    photo_timestamp: stampTimestamp,
    status:          'pending',
    name_from_photo: caption.nameFromPhoto,
    event_type:      caption.eventType,
    event_type_raw:  caption.eventTypeRaw,
    fraud_flags:     stampTimestamp ? [] : ['no_photo_time'],
  });

  await logToSupabase('info', 'webhook-handler', 'Event created', {
    name:        caption.nameFromPhoto,
    event:       caption.eventTypeRaw,
    photo:       photoUrl ? 'ok' : 'missing',
    time_source: timeSource,
    photo_time:  stampTimestamp,
  });
}

// ── Caption parser ────────────────────────────────────────────────────────────

const ARRIVAL_PATTERNS = [
  /начал[оа].*смен/i,
  /начал[оа]/i,
  /приход/i,
  /пришёл/i,
  /пришел/i,
];
const DEPARTURE_PATTERNS = [
  /конец.*смен/i,
  /конца/i,              // "конца смены", "конца втарои смены"
  /окончани[ея].*смен/i,
  /кан[её]?[цч][аыео]?/i, // "канца", "канец", "канча" — ошибочное написание "конца"
  /уход/i,
  /ушёл/i,
  /ушел/i,
];

// Ключевые слова для извлечения имени (всё до первого из них = имя)
const EVENT_KEYWORDS_RE =
  /^(.+?)\s+(?:начал[оа]|конец|конца|окончани[ея]|кан[её]?[цч]|приход|уход|пришёл|пришел|ушёл|ушел)/i;

// Убирает trailing/leading знаки препинания и лишние пробелы из имени
function cleanName(str) {
  if (!str) return null;
  const s = str.replace(/^[\s.,!?;:]+|[\s.,!?;:]+$/g, '').trim();
  return s || null;
}

function parseCaptionText(raw) {
  const text = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Определяем тип события
  let eventType    = null;   // 'arrival' | 'departure'
  let eventTypeRaw = null;   // оригинальная фраза из текста

  if (ARRIVAL_PATTERNS.some(p => p.test(text))) {
    eventType    = 'arrival';
    eventTypeRaw = 'начало смены';
  } else if (DEPARTURE_PATTERNS.some(p => p.test(text))) {
    eventType    = 'departure';
    eventTypeRaw = 'конец смены';
  }

  // Имя = всё до первого ключевого слова события
  // Примеры: "Дима начало смены" → "Дима"
  //          "Али канца втарои смены" → "Али"
  //          "Начало смены Андрей!" → "Андрей"  (имя после ключевого слова)
  let nameFromPhoto = null;
  const nameMatch = text.match(EVENT_KEYWORDS_RE);
  if (nameMatch) {
    nameFromPhoto = cleanName(nameMatch[1]);
  } else if (eventType) {
    // Тип определён, но имя не найдено до ключевого слова → ищем после.
    // Убираем ключевые слова события и служебные слова ("смены", "второй" и т.п.)
    const remainder = text
      .replace(/(?:начал[оа]|конец|конца|окончани[ея]|кан[её]?[цч]\w*|приход|уход|пришёл|пришел|ушёл|ушел)\b/gi, '')
      .replace(/\bсмен\w*/gi, '')
      .replace(/\b(?:второй|первой|третьей|втарои|второго|первого)\b/gi, '')
      .replace(/[!.,\s]+/g, ' ')
      .trim();
    nameFromPhoto = cleanName(remainder) || null;
  } else if (text.length > 0) {
    // Тип не распознан — весь текст считаем именем
    nameFromPhoto = cleanName(text);
  }

  return {
    nameFromPhoto,   // "Дима" или "Петров Иван"
    eventType,       // 'arrival' | 'departure' | null
    eventTypeRaw,    // "начало смены" | "конец смены" | null
    rawCaption: text,
  };
}

// ── Telegram helpers ──────────────────────────────────────────────────────────

async function downloadTelegramPhoto(fileId) {
  // Шаг 1: получаем путь к файлу
  const infoRes  = await fetch(`${TG_API}/getFile?file_id=${fileId}`);
  const infoJson = await infoRes.json();
  if (!infoJson.ok || !infoJson.result?.file_path) {
    throw new Error(`getFile failed: ${JSON.stringify(infoJson)}`);
  }

  // Шаг 2: скачиваем файл
  const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${infoJson.result.file_path}`;
  const fileRes  = await fetch(fileUrl);
  if (!fileRes.ok) {
    throw new Error(`File download failed: HTTP ${fileRes.status} ${fileRes.statusText}`);
  }

  const arrayBuf = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuf);
}

async function extractExifTimestamp(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.exif) {
      console.log('EXIF: absent (photo sent as image, not file)');
      return null;
    }
    const parsed = exifReader(meta.exif);
    // exif-reader v2: DateTimeOriginal лежит в parsed.Photo или parsed.exif
    const dt = parsed?.Photo?.DateTimeOriginal || parsed?.exif?.DateTimeOriginal;
    if (!(dt instanceof Date) || isNaN(dt.getTime())) {
      console.log('EXIF: present but DateTimeOriginal invalid or missing');
      return null;
    }
    // exif-reader читает время как UTC, но EXIF хранит местное время (МСК, UTC+3).
    // Вычитаем 3 часа чтобы получить настоящий UTC.
    const utcMs = dt.getTime() - 3 * 60 * 60 * 1000;
    return new Date(utcMs).toISOString();
  } catch (err) {
    console.warn('EXIF parse failed:', err.message);
    return null;
  }
}

async function extractOcrTimestamp(buffer) {
  try {
    // Полное изображение, без кропа — штамп найдётся где бы он ни стоял
    const preparedBuf = await sharp(buffer)
      .greyscale()
      .normalise()
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    // Проход 1: только цифры — для числовой даты (07.05.2026) + времени (HH:MM:SS)
    const ocrNum = await Promise.race([
      Tesseract.recognize(preparedBuf, 'eng', {
        tessedit_char_whitelist: '0123456789:./-',
        tessedit_pageseg_mode: '6',
      }),
      new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 12000)),
    ]).catch(() => null);

    const numText = ocrNum?.data?.text || '';
    console.log('OCR num:', numText.trim());

    const timeMatch = numText.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!timeMatch) {
      console.log('OCR: time pattern not found');
      return null;
    }
    const [, h, m, s] = timeMatch;

    const dateMatchDMY = numText.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
    const dateMatchYMD = numText.match(/(\d{4})[-./](\d{2})[-./](\d{2})/);

    let day, month, year;

    if (dateMatchDMY) {
      [, day, month, year] = dateMatchDMY;
      console.log('OCR date (numeric DMY):', `${day}.${month}.${year}`);
    } else if (dateMatchYMD) {
      [, year, month, day] = dateMatchYMD;
      console.log('OCR date (numeric YMD):', `${year}-${month}-${day}`);
    } else {
      // Проход 2: русские/английские названия месяцев («7 мая 2026 г.»)
      console.log('OCR: numeric date not found, trying month-name pass...');
      const ocrRus = await Promise.race([
        Tesseract.recognize(preparedBuf, 'rus+eng', { tessedit_pageseg_mode: '6' }),
        new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 10000)),
      ]).catch(() => null);

      const rusText = ocrRus?.data?.text || '';
      console.log('OCR rus:', rusText.trim());

      const RU_MONTHS = {
        'янв':1,'фев':2,'мар':3,'апр':4,'май':5,'мая':5,
        'июн':6,'июл':7,'авг':8,'сен':9,'окт':10,'ноя':11,'дек':12,
      };
      const EN_MONTHS = {
        'jan':1,'feb':2,'mar':3,'apr':4,'may':5,'jun':6,
        'jul':7,'aug':8,'sep':9,'oct':10,'nov':11,'dec':12,
      };

      const mMatch = rusText.match(/(\d{1,2})\s+([а-яёa-z]{3,})[а-яёa-z]*\.?\s+(\d{4})/i);
      if (mMatch) {
        const key  = mMatch[2].toLowerCase().slice(0, 3);
        const mNum = RU_MONTHS[key] || EN_MONTHS[key];
        if (mNum) {
          day   = mMatch[1];
          month = String(mNum);
          year  = mMatch[3];
          console.log('OCR date (month name):', `${day} ${mMatch[2]} ${year}`);
        }
      }
    }

    if (!day || !month || !year) {
      console.log('OCR: date not found in stamp');
      return null;
    }

    const moscowMs = Date.UTC(parseInt(year), parseInt(month) - 1, parseInt(day),
                               parseInt(h), parseInt(m), parseInt(s));
    const utcMs    = moscowMs - 3 * 3600 * 1000;
    const result   = new Date(utcMs).toISOString();
    console.log('OCR timestamp:', result);
    return result;
  } catch (err) {
    console.warn('OCR failed:', err.message);
    return null;
  }
}

async function extractOcrCaption(buffer) {
  try {
    const preparedBuf = await sharp(buffer)
      .greyscale()
      .normalise()
      .sharpen({ sigma: 1.5 })
      .toBuffer();

    const ocrResult = await Promise.race([
      Tesseract.recognize(preparedBuf, 'rus+eng', { tessedit_pageseg_mode: '6' }),
      new Promise((_, r) => setTimeout(() => r(new Error('OCR timeout')), 10000)),
    ]).catch(() => null);

    const text = ocrResult?.data?.text || '';
    console.log('OCR caption text:', text.trim().slice(0, 120));
    return parseCaptionText(text);
  } catch (err) {
    console.warn('OCR caption failed:', err.message);
    return { nameFromPhoto: null, eventType: null, eventTypeRaw: null, rawCaption: '' };
  }
}

async function compressPhoto(buffer) {
  // Первый проход: resize до 1200px по ширине, quality 82
  let result = await sharp(buffer)
    .rotate()                          // авто-поворот по EXIF
    .resize({ width: 1200, withoutEnlargement: true })
    .jpeg({ quality: 82, progressive: true })
    .toBuffer();

  if (result.length <= MAX_PHOTO_BYTES) return result;

  // Если всё ещё больше 150 КБ — снижаем quality итерационно
  for (const quality of [70, 60, 50, 40]) {
    result = await sharp(buffer)
      .rotate()
      .resize({ width: 1200, withoutEnlargement: true })
      .jpeg({ quality, progressive: true })
      .toBuffer();
    if (result.length <= MAX_PHOTO_BYTES) break;
  }

  return result;
}

// ── Events ────────────────────────────────────────────────────────────────────

async function insertEvent(fields) {
  const res = await supabaseFetch('/rest/v1/events', {
    method:  'POST',
    headers: { Prefer: 'return=minimal' },
    body:    JSON.stringify(fields),
  });
  if (res && (res.message || res.code)) {
    console.error('insertEvent failed:', res);
  }
  return res;
}

// ── Storage upload ────────────────────────────────────────────────────────────

async function uploadPhotoToStorage(buffer, chatId, messageId) {
  // Путь: photos/{chatId}/{messageId}.jpg
  const path = `${chatId}/${messageId}.jpg`;
  const res  = await fetch(`${SUPABASE_URL}/storage/v1/object/photos/${path}`, {
    method:  'PUT',
    headers: {
      apikey:         SUPABASE_SERVICE_KEY,
      Authorization:  `Bearer ${SUPABASE_SERVICE_KEY}`,
      'Content-Type': 'image/jpeg',
      'x-upsert':     'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    console.error('Storage upload failed:', res.status, await res.text());
    return null;
  }
  // Возвращаем путь — подписанный URL генерируется по запросу
  return `photos/${path}`;
}

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function supabaseFetch(path, options = {}) {
  const res  = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: { ...SUPABASE_HEADERS, ...(options.headers || {}) },
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}

async function logToSupabase(level, source, message, meta = {}) {
  try {
    await supabaseFetch('/rest/v1/logs', {
      method: 'POST',
      body: JSON.stringify({ level, source, message, meta }),
    });
  } catch (err) {
    console.error('logToSupabase failed:', err);
  }
}

export { supabaseFetch, logToSupabase };
