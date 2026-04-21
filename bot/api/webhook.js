/**
 * Telegram Webhook Handler — Vercel Serverless Function
 * POST /api/webhook
 */

import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BOT_TOKEN            = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET       = process.env.TELEGRAM_WEBHOOK_SECRET;
const OBJECT_POSTCODE      = process.env.OBJECT_POSTCODE;
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

  // Validate secret token (item 4)
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
    return res.status(403).end();
  }

  try {
    const update = req.body;
    await processUpdate(update);
  } catch (err) {
    console.error('Webhook error:', err);
    await logToSupabase('error', 'webhook-handler', `Unhandled error: ${err.message}`, { stack: err.stack });
  }

  // Всегда 200 — иначе Telegram будет повторять запрос
  res.status(200).json({ ok: true });
}

// ── Update router ─────────────────────────────────────────────────────────────

async function processUpdate(update) {
  const msg = update.message || update.channel_post;
  if (!msg) return;

  // Обрабатываем только фото (item 5)
  if (!msg.photo || msg.photo.length === 0) return;

  await handlePhoto(msg);
}

// ── Photo handler ─────────────────────────────────────────────────────────────

async function handlePhoto(msg) {
  const chatId    = msg.chat.id;
  const messageId = msg.message_id;

  // Telegram присылает несколько размеров — берём наибольший
  const largest = msg.photo[msg.photo.length - 1];

  // Скачиваем оригинал с серверов Telegram
  const originalBuffer = await downloadTelegramPhoto(largest.file_id);
  if (!originalBuffer) {
    await logToSupabase('error', 'webhook-handler', 'Failed to download photo', { chatId, messageId });
    return;
  }

  // Сжимаем до ≤150 КБ
  const compressedBuffer = await compressPhoto(originalBuffer);

  const originalKb   = Math.round(originalBuffer.length   / 1024);
  const compressedKb = Math.round(compressedBuffer.length / 1024);
  console.log(`Photo: ${originalKb} KB → ${compressedKb} KB`);

  // OCR верхней правой области: дата, время, город, индекс (item 7)
  const stamp = await ocrTopRight(compressedBuffer);
  console.log('Stamp OCR:', stamp);

  // OCR нижней области: имя сотрудника + тип события (item 8)
  const caption = await ocrBottom(compressedBuffer);
  console.log('Caption OCR:', caption);

  // Сверка индекса с OBJECT_POSTCODE (item 9)
  const fraudFlags = [];
  if (stamp.postcode && OBJECT_POSTCODE && stamp.postcode !== OBJECT_POSTCODE) {
    fraudFlags.push('wrong_location');
    console.log(`wrong_location: got ${stamp.postcode}, expected ${OBJECT_POSTCODE}`);
  }

  // Сохранение сжатого фото в Supabase Storage (item 10)
  const photoUrl = await uploadPhotoToStorage(compressedBuffer, chatId, messageId);
  if (!photoUrl) {
    await logToSupabase('error', 'webhook-handler', 'Failed to upload photo to storage', { chatId, messageId });
    return;
  }

  // Запись в events (item 11)
  await insertEvent({
    photo_url:           photoUrl,
    photo_timestamp:     stamp.photoTimestamp,
    status:              'pending',
    name_from_photo:     caption.nameFromPhoto,
    event_type:          caption.eventType,
    event_type_raw:      caption.eventTypeRaw,
    postcode_from_photo: stamp.postcode,
    fraud_flags:         fraudFlags,
  });

  await logToSupabase('info', 'webhook-handler', 'Event created', {
    name: caption.nameFromPhoto,
    event: caption.eventTypeRaw,
    postcode: stamp.postcode,
    fraud: fraudFlags,
  });
}

// ── OCR: верхняя правая область (штамп Timestamp Camera) ─────────────────────

// Ленивый синглтон воркера — переиспользуется в рамках одного контейнера
let _worker = null;
async function getTesseractWorker() {
  if (!_worker) {
    _worker = await createWorker(['rus', 'eng'], 1, {
      cachePath: '/tmp',       // кеш внутри Vercel-контейнера
      cacheMethod: 'readWrite',
    });
  }
  return _worker;
}

async function ocrTopRight(buffer) {
  const meta = await sharp(buffer).metadata();
  const { width, height } = meta;

  // Stamp занимает правые ~55% и верхние ~22% фото
  const cropW = Math.floor(width  * 0.55);
  const cropH = Math.floor(height * 0.22);
  const cropL = width - cropW;

  const region = await sharp(buffer)
    .extract({ left: cropL, top: 0, width: cropW, height: cropH })
    .resize({ width: cropW * 2 })   // увеличиваем для лучшего распознавания
    .greyscale()
    .normalize()                    // авто-контраст
    .sharpen()
    .jpeg({ quality: 95 })
    .toBuffer();

  const worker = await getTesseractWorker();
  const { data: { text } } = await worker.recognize(region);
  return parseStampText(text);
}

const MONTHS_RU = {
  'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4,
  'май': 5, 'мая': 5, 'июн': 6, 'июл': 7,
  'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
};

function parseStampText(raw) {
  const text = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();

  // Время: HH:MM:SS  (OCR иногда путает : и .)
  const timeM = text.match(/(\d{1,2})[:.](\d{2})[:.](\d{2})/);

  // Дата с русским месяцем: "16 апр. 2026 г."
  const dateM = text.match(/(\d{1,2})\s+([а-яёА-ЯЁ]{2,4})\.?\s+(\d{4})/);

  // Индекс: 6 цифр подряд
  const postcodeM = text.match(/\b(\d{6})\b/);

  let photoTimestamp = null;
  if (dateM && timeM) {
    const day   = parseInt(dateM[1], 10);
    const month = MONTHS_RU[dateM[2].toLowerCase().slice(0, 3)];
    const year  = parseInt(dateM[3], 10);
    const hh    = parseInt(timeM[1], 10);
    const mm    = parseInt(timeM[2], 10);
    const ss    = parseInt(timeM[3], 10);
    if (month) {
      // Фото сделано в Москве (UTC+3) — конвертируем в UTC
      const utc = new Date(Date.UTC(year, month - 1, day, hh - 3, mm, ss));
      photoTimestamp = utc.toISOString();
    }
  }

  return {
    photoTimestamp,                              // ISO UTC или null
    postcode: postcodeM ? postcodeM[1] : null,  // "108818" или null
    rawStamp: text,                              // сырой текст для логов
  };
}

// ── OCR: нижняя область (подпись сотрудника) ─────────────────────────────────

async function ocrBottom(buffer) {
  const { width, height } = await sharp(buffer).metadata();

  // Подпись занимает нижние ~18% фото, по всей ширине
  const cropH = Math.floor(height * 0.18);
  const cropT = height - cropH;

  const region = await sharp(buffer)
    .extract({ left: 0, top: cropT, width, height: cropH })
    .resize({ width: width * 2 })   // увеличиваем для лучшего распознавания
    .greyscale()
    .normalize()
    .sharpen()
    .jpeg({ quality: 95 })
    .toBuffer();

  const worker = await getTesseractWorker();
  const { data: { text } } = await worker.recognize(region);
  return parseCaptionText(text);
}

// Ключевые фразы для определения типа события
const ARRIVAL_PATTERNS = [
  /начал[оа]\s+смен/i,
  /приход/i,
  /пришёл/i,
  /пришел/i,
];
const DEPARTURE_PATTERNS = [
  /конец\s+смен/i,
  /окончани[ея]\s+смен/i,
  /уход/i,
  /ушёл/i,
  /ушел/i,
];

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

  // Имя = всё до ключевого слова события
  // Пример: "Дима начало смены" → имя = "Дима"
  let nameFromPhoto = null;
  const nameMatch = text.match(
    /^(.+?)\s+(?:начал[оа]|конец|окончани[ея]|приход|уход|пришёл|пришел|ушёл|ушел)/i
  );
  if (nameMatch) {
    nameFromPhoto = nameMatch[1].trim();
  } else if (text.length > 0 && !eventType) {
    // Тип не распознан — весь текст считаем именем
    nameFromPhoto = text;
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
  if (!infoJson.ok || !infoJson.result?.file_path) return null;

  // Шаг 2: скачиваем файл
  const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${infoJson.result.file_path}`;
  const fileRes  = await fetch(fileUrl);
  if (!fileRes.ok) return null;

  const arrayBuf = await fileRes.arrayBuffer();
  return Buffer.from(arrayBuf);
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
  } catch { /* не роняем хендлер из-за ошибки логирования */ }
}

export { supabaseFetch, logToSupabase, OBJECT_POSTCODE };
