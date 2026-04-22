# E2E Testing Checklist — AI Attendance System

Полный цикл тестирования система от Telegram до Dashboard.

**Требования:**
- Telegram BotFather бот (уже создан)
- Supabase проект с базой и данными
- Vercel deployment (или локальный webhook)
- GitHub Actions workflow (или локальный python runner)
- Dashboard развёрнут

**Время на полный цикл:** ~30 минут

---

## Подготовка

### 1. Seed test data
```bash
SUPABASE_URL=https://xxx.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=xxx \
python tests/seed_test_data.py
```
Проверить в Supabase:
- [ ] Таблица `employees`: 3 тестовых сотрудника созданы (ТестДима, ТестИван, ТестОльга)
- [ ] Таблица `events`: 5 pending-записей созданы с разными сценариями

### 2. Проверить env-переменные для bot
```bash
# .env file должен содержать:
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_WEBHOOK_SECRET=xxx
OBJECT_POSTCODE=108818
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxx
```

### 3. Проверить webhook регистрацию (если Vercel)
```bash
node bot/register-webhook.js
# Вывод: "Webhook registered" или "Webhook already registered"
```

---

## Фаза 1: Telegram Bot — OCR & Photo Upload

### 1.1 Отправить фото с подписью
**Что делать:**
1. Откройте Telegram-группу бота
2. Отправьте фото (скриншот Timestamp Camera или реальное фото с подписью)
3. В подписи напишите: **«ТестДима начало смены»**

**Ожидается:**
- [ ] Bot скачал фото из Telegram
- [ ] Bot сжал до ~150 КБ
- [ ] Bot выполнил OCR штампа (дата/время/индекс)
- [ ] Bot выполнил OCR подписи (имя + тип события)
- [ ] Bot загрузил фото в Supabase Storage

**Проверка в Supabase:**
- [ ] Таблица `events`: новая запись с `status=pending`, `photo_url` не null, `name_from_photo='ТестДима'`
- [ ] Storage `photos/`: файл создан по пути `{chatId}/{messageId}.jpg`
- [ ] Таблица `logs`: entry с `level=info, source=webhook-handler, message="Event created"`

---

## Фаза 2: AI Worker — Processing

### 2.1 Запустить AI Worker
**Вариант A: GitHub Actions (production)**
```
GitHub UI → Actions → "Process Events" → Run workflow
```

**Вариант B: Локально**
```bash
export SUPABASE_URL=https://xxx.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=xxx
export TELEGRAM_BOT_TOKEN=xxx
export MANAGER_CHAT_ID=xxx  # ваш telegram chat_id
python ai-worker/process_events.py
```

**Ожидается в консоли:**
- [ ] `AI Worker started`
- [ ] Для каждого события:
  - `event {id} | name: 'ТестДима'`
  - `matched: ТестДима`
  - `face_match: None` (нет эталона фото)
  - `event_type: arrival`
  - `hours: 9.5` (если полный день с приходом+уходом)
  - `→ done` или `→ needs_review`
- [ ] `AI Worker finished` с итогами

**Проверка в Supabase:**
- [ ] Таблица `events`, поле `status`: изменился на `done` (для полного дня) или `needs_review` (для incomplete_day)
- [ ] Поле `employee_id`: заполнено ID найденного сотрудника (fuzzy match)
- [ ] Поле `hours`: посчитаны часы (если done)
- [ ] Таблица `logs`: entries с событиями обработки

### 2.2 Telegram notification
Если записи пошли на `needs_review`, то:
- [ ] В личке Telegram менеджеру пришло уведомление: «⚠️ Требует проверки»

---

## Фаза 3: Dashboard — Verification

### 3.1 Обзор (Overview)
Откройте Dashboard → Обзор
- [ ] Стат-карточка «На объекте сегодня»: показывает количество уникальных сотрудников с событиями
- [ ] Стат-карточка «Фото сегодня»: показывает количество обработанных записей
- [ ] Таблица активности: видны события за сегодня с сотрудниками, приходом, уходом, часами, статусом
- [ ] Цвет строк: красный фон для `needs_review`, белый для `done`

### 3.2 Посещаемость (Attendance)
Откройте Dashboard → Посещаемость
- [ ] Date picker показывает сегодняшнюю дату
- [ ] Таблица: полный список событий (каждое в отдельной строке)
- [ ] Фильтры работают: по бригаде, статусу, типу события
- [ ] Клик на 🖼 открывает фото события

### 3.3 Ручная корректировка (Review)
Откройте Dashboard → Проверка (Review)
- [ ] Таблица: только записи со статусом `needs_review`
- [ ] Кнопка «Исправить»: открывает модальное окно
- [ ] Модаль: можно выбрать сотрудника, тип события, часы, статус
- [ ] Сохранить: обновляет запись в Supabase на `status=done`

**Проверка:**
- [ ] Отредактируйте одну запись `needs_review`
- [ ] Выберите сотрудника, установите hours=8.0, status=done
- [ ] Нажмите Сохранить
- [ ] Таблица Review обновилась, запись исчезла
- [ ] В Supabase → events: запись теперь `status=done`, `hours=8.0`

### 3.4 Аналитика (Analytics)
Откройте Dashboard → Аналитика
- [ ] SVG-график «Часы по дням»: показывает столбцы за каждый день периода
- [ ] Выходные (сб/вс): оранжевые бары, будни: синие
- [ ] SVG-график «По бригадам»: горизонтальные бары с ФОТ и часами
- [ ] Стат-карточки: ФОТ за период, всего часов, среднее в день, кол-во аномалий
- [ ] Навигация по месяцам: ← и →

### 3.5 Табель (Timesheet)
Откройте Dashboard → Табель
- [ ] Таблица с сотрудниками, роль, ставка, по дням месяца
- [ ] Столбец «Переход часов»: часы из прошлого периода
- [ ] Столбец «Итого часов»: сумма часов за период
- [ ] Столбец «Сумма ₽»: часы × ставка/ч
- [ ] Группировка по бригадам: с подитогами (зелёная строка)
- [ ] Выходные: оранжевый фон
- [ ] Нужны проверки: красный фон (needs_review)
- [ ] Hover на ячейку дня: всплывает фото события
- [ ] Скачать Excel: разбиение на листы по неделям, формат совпадает с текущим
- [ ] Скачать PDF: печать в A3 альбомная
- [ ] Поиск по ФИО: фильтрует строки
- [ ] Сворачивание бригад: клик на стрелку ▼/▶
- [ ] Мобильная вёрстка (≤640px): вторичные колонки скрыты, простой скролл

### 3.6 Логи (Logs)
Откройте Dashboard → Логи
- [ ] Таблица: все записи из БД logs
- [ ] Фильтры: по уровню (info/warning/error), источнику, поиск по тексту
- [ ] Цветные бейджи: INFO зелёный, WARN оранжевый, ERROR красный
- [ ] Клик на {…} в meta-столбце: раскрывает JSON прямо в строке
- [ ] Пагинация: кнопка «Загрузить ещё»
- [ ] Авто-обновление: чекбокс, запускает таймер на 30 сек

---

## Итоговая проверка

### ✅ Все сценарии passed
- [ ] Bot: OCR & upload работает
- [ ] Worker: обработка, распознавание, расчёты работают
- [ ] Dashboard: все 7 страниц работают корректно
- [ ] Данные синхронизированы между компонентами
- [ ] Логирование полное и информативное

### 🟡 Known limitations (не блокируют деплой)
- Face recognition требует эталонного фото в employees.face_embedding (вычисляется GitHub Actions)
- MANAGER_CHAT_ID может быть не задан (skip Telegram notifications)
- Некоторые фото из Timestamp Camera читаются OCR с опечатками (fuzzy match их ловит)

### 📋 Issues found
**Если нашли баги:**
1. Опишите в issue: что сломалось, какой шаг, что ожидалось, что произошло
2. Можно сразу давать PR с фиксом
3. Перезапустите тесты после фикса

---

## Деплой на production

После успешного E2E:

```bash
# 1. Push на main
git add .
git commit -m "Phase 9: E2E testing completed"
git push

# 2. Vercel deployment (автоматический по push на main)
vercel --prod

# 3. GitHub Actions secrets (если не установлены)
# GitHub UI → Settings → Secrets and variables → Actions
# SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN

# 4. Включить workflow для production
# GitHub UI → Actions → "Process Events" → Enable

# 5. Отправить ссылку на Dashboard клиенту
```

---

## Контакты/Вопросы

**Если что-то не работает:**
1. Проверьте env-переменные
2. Проверьте логи в Supabase → logs
3. Проверьте консоль webhook'а / workflow в GitHub Actions
4. Ищите ошибку в traceback или сообщении об ошибке

**Для доступа в Dashboard:**
- Email: admin@dashboard.local
- Пароль: (Supabase Auth, через dashboard UI)
