# Testing Suite — AI Attendance System

Три уровня тестирования: unit, integration, и manual E2E.

## Unit Tests (автоматизированные)

### Python AI Worker (37 тестов)
```bash
# Требует: pytest (pip install pytest)
uv run --with pytest pytest tests/test_worker.py -v

# Или через обычный pip:
pip install pytest
pytest tests/test_worker.py -v
```

**Что тестируется:**
- Конвертация UTC → Москва (moscow_date_of)
- Парсинг типа события из raw-текста (resolve_event_type)
- Сборка fraud_flags (build_fraud_flags)
- Логика отправки на need_review (needs_review)
- Детектирование неполного дня (is_incomplete_day)
- Парсинг embedding (parse_embedding)

**Результат:** Все 37 тестов должны быть GREEN ✅

### JavaScript Bot Parsing (21 тест)
```bash
# Требует: Node.js 20+ (встроенный test runner)
node --test tests/test_bot_parsing.js
```

**Что тестируется:**
- Парсинг подписи: имя, тип события (начало/конец смены), опциональное время (parseCaptionText)
- Варианты текста, граничные случаи, регистр
- МСК → UTC конвертация для времени из подписи

> **Примечание:** тесты `parseStampText` удалены вместе с функцией
> (Фаза 10 — OCR штампа больше не используется).

**Результат:** тесты должны быть GREEN ✅

## Integration Tests (полуручные)

### Seed Test Data
```bash
# Требует: SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY env vars
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=xxx \
python tests/seed_test_data.py
```

**Что делает:**
- Создаёт 3 тестовых сотрудника в БД (если не существуют)
- Вставляет 5 событий pending, покрывающих разные сценарии:
  - Полный день (приход + уход) → ожидается done
  - Только приход → ожидается needs_review (incomplete_day)
  - Неизвестное имя → ожидается needs_review (no match)
  - Несовпадение лица (face_mismatch) → ожидается needs_review (fraud)
  - Опечатка в имени из подписи → fuzzy match находит сотрудника

**Ожидается:** События созданы, видны в Supabase таблице events

### Затем запустить AI Worker
```bash
# GitHub Actions
# GitHub UI → Actions → "Process Events" → Run workflow (manual trigger)

# Или локально:
export SUPABASE_URL=https://xxx.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=xxx
export TELEGRAM_BOT_TOKEN=xxx
export MANAGER_CHAT_ID=123456789
python ai-worker/process_events.py
```

**Ожидается:**
- Все pending-события обработаны
- Статусы изменились: done, needs_review (в зависимости от сценария)
- Логи записаны в таблицу logs
- Telegram notification отправлена для needs_review (если MANAGER_CHAT_ID задан)

## Manual E2E Testing

### Полный цикл end-to-end

Откройте **[E2E_CHECKLIST.md](E2E_CHECKLIST.md)** для подробного пошагового руководства.

**Коротко:**
1. Seed test data (см. выше)
2. Отправить фото с подписью в Telegram-группу бота
3. Запустить AI Worker (workflow или локально)
4. Проверить Dashboard: Overview, Attendance, Review, Analytics, Timesheet, Logs
5. Отредактировать запись в Review
6. Скачать Excel, PDF
7. Проверить мобильную вёрстку

**Результат:** Все 7 страниц Dashboard работают, данные синхронизированы, нет багов.

## Checklist перед деплоем

- [ ] Все 37 Python unit-тестов PASS
- [ ] Все 21 JS unit-тестов PASS
- [ ] Seed test data создан
- [ ] AI Worker обработал seed-события корректно
- [ ] E2E цикл пройден на каждой странице Dashboard
- [ ] Логи полные и информативные
- [ ] Нет необработанных ошибок в консоли/logs

## Запуск всех тестов сразу

```bash
# 1. Unit tests (Python)
uv run --with pytest pytest tests/test_worker.py -v

# 2. Unit tests (JavaScript)
node --test tests/test_bot_parsing.js

# 3. Seed + Worker integration
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... python tests/seed_test_data.py
python ai-worker/process_events.py

# 4. Manual check — Dashboard
# Откройте браузер → Dashboard → Обзор, Посещаемость, Проверка, Аналитика, Табель, Логи
```

## Troubleshooting

### Python тесты не запускаются
```bash
# Если нет pip:
uv run --with pytest pytest tests/test_worker.py -v

# Если есть pip:
pip install pytest
pytest tests/test_worker.py -v
```

### Node.js тесты не работают
```bash
# Требует Node 20+
node --version  # должно быть ≥20.0.0

# Если версия старая, обновите Node или используйте uv:
uv run node --version
```

### Seed data не создаётся
```bash
# Проверьте env vars:
echo $SUPABASE_URL
echo $SUPABASE_SERVICE_ROLE_KEY

# Они должны быть заполнены.
# Если нет — возьмите из Supabase Settings
```

### AI Worker не находит сотрудников
```bash
# Проверьте в Supabase:
# 1. Таблица employees — есть ли ТестДима, ТестИван, ТестОльга?
# 2. deleted_at == null? (не архивированы)
# 3. display_name точно совпадает?
#
# Если нет — переобновите seed_test_data.py
```

## Links

- [E2E Checklist](E2E_CHECKLIST.md) — Пошаговое руководство ручного тестирования
- [PLAN.md](../PLAN.md) — Статус разработки по фазам
- [Supabase Docs](https://supabase.com/docs) — API, Storage, Auth
- [GitHub Actions Docs](https://docs.github.com/en/actions) — Workflow, Manual triggers
