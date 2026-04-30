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

async function extractOcrTimestamp(buffer, createdAtIso) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.width || !meta.height) return null;

    const cropTop = Math.floor(meta.height * 0.72);
    const croppedBuf = await sharp(buffer)
      .extract({ left: 0, top: cropTop, width: meta.width, height: meta.height - cropTop })
      .greyscale()
      .normalise()
      .toBuffer();

    const ocrResult = await Promise.race([
      Tesseract.recognize(croppedBuf, 'eng', {
        tessedit_char_whitelist: '0123456789:.',
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('OCR timeout')), 6000)
      ),
    ]);

    const text = ocrResult.data.text;
    const timeMatch = text.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!timeMatch) return null;

    const [, h, m, s] = timeMatch;
    const createdDate = new Date(createdAtIso);
    const moscowMs = Date.UTC(
      createdDate.getUTCFullYear(),
      createdDate.getUTCMonth(),
      createdDate.getUTCDate(),
      parseInt(h),
      parseInt(m),
      parseInt(s)
    );
    const utcMs = moscowMs - 3 * 3600 * 1000;
    return new Date(utcMs).toISOString();
  } catch (err) {
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

  const res = await fetch(`${SUPABASE_URL}/rest/v1/events?id=eq.${eventId}`, {
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

  try {
    // Fetch all events with photos
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/events?photo_url=not.is.null&select=id,photo_url,photo_timestamp,status,created_at&limit=1000`,
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
        const ocrTime = await extractOcrTimestamp(photo, ev.created_at);

        if (!ocrTime) continue;

        const oldTime = new Date(ev.photo_timestamp);
        const newTime = new Date(ocrTime);
        const diffMs = Math.abs(newTime - oldTime);
        const diffMins = diffMs / 60000;

        // Only update if difference > 2 minutes
        if (diffMins < 2) continue;

        console.log(
          `  ✏️  Event ${ev.id}: ${ev.photo_timestamp} → ${ocrTime} (${diffMins.toFixed(1)} min diff)`
        );

        // Reset to pending only if currently done (preserve needs_review edits)
        const newStatus = ev.status === 'done' ? 'pending' : null;
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
  }
}

main();
