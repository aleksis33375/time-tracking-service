# PLAN.md — План разработки AI Attendance System

Формат: чек-лист. Когда задача выполнена — меняй `[ ]` на `[x]`.

---

## Фаза 1 — Инфраструктура
- [x] Создать структуру папок (/bot, /ai-worker, /dashboard)
- [x] .env и .gitignore
- [x] Зафиксировать часовой пояс: Europe/Moscow
- [x] В .env: OBJECT_POSTCODE=108818 (индекс объекта для сверки)
- [x] Supabase: создать проект
- [x] Supabase: таблица employees (display_name, position, team,
      daily_rate, hourly_rate, face_embedding, ref_photo_url, deleted_at)
- [x] Supabase: таблица events (employee_id, photo_url, photo_timestamp,
      event_type, status, hours, absent_reason, hours_transferred,
      processing_started_at, name_from_photo, event_type_raw,
      postcode_from_photo, fraud_flags)
- [x] Supabase: таблица logs (timestamp, level, source, message, meta)
- [x] Supabase: Storage для фото
- [x] Supabase Auth: настроить (email/password)

---

## Фаза 2 — Авторизация Dashboard
- [x] Supabase Auth integration
- [x] Row Level Security на employees, events, logs
- [x] Login-страница в Dashboard
- [x] Защита всех страниц Dashboard авторизацией

---

## Фаза 3 — Базовый Dashboard + регистрация сотрудников
- [x] SPA-оболочка (index.html, навигация, стили)
- [x] Страница «Сотрудники»: список, добавление, редактирование
- [x] Soft delete (архивирование) — история часов сохраняется
- [x] Массовый импорт сотрудников из Excel/CSV (онбординг 120+)
- [x] Поля сотрудника: имя (любое, как на фото), роль, бригада,
      дневная ставка, эталонное фото
- [x] Авто-расчёт часовой ставки = дневная ставка ÷ 8
- [x] Загрузка эталонного фото в Supabase Storage
- [x] GitHub Actions workflow: вычисление face embedding при регистрации
- [x] Сохранение embedding в employees

---

## Фаза 4 — Telegram Bot (Vercel Serverless Function)
- [x] Создать бота через BotFather, отключить privacy mode
- [x] Добавить бота в существующую группу
- [x] Vercel Serverless Function: webhook handler
- [x] Регистрация webhook с secret_token + валидация заголовка
      X-Telegram-Bot-Api-Secret-Token
- [x] Фильтрация: обрабатывать ТОЛЬКО фото, остальное игнорировать
- [x] Сжатие входящего фото до ~150 КБ перед сохранением
- [x] OCR верхней правой области: дата, время, город, индекс
- [x] OCR нижней области: имя сотрудника + тип события
      («начало смены» / «конец смены»)
- [x] Сверка индекса с OBJECT_POSTCODE →
      если не совпал: fraud_flag = "wrong_location"
- [x] Сохранение сжатого фото в Supabase Storage
- [x] Запись в events: status=pending, photo_timestamp, name_from_photo,
      event_type_raw, postcode_from_photo, fraud_flags

---

## Фаза 5 — AI Worker (GitHub Actions с батчингом)
- [x] Workflow: запуск по cron каждые 5–10 минут
- [x] concurrency: group в workflow (запрет параллельных запусков)
- [x] Атомарный захват записей: UPDATE status=processing + processing_started_at
- [x] Восстановление зависших: processing > 15 мин → вернуть в pending
- [x] Поиск сотрудника по name_from_photo
- [x] Face recognition как верификация (лицо соответствует подписи?)
- [x] Несовпадение лица → fraud_flag="face_mismatch", status=needs_review
- [x] event_type берётся из event_type_raw (не угадывается по времени)
- [x] Расчёт часов: последний «конец смены» − первый «начало смены»
      за этот день. Обед НЕ вычитается. Результат — дробное число (9.5 = 9ч 30м)
- [x] Если за день только приход ИЛИ только уход →
      incomplete_day, status=needs_review
- [x] Выходные (сб, вс) обрабатываются как будние — те же правила расчёта
- [x] Обновление events: status=done, employee_id, event_type, hours
- [x] Нераспознанные / с fraud_flags → status=needs_review
- [x] Telegram-уведомление руководителю в личку при появлении needs_review
- [x] Запись бизнес-событий в таблицу logs

---

## Фаза 6 — Автоудаление старых фото
- [x] Отдельный GitHub Actions workflow по cron (раз в сутки)
- [x] Удаление файлов фото из Storage старше 60 дней
- [x] Записи в events остаются навсегда (удаляются только файлы)
- [x] Запись в logs: сколько файлов удалено за прогон

---

## Фаза 7 — Главная страница «Табель» (флагман)
- [x] Структура таблицы: ФИО, роль, дневная ставка, ст-ть часа,
      переход часов, дни периода, итоговые часы, сумма
- [x] Авто-расчёт «Переход часов» из предыдущего периода
- [x] Авто-расчёт «Всего часов» = SUM(дни),
      «Сумма» = Всего часов × Стоимость часа
- [x] Группировка по бригадам + зелёные подитоги
      (пустая строка-разделитель между бригадами)
- [x] Оранжевая подсветка субботы/воскресенья
      (визуальная, не влияет на расчёт)
- [x] Красная подсветка needs_review
- [x] Иконка ⚠️ на ячейке при наличии fraud_flags
- [x] Hover по ячейке дня → всплывает фото из Telegram
- [x] Поиск по ФИО, сворачивание бригад
- [x] Выбор периода: день / неделя / месяц / произвольный
- [x] Кнопка «Скачать Excel»: разбиение на листы по неделям
      (23.03-31.03, 01.04-08.04 и т.д.) — формат совпадает с текущим
- [x] Кнопка «Скачать PDF» (для печати и подписи)
- [x] Мобильная вёрстка: упрощённый вид (скролл по дням)

---

## Фаза 8 — Остальные страницы Dashboard
- [x] Страница «Главная / Обзор» (сводка за день по объекту)
- [x] Страница «Посещаемость» (таблица отметок по сотрудникам)
- [x] Страница «Ручная корректировка» (правки, needs_review, fraud_flags)
- [x] Страница «Аналитика» (графики, ФОТ, аномалии)
- [x] Страница «События системы» (журнал из таблицы logs)

---

## Фаза 9 — Финал
- [x] Тестирование на реальных данных (end-to-end)
- [x] Деплой Dashboard + Bot на Vercel
- [x] AI Worker GitHub Actions в продакшн-режиме
- [x] Документация для клиента

---

## Фаза 10 — Убрать OCR из webhook

**Цель:** вернуть систему в рабочее состояние. После фазы рабочие могут
отмечаться, часы считаются, лица проверяются.

**Время:** 2 часа, 22 действия

### 10.1 Код
**Файл:** `api/webhook.js`

- [x] 1. Удалить импорт `import { createWorker } from 'tesseract.js'` (строка 7)
- [x] 2. Удалить функцию `getTesseractWorker` (строки 139–148)
- [x] 3. Удалить функцию `ocrTopRight` (строки 150–171)
- [x] 4. Удалить константу `MONTHS_RU` (строки 173–177)
- [x] 5. Удалить функцию `parseStampText` (строки 179–211)
- [x] 6. Удалить переменную `OBJECT_POSTCODE` (строка 14) и её использование
- [x] 7. В `handlePhoto` удалить вызов `ocrTopRight` и переменную `stamp`
- [x] 8. Заменить `photoTimestamp = stamp.photoTimestamp ?? fallbackTimestamp` на `photoTimestamp = fallbackTimestamp`
- [x] 9. Удалить блок проверки `wrong_location` и переменную `fraudFlags`
- [x] 10. В вызове `insertEvent` убрать поля `postcode_from_photo` и `fraud_flags`
- [x] 11. Добавить лог в начало `handlePhoto`: `"Photo received"` с `{chatId, messageId}`
- [x] 12. В `logToSupabase` добавить `console.error` в `catch`
- [x] 13. Убрать `tesseract.js` из `package.json`

### 10.2 Деплой
- [x] 14. Закоммитить: `git commit -m "remove OCR from webhook"`
- [x] 15. Задеплоить: `vercel --prod`

### 10.3 Проверка
> ⚠️ Проверка проводится только по реальным фото от рабочих — тестовые отправки в группу не делаются.
- [x] 16. Рабочий отправил фото → в `logs` появился `"Photo received"`
- [x] 17. В `events` появилось событие со статусом `pending`
- [x] 18. В Storage лежит фото `photos/{chatId}/{messageId}.jpg`
- [x] 19. Через 5 минут ai-worker обработал → статус `done` или `needs_review`
- [x] 20. Проверка face recognition: фото не того человека → флаг `face_mismatch` (реализовано в фазе 5)
- [x] 21. Проверка fuzzy match: опечатка в имени → сотрудник найден (реализовано в фазе 5)
- [x] 22. Дашборд показывает событие и фото корректно

**✅ После Фазы 10: базовая рабочая система.**

---

## 🆕 ЭТАП A + ЭТАП B (2026-05-01) — Улучшения worker + UI для двойных смен

**Выполнено:**

### Этап A — Исправления worker
- [x] Баг URL-encoding: `+00:00` → пробел → ошибка 22007 (BUG-033, BUG-034)
- [x] `calculate_hours()` переписана на pair-based логику (18h window)
- [x] 68 stuck событий сброшены в pending, переобработаны новым кодом
- [x] Commit: `6de68d4`

### Этап B — Обнаружение дублей и двойных смен + UI
- [x] `calculate_hours()` переписана на buffer-state алгоритм (24h window)
  - Возвращает tuple: (hours, paired_arrival_id, is_double_shift, is_duplicate)
  - Детект дублирующих departure (без paired arrival)
  - Детект двойных смен (2 complete pairs за день)
- [x] `_flag_previous_pair_as_double()` — JSONB read-modify-write
- [x] `finalize_event()` сохраняет hours в needs_review (для агрегации)
- [x] Review tab: карточки двойных смен с кнопками «Подтвердить» / «Отклонить вторую»
- [x] Timesheet: красный жирный + сумма часов + tooltip для double_shift
- [x] BUG.md: документированы BUG-033, BUG-034, BUG-035, BUG-036
- [x] Unit tests: test_calculate_hours.py — 13/13 scenarios passed
- [x] Commit: `5206e26`, задеплоен на Vercel

**Статус:** ✅ Этап A и Этап B полностью завершены

---

## 🆕 ЭТАП C (2026-05-03) — Авто-создание сотрудников + защита от нечеловеческих фото

### Этап C.1 — Авто-создание сотрудников (auto-create)
- [x] `auto_create_employee()` — создаёт запись в employees при первом фото нового рабочего
  - team='Авто', daily_rate=0 (руководитель задаёт вручную)
- [x] `sb_post()` — helper для POST-запросов в Supabase REST API
- [x] В `main()`: если `find_employee_by_name()` не нашёл — вызов `auto_create_employee()`
- [x] Dashboard: автосозданные сотрудники сортируются в конец таблицы (команда «Авто»)
- [x] Dashboard: ставка показывается как «?» (не 0 и не дефолт) до назначения руководителем

### Этап C.2 — Защита от нечеловеческих фото (BUG-038)
- [x] `verify_face()`: при `event_encoding is None` возвращает `False` (а не `None`)
  → событие получает флаг `face_mismatch`, уходит в `needs_review`
- [x] `main()`: при `bootstrapped = False` (лицо не найдено при первом фото) событие
  отклоняется немедленно: `status='duplicate'`, `fraud_flags=['no_face_detected']`
- [x] Commit: задеплоен на Vercel + GitHub Actions

**Статус:** ✅ Этап C полностью завершён

---

## Фаза 11 — Время события из подписи

**Цель:** если рабочий пишет время в подписи — использовать его. Если нет —
время из Telegram. Ловим старые фото по несовпадению времени.

**Время:** 1.5 часа, 10 действий

### 11.1 Код
**Файл:** `api/webhook.js`

- [ ] 1. В `parseCaptionText` добавить regex для поиска времени `HH:MM` или `HH.MM`
- [ ] 2. Вернуть `captionTime` в объекте результата
- [ ] 3. В `handlePhoto` использовать `captionTime` (если найден) как `photoTimestamp`, иначе — `fallbackTimestamp` из Telegram
- [ ] 4. Если разница между `captionTime` и временем Telegram больше 30 минут → флаг `"time_mismatch"` в `fraud_flags`

### 11.2 Деплой
- [ ] 5. Закоммитить: `git commit -m "parse time from caption"`
- [ ] 6. Задеплоить: `vercel --prod`

### 11.3 Проверка
- [ ] 7. Отправить "Иван начало смены 08:15" → `photo_timestamp` в `events` равен 08:15 МСК
- [ ] 8. Отправить "Иван начало смены" без времени → используется время Telegram
- [ ] 9. Отправить фото с временем из прошлого дня → флаг `time_mismatch`, статус `needs_review`
- [ ] 10. Проверить что Фаза 10 всё ещё работает (отправить обычное фото, дождаться обработки)

**✅ После Фазы 11: рабочая система + точное время + защита от старых фото.**

---

## Фаза 12 — Защита от дублей в ai-worker

**Цель:** ловить повторные "начало смены" (или "конец смены") от одного
рабочего за один день.

**Статус: ✅ ЗАВЕРШЕНО (2026-05-03)**

### Реализовано в Этап B + Фаза 12 (2026-05-03):

**Детект дублирующего departure** (Этап B, buffer-state алгоритм):
- `calculate_hours()` — если нет открытого arrival перед departure → `status=duplicate, fraud_flags=["duplicate"]`

**Детект двойной смены** (Этап B, buffer-state алгоритм):
- `calculate_hours()` — если есть уже закрытая пара → `is_double_shift=True`
- Оба события пары переводятся в `needs_review` с `fraud_flags=["double_shift"]`

**Детект дублирующего arrival** (Фаза 12, 2026-05-03):
- `check_duplicate_arrival()` — если в окне 24 ч уже есть открытый arrival → `status=duplicate, fraud_flags=["duplicate"]`
- Файл: `ai-worker/process_events.py`, функция `check_duplicate_arrival()`

**✅ После Фазы 12: все сценарии дублей покрыты.**

---

## Сводная по Фазам 10–12

| Фаза | Что даёт | Действий | Время |
|---|---|---|---|
| 10. Убрать OCR | Базовая рабочая система | 22 | 2 ч |
| 11. Время из подписи | + точное время, + детект старых фото | 10 | 1.5 ч |
| 12. Защита от дублей | + ловим повторные отметки | 13 | 1.5 ч |
| **Итого** | **Полная рабочая система** | **45** | **~5 часов** |

**Логика:** Фаза 10 достаточна для работы системы уже сегодня. Фазы 11 и 12
независимы и могут делаться отдельно. Откат в случае проблем — через `git revert`.

---

## Фаза 13 — Финальная настройка и адреса

### 13.1 Telegram-уведомления руководителю (MANAGER_CHAT_ID)

**Цель:** руководитель получает личное сообщение в Telegram при каждом `needs_review`.

**Действия (выполняет владелец вручную):**

- [ ] 1. Написать `/start` боту в **личный чат** (не в группу)
- [ ] 2. Открыть в браузере: `https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getUpdates`
         Найти в JSON: `result[].message.from.id` — это и есть MANAGER_CHAT_ID
- [ ] 3. Добавить секрет в **GitHub** → Settings → Secrets and variables → Actions → New repository secret:
         Имя: `MANAGER_CHAT_ID`, Значение: <число из шага 2>
- [ ] 4. Добавить переменную окружения в **Vercel** → Project → Settings → Environment Variables:
         Имя: `MANAGER_CHAT_ID`, Значение: то же число
- [ ] 5. Проверить: отправить тестовое фото с неизвестным именем → должно прийти уведомление в личку

### 13.2 Рабочий URL дашборда

> ⚠️ Адрес `https://ai-tabel.vercel.app/` **не кликабелен / не работает**.
> Рабочий адрес: **https://time-tracking-service-beta.vercel.app/**

- [ ] 6. Перенастроить alias в Vercel: привязать `ai-tabel.vercel.app` к текущему деплою,
         **или** использовать только `time-tracking-service-beta.vercel.app` как основной адрес
- [ ] 7. Обновить ссылку у всех пользователей дашборда на рабочий адрес

**✅ После Фазы 13: уведомления работают, адрес дашборда актуален.**

---

## 🆕 ЭТАП D (2026-05-03) — UI улучшения Dashboard + локализация интерфейса

**Выполнено:**

### Этап D.1 — Локализация fraud_flags и улучшение UI
- [x] Маппинг fraud_flags на русский язык:
  - `face_mismatch` → "Лицо не совпадает"
  - `double_shift` → "Двойная смена"
  - `duplicate` → "Дубль"
  - `no_face_detected` → "Лицо не найдено"
  - Удалены `wrong_location` и `incomplete_day` (не используются)
- [x] Обновлены 3 места отображения fraud_flags в дашборде:
  1. Dropdown меню на вкладке Review
  2. Badge'ы в таблице на вкладке Review
  3. Иконка ⚠️ + подсказка в Табели

### Этап D.2 — Интерактивные карточки Overview
- [x] Stat cards (Сегодня / Табель / Двойные смены / Нужны проверки) теперь кликабельны
- [x] Hover эффект (изменение cursor и фона)
- [x] Клик на карточку → навигация на соответствующую вкладку:
  - "Сегодня" → Посещаемость
  - "Табель" → Табель
  - "Двойные смены" → Review с фильтром `double_shift`
  - "Нужны проверки" → Review (все needs_review)
- [x] Реализована функция `goTo(page, options)` для навигации с опциями

### Этап D.3 — Интерактивные кнопки Review
- [x] Кнопка "Проверить" на вкладке Overview → навигация на Review + выделение сотрудника
- [x] Реализована переменная `rvHighlightEmpId` для подсветки строки на Review

### Этап D.4 — Мультифото tooltips в Табели
- [x] При наведении на ячейку Табели (день сотрудника) → tooltip с 2 или 4 фото
  - **Нормальная смена:** 2 фото (приход, уход)
  - **Двойная смена:** 4 фото (2 прихода, 2 ухода)
- [x] Изменена структура данных: `data-photo` → `data-events` (массив объектов)
- [x] Реализована функция `showDayPhoto()` для динамической загрузки и отображения:
  - Сортировка событий по временнику
  - Параллельная загрузка signed URLs с Promise.all()
  - Кэширование URLs
  - Grid layout: 1 столбец (≤2 фото) или 2 столбца (>2 фото)
  - Форматирование времени: "HH:MM МСК" (UTC + 3 часа)
  - Отображение типа события: "Приход" / "Уход"
- [x] Фиксы BUG-039: fraud_flags как массив (не строка)

**Статус:** ✅ Этап D полностью завершён

---

## 📊 ИТОГОВЫЙ СТАТУС НА 2026-05-03

| Фаза | Название | Статус | Осталось |
|---|---|---|---|
| 1–9 | Базовая система | ✅ 100% | — |
| 10 | Убрать stamp-OCR из webhook | ✅ 100% (22/22) | — |
| A | Исправления worker (URL-encoding, pair-based hours) | ✅ 100% | — |
| B | Дубли, двойные смены, UI | ✅ 100% | — |
| C | Авто-создание сотрудников + защита от нечеловеческих фото | ✅ 100% | — |
| D | UI улучшения: интерактивные карты, мультифото tooltips, локализация | ✅ 100% | — |
| 11 | Время из подписи | ⏳ 0% | 10 действий |
| 13 | Telegram уведомления руководителю | ⏳ 0% | 7 действий |

**Работающая система:** ✅  
**Рабочие могут отмечаться:** ✅  
**Часы считаются корректно:** ✅ (Этап A/B)  
**Дубли и двойные смены детектятся:** ✅ (Этап B)  
**Нечеловеческие фото отклоняются:** ✅ (Этап C / BUG-038)  
**Новые сотрудники создаются автоматически:** ✅ (Этап C)  
**Dashboard интерактивен:** ✅ (Этап D)  
**Мультифото tooltips:** ✅ (Этап D)  
**Уведомления руководителю:** ⏳ (нужна Фаза 13.1 — настроить MANAGER_CHAT_ID)

---

## 🆕 ЭТАП E (2026-06-13) — Дашборд видит события без photo_timestamp

**Проблема (BUG-063):** Табель запрашивает события по диапазону `photo_timestamp` → 286 событий без штампа невидимы → прочерки "—".

**Файл:** `dashboard/index.html`

- [ ] Заменить фильтр `photo_timestamp=gte/lt` на `created_at=gte/lt` в запросе событий (~строка 3308)
- [ ] Убрать `if (!ev.photo_timestamp) continue` (~строка 3339)
- [ ] Использовать `ev.photo_timestamp ?? ev.created_at` для определения дня события

**Результат:** Прочерки "—" исчезают сразу после деплоя → показываются "?" или числа.

---

## 🆕 ЭТАП F (2026-06-13) — AI Worker обрабатывает события в хронологическом порядке

**Проблема (BUG-064):** `order=created_at.desc` → departure обрабатывается раньше arrival → false `duplicate`.

**Файл:** `ai-worker/process_events.py`, строка ~163

- [ ] Изменить `order=created_at.desc` → `order=created_at.asc` в `claim_pending_events()`

**Результат:** Новые отметки рабочих больше не застревают как ложные дубли.

---

## 🆕 ЭТАП G (2026-06-13) — Сброс ложных duplicate событий

**Проблема (BUG-065):** События стали `duplicate` из-за BUG-064 — нет механизма автовосстановления.

**Где:** Supabase → SQL Editor

- [ ] Выполнить SQL после деплоя Этапа F:
```sql
UPDATE events
SET status = 'pending', processing_started_at = NULL
WHERE status = 'duplicate'
  AND created_at >= '2026-05-01'
  AND (fraud_flags IS NULL OR fraud_flags::text NOT LIKE '%"duplicate"%');
```
- [ ] Проверить количество обновлённых строк > 0
- [ ] Дождаться обработки AI Worker (следующий cron, 5-10 мин)

**Результат:** Ложные дубли переобрабатываются с правильным порядком → часы считаются.

---

## 🆕 ЭТАП H (2026-06-13) — Замена Tesseract → EasyOCR

**Проблема (BUG-067):** Tesseract провалился на 286/460 фото (62%) — не приспособлен для водяных знаков смартфонов. EasyOCR (бесплатная Python-библиотека) обучена именно на scene text.

**Создать:**
- [ ] `ai-worker/requirements-ocr.txt` (easyocr==1.7.2, Pillow==11.2.1, requests==2.32.3)
- [ ] `ai-worker/ocr_worker.py` (2 прохода: полное фото + grayscale, `--backfill` режим)

**Изменить:**
- [ ] `.github/workflows/ai-worker.yml` — убрать Node.js шаги, добавить Python OCR с кэшем моделей
- [ ] `.github/workflows/backfill-timestamps.yml` — заменить Node.js на Python

**После деплоя:**
- [ ] Запустить backfill вручную: GitHub Actions → `backfill-timestamps.yml` → Run workflow
- [ ] Дождаться завершения (~20 мин)
- [ ] Проверить: `SELECT COUNT(*) FROM events WHERE photo_timestamp IS NULL AND photo_url IS NOT NULL` → должно быть < 10

**Результат:** 286 фото получают OCR-timestamp → AI Worker считает часы → "?" в табеле превращаются в числа.

---

## 📊 ИТОГОВЫЙ СТАТУС НА 2026-06-13

| Этап | Название | Статус |
|---|---|---|
| E | Дашборд: фильтр по created_at (BUG-063) | ⏳ В работе |
| F | AI Worker: порядок asc (BUG-064) | ⏳ В работе |
| G | SQL: сброс ложных duplicate (BUG-065) | ⏳ В работе |
| H | EasyOCR замена Tesseract (BUG-067) | ⏳ В работе |
