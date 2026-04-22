/**
 * Unit-тесты для функций парсинга OCR из webhook.js.
 * Запуск: node --test tests/test_bot_parsing.js
 * Node 20+ (встроенный test runner, без зависимостей).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// ── Копии чистых функций из webhook.js (без I/O) ─────────────────────────────

const MONTHS_RU = {
  'янв': 1, 'фев': 2, 'мар': 3, 'апр': 4,
  'май': 5, 'мая': 5, 'июн': 6, 'июл': 7,
  'авг': 8, 'сен': 9, 'окт': 10, 'ноя': 11, 'дек': 12,
};

function parseStampText(raw) {
  const text = raw.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const timeM      = text.match(/(\d{1,2})[:.](\d{2})[:.](\d{2})/);
  const dateM      = text.match(/(\d{1,2})\s+([а-яёА-ЯЁ]{2,4})\.?\s+(\d{4})/);
  const postcodeM  = text.match(/\b(\d{6})\b/);

  let photoTimestamp = null;
  if (dateM && timeM) {
    const day   = parseInt(dateM[1], 10);
    const month = MONTHS_RU[dateM[2].toLowerCase().slice(0, 3)];
    const year  = parseInt(dateM[3], 10);
    const hh    = parseInt(timeM[1], 10);
    const mm    = parseInt(timeM[2], 10);
    const ss    = parseInt(timeM[3], 10);
    if (month) {
      const utc = new Date(Date.UTC(year, month - 1, day, hh - 3, mm, ss));
      photoTimestamp = utc.toISOString();
    }
  }
  return {
    photoTimestamp,
    postcode:  postcodeM ? postcodeM[1] : null,
    rawStamp: text,
  };
}

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
  let eventType    = null;
  let eventTypeRaw = null;

  if (ARRIVAL_PATTERNS.some(p => p.test(text))) {
    eventType    = 'arrival';
    eventTypeRaw = 'начало смены';
  } else if (DEPARTURE_PATTERNS.some(p => p.test(text))) {
    eventType    = 'departure';
    eventTypeRaw = 'конец смены';
  }

  let nameFromPhoto = null;
  const nameMatch = text.match(
    /^(.+?)\s+(?:начал[оа]|конец|окончани[ея]|приход|уход|пришёл|пришел|ушёл|ушел)/i
  );
  if (nameMatch) {
    nameFromPhoto = nameMatch[1].trim();
  } else if (text.length > 0 && !eventType) {
    nameFromPhoto = text;
  }

  return { nameFromPhoto, eventType, eventTypeRaw, rawCaption: text };
}


// ═══════════════════════════════════════════════════════════════════════════════
// parseStampText
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseStampText', () => {

  test('типичный штамп Timestamp Camera', () => {
    const r = parseStampText('14 апр. 2026 г. 09:35:22 Москва 108818');
    assert.equal(r.postcode, '108818');
    assert.ok(r.photoTimestamp, 'должен быть timestamp');
    // 09:35 МСК = 06:35 UTC
    assert.ok(r.photoTimestamp.includes('06:35:22'), `got ${r.photoTimestamp}`);
  });

  test('индекс извлекается корректно', () => {
    assert.equal(parseStampText('что-то 123456 ещё').postcode, '123456');
  });

  test('нет индекса → null', () => {
    assert.equal(parseStampText('нет шестизначного числа тут').postcode, null);
  });

  test('пятизначный индекс не захватывается', () => {
    assert.equal(parseStampText('индекс 12345').postcode, null);
  });

  test('нет даты или времени → photoTimestamp null', () => {
    assert.equal(parseStampText('108818').photoTimestamp, null);
  });

  test('OCR с точками вместо двоеточий в времени', () => {
    const r = parseStampText('15 мар. 2026 г. 08.30.00 Москва 108818');
    assert.ok(r.photoTimestamp, 'должен парсить точки как разделитель');
  });

  test('все месяцы распознаются', () => {
    const months = ['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
    for (const mon of months) {
      const r = parseStampText(`1 ${mon}. 2026 г. 10:00:00`);
      assert.ok(r.photoTimestamp !== null, `месяц "${mon}" не распознан`);
    }
  });

  test('перевод МСК→UTC: 00:00 МСК = 21:00 предыдущего дня UTC', () => {
    const r = parseStampText('15 апр. 2026 г. 00:00:00 Москва 108818');
    assert.ok(r.photoTimestamp.startsWith('2026-04-14T21:00:00'), `got ${r.photoTimestamp}`);
  });

  test('перевод МСК→UTC: 12:00 МСК = 09:00 UTC', () => {
    const r = parseStampText('15 апр. 2026 г. 12:00:00 Москва 108818');
    assert.ok(r.photoTimestamp.startsWith('2026-04-15T09:00:00'), `got ${r.photoTimestamp}`);
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// parseCaptionText
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseCaptionText', () => {

  test('начало смены', () => {
    const r = parseCaptionText('Дима начало смены');
    assert.equal(r.eventType,    'arrival');
    assert.equal(r.nameFromPhoto,'Дима');
  });

  test('конец смены', () => {
    const r = parseCaptionText('Иванов Иван конец смены');
    assert.equal(r.eventType,    'departure');
    assert.equal(r.nameFromPhoto,'Иванов Иван');
  });

  test('приход', () => {
    const r = parseCaptionText('Петров приход');
    assert.equal(r.eventType,    'arrival');
    assert.equal(r.nameFromPhoto,'Петров');
  });

  test('уход', () => {
    const r = parseCaptionText('Сидоров уход');
    assert.equal(r.eventType,    'departure');
    assert.equal(r.nameFromPhoto,'Сидоров');
  });

  test('пришёл с ё', () => {
    const r = parseCaptionText('Степан пришёл');
    assert.equal(r.eventType, 'arrival');
    assert.equal(r.nameFromPhoto, 'Степан');
  });

  test('ушёл с ё', () => {
    const r = parseCaptionText('Фёдор ушёл');
    assert.equal(r.eventType, 'departure');
    assert.equal(r.nameFromPhoto, 'Фёдор');
  });

  test('окончание смены', () => {
    const r = parseCaptionText('Коля окончание смены');
    assert.equal(r.eventType, 'departure');
  });

  test('начала смены (с ошибкой склонения)', () => {
    const r = parseCaptionText('Дима начала смены');
    assert.equal(r.eventType, 'arrival');
  });

  test('неизвестный тип → null, весь текст как имя', () => {
    const r = parseCaptionText('Дима работает');
    assert.equal(r.eventType,    null);
    assert.equal(r.nameFromPhoto,'Дима работает');
  });

  test('регистронезависимость', () => {
    const r = parseCaptionText('ДИМА НАЧАЛО СМЕНЫ');
    assert.equal(r.eventType, 'arrival');
    assert.equal(r.nameFromPhoto, 'ДИМА');
  });

  test('пустая строка → null', () => {
    const r = parseCaptionText('');
    assert.equal(r.eventType, null);
    assert.equal(r.nameFromPhoto, null);
  });

  test('многострочный OCR-вывод нормализуется', () => {
    const r = parseCaptionText('Дима\nначало\nсмены');
    assert.equal(r.eventType, 'arrival');
    assert.equal(r.nameFromPhoto, 'Дима');
  });
});
