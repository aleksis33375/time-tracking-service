/**
 * Telegram Webhook Handler — Vercel Serverless Function
 * POST /api/webhook
 */

import sharp from 'sharp';
import exifReader from 'exif-reader';
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

  // Validate secret token
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (WEBHOOK_SECRET && secret !== WEBHOOK_SECRET) {
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

  // Telegram присылает несколько размеров — берём наибольший
  const largest = msg.photo[msg.photo.length - 1];

  // Подпись читаем напрямую из Telegram caption — без OCR
  const caption = parseCaptionText(msg.caption || '');
  console.log('Caption (from msg.caption):', caption);

  // Резервный timestamp: время отправки из Telegram (используется, если EXIF нет)
  const telegramTimestamp = new Date(msg.date * 1000).toISOString();

  // Скачиваем и сжимаем фото (не критично — продолжаем без фото если не вышло)
  let compressedBuffer = null;
  let photoUrl         = null;
  let exifTimestamp    = null;

  try {
    const originalBuffer = await downloadTelegramPhoto(largest.file_id);
    exifTimestamp = await extractExifTimestamp(originalBuffer);
    compressedBuffer = await compressPhoto(originalBuffer);
    const originalKb   = Math.round(originalBuffer.length   / 1024);
    const compressedKb = Math.round(compressedBuffer.length / 1024);
    console.log(`Photo: ${originalKb} KB → ${compressedKb} KB, EXIF time: ${exifTimestamp || 'absent'}`);
  } catch (err) {
    await logToSupabase('warn', 'webhook-handler', `Photo download failed: ${err.message}`, { chatId, messageId });
  }

  if (compressedBuffer) {
    // Сохранение сжатого фото в Supabase Storage
    photoUrl = await uploadPhotoToStorage(compressedBuffer, chatId, messageId);
    if (!photoUrl) {
      await logToSupabase('warn', 'webhook-handler', 'Failed to upload photo to storage', { chatId, messageId });
    }
  }

  const photoTimestamp = exifTimestamp || telegramTimestamp;

  // Запись в events — всегда, даже без фото
  await insertEvent({
    photo_url:       photoUrl,
    photo_timestamp: photoTimestamp,
    status:          'pending',
    name_from_photo: caption.nameFromPhoto,
    event_type:      caption.eventType,
    event_type_raw:  caption.eventTypeRaw,
  });

  await logToSupabase('info', 'webhook-handler', 'Event created', {
    name:        caption.nameFromPhoto,
    event:       caption.eventTypeRaw,
    photo:       photoUrl ? 'ok' : 'missing',
    time_source: exifTimestamp ? 'exif' : 'telegram',
    photo_time:  photoTimestamp,
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
