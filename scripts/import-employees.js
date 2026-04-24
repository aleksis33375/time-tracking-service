/**
 * Одноразовый скрипт импорта сотрудников из Табель 23.03-08.04.xlsx
 * Запуск: node scripts/import-employees.js
 *
 * Бригады определены по пустым строкам в оригинальном файле.
 * Ставки берутся из последнего листа (01.04-08.04).
 * Сотрудники без ставки (руководство) вносятся с daily_rate=0.
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join }  from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Читаем .env ────────────────────────────────────────────────────────────────
const envPath = join(__dir, '..', '.env');
const env = {};
for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([^#\s=][^=]*)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}

const SUPABASE_URL = env.SUPABASE_URL?.replace(/\/$/, '');
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('❌ SUPABASE_URL или SUPABASE_SERVICE_ROLE_KEY не найдены в .env');
  process.exit(1);
}

const HEADERS = {
  apikey:          SERVICE_KEY,
  Authorization:   `Bearer ${SERVICE_KEY}`,
  'Content-Type':  'application/json',
  Prefer:          'return=representation',
};

// ── Список сотрудников ─────────────────────────────────────────────────────────
// Источник: Табель 23.03-08.04.xlsx, оба листа
// Бригады разделены пустыми строками в оригинале
// Ставки из листа 01.04-08.04 (последние актуальные)
const EMPLOYEES = [
  // ── Бригада 1 — Руководство ───────────────────────────────────────────────
  { display_name: 'Краснов Павел Александрович',     position: 'Рук',  team: 'Бригада 1', daily_rate: 0,    hourly_rate: 0      },
  { display_name: 'Кирьян Алексей Владимирович',     position: 'Нач',  team: 'Бригада 1', daily_rate: 0,    hourly_rate: 0      },
  { display_name: 'Кирьян Виталий Владимирович',     position: 'Про',  team: 'Бригада 1', daily_rate: 6500, hourly_rate: 812.5  },

  // ── Бригада 2 ─────────────────────────────────────────────────────────────
  { display_name: 'Акуленок Владислав Владимирович', position: 'Клад', team: 'Бригада 2', daily_rate: 5500, hourly_rate: 687.5  },
  { display_name: 'Осипов Андрей Игоревич',          position: 'СМР',  team: 'Бригада 2', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Соколов Евгений Витальевич',      position: 'ОС',   team: 'Бригада 2', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Петрукович Алекандр',             position: 'ОС',   team: 'Бригада 2', daily_rate: 5000, hourly_rate: 625    },

  // ── Бригада 3 ─────────────────────────────────────────────────────────────
  { display_name: 'Зокиров Тохир',                   position: 'ОС',   team: 'Бригада 3', daily_rate: 6000, hourly_rate: 750    },
  { display_name: 'Гулов Хуршед',                    position: 'ОС',   team: 'Бригада 3', daily_rate: 5500, hourly_rate: 687.5  },
  { display_name: 'Зокиров Неъматулло',              position: 'ОС',   team: 'Бригада 3', daily_rate: 5000, hourly_rate: 625    },

  // ── Бригада 4 ─────────────────────────────────────────────────────────────
  { display_name: 'Бобошоев Мирали Курбоналиевич',   position: 'РР',   team: 'Бригада 4', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Бобошоев Шерали Курбоналиевич',   position: 'РР',   team: 'Бригада 4', daily_rate: 5000, hourly_rate: 625    },

  // ── Бригада 5 ─────────────────────────────────────────────────────────────
  { display_name: 'Исмоилов Зикрулло',               position: 'РР',   team: 'Бригада 5', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Гафуров Давронджон',              position: 'РР',   team: 'Бригада 5', daily_rate: 4500, hourly_rate: 562.5  },

  // ── Бригада 6 ─────────────────────────────────────────────────────────────
  { display_name: 'Али',                             position: 'ОС',   team: 'Бригада 6', daily_rate: 5500, hourly_rate: 687.5  },
  { display_name: 'Зиядулло',                        position: 'ОС',   team: 'Бригада 6', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Шариф',                           position: 'ОС',   team: 'Бригада 6', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Хамза',                           position: 'ОС',   team: 'Бригада 6', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Дилшод',                          position: 'ОС',   team: 'Бригада 6', daily_rate: 4500, hourly_rate: 562.5  },

  // ── Бригада 7 ─────────────────────────────────────────────────────────────
  { display_name: 'Алишер',                          position: 'ОС',   team: 'Бригада 7', daily_rate: 5500, hourly_rate: 687.5  },
  { display_name: 'Рустам',                          position: 'ОС',   team: 'Бригада 7', daily_rate: 5500, hourly_rate: 687.5  },
  { display_name: 'Зубайдулло',                      position: 'ОС',   team: 'Бригада 7', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Саиджон',                         position: 'ОС',   team: 'Бригада 7', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Тихон',                           position: 'ОС',   team: 'Бригада 7', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Олег',                            position: 'ОС',   team: 'Бригада 7', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Бахтиер',                         position: 'ОС',   team: 'Бригада 7', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Никита',                          position: 'ОС',   team: 'Бригада 7', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Дима',                            position: 'ОС',   team: 'Бригада 7', daily_rate: 4500, hourly_rate: 562.5  },
  { display_name: 'Валера',                          position: 'ОС',   team: 'Бригада 7', daily_rate: 5500, hourly_rate: 687.5  },

  // ── Бригада 8 ─────────────────────────────────────────────────────────────
  { display_name: 'Саша (РР от Ярика)',              position: 'ОС',   team: 'Бригада 8', daily_rate: 5000, hourly_rate: 625    },
  { display_name: 'Шухрат',                          position: 'Погр', team: 'Бригада 8', daily_rate: 6000, hourly_rate: 750    },
  { display_name: 'Меджид',                          position: 'ОС',   team: 'Бригада 8', daily_rate: 5000, hourly_rate: 625    },
];

// ── Импорт ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n📋 Импорт ${EMPLOYEES.length} сотрудников в ${SUPABASE_URL}\n`);

  // Проверяем сколько уже есть
  const checkRes  = await fetch(`${SUPABASE_URL}/rest/v1/employees?select=id,display_name&limit=100`, { headers: HEADERS });
  const existing  = await checkRes.json();
  const existNames = new Set((Array.isArray(existing) ? existing : []).map(e => e.display_name));

  if (existNames.size > 0) {
    console.log(`⚠️  В базе уже есть ${existNames.size} сотрудников:`);
    for (const n of existNames) console.log(`   • ${n}`);
    console.log('');
  }

  // hourly_rate — вычисляемая колонка в Supabase (daily_rate / 8), не вставляем
  const toInsert = EMPLOYEES
    .filter(e => !existNames.has(e.display_name))
    .map(({ hourly_rate, ...e }) => e);

  if (toInsert.length === 0) {
    console.log('✅ Все сотрудники уже в базе — ничего не вставлено.');
    return;
  }

  console.log(`➕ Вставляю ${toInsert.length} новых сотрудников...`);

  const res  = await fetch(`${SUPABASE_URL}/rest/v1/employees`, {
    method:  'POST',
    headers: HEADERS,
    body:    JSON.stringify(toInsert),
  });
  const data = await res.json();

  if (!res.ok) {
    console.error('❌ Ошибка:', JSON.stringify(data, null, 2));
    process.exit(1);
  }

  console.log(`\n✅ Импорт завершён — вставлено ${Array.isArray(data) ? data.length : '?'} сотрудников.\n`);

  // Итоговая сводка по бригадам
  const byTeam = {};
  for (const e of toInsert) {
    byTeam[e.team] = (byTeam[e.team] || 0) + 1;
  }
  for (const [team, cnt] of Object.entries(byTeam)) {
    console.log(`  ${team}: ${cnt} чел.`);
  }
  console.log('');
}

main().catch(err => {
  console.error('❌ Неожиданная ошибка:', err.message);
  process.exit(1);
});
