# Deployment Guide — AI Attendance System

Деплой всей системы на Vercel (Dashboard + Bot) и настройка GitHub Actions (AI Worker).

**Время на полный деплой:** ~30 минут

---

## Архитектура deployment

```
┌─────────────────────────────────────────────────────────────┐
│                    Vercel (Dashboard + Bot)                  │
├─────────────────────────────────────────────────────────────┤
│  /dashboard/index.html  →  GET /         (SPA + static)     │
│  /api/webhook.js        →  POST /api/webhook  (serverless)   │
└─────────────────────────────────────────────────────────────┘
                              ↕ (Telegram, REST API)
          ┌─────────────────────┴─────────────────────┐
          ↓                                           ↓
    [Telegram API]                          [Supabase REST API]
                                            - events (INSERT)
                                            - employees (GET)
                                            - logs (INSERT)
          ↕
    [Telegram BotFather]
    [Telegram Group/Channel]

┌─────────────────────────────────────────────────────────────┐
│             GitHub Actions (AI Worker, Cleanup)              │
├─────────────────────────────────────────────────────────────┤
│  - process_events.py  (cron: каждые 5-10 минут)            │
│  - cleanup_photos.py  (cron: раз в сутки)                   │
│  - compute_embeddings.py (on-demand: при регистрации)       │
└─────────────────────────────────────────────────────────────┘
                              ↕
                      [Supabase REST API]
```

---

## Часть 1: Vercel Deployment (Dashboard + Bot)

### 1.1 Требования
- GitHub аккаунт с репозиторием (уже есть)
- Vercel аккаунт (free tier достаточно)
- Доступ к Supabase credentials
- Telegram Bot Token и Webhook Secret

### 1.2 Создать Vercel проект

**Вариант A: Через Vercel UI (рекомендуется)**

1. Откройте https://vercel.com/new
2. Авторизуйтесь GitHub (или создайте аккаунт)
3. Выберите репозиторий `time-tracking-service`
4. Project Name: `time-tracking-service`
5. Framework: **None** (не выбирайте Next.js)
6. Root Directory: **.** (корень репозитория)
7. Нажмите "Deploy"

Vercel автоматически:
- Установит зависимости из корневого `package.json` (sharp, tesseract.js для webhook)
- Установит зависимости из `bot/package.json` для регистрации webhook'а
- Соберёт webhook функцию `api/webhook.js`
- Разместит Dashboard статику
- Выдаст URL: `https://time-tracking-service.vercel.app`

**Вариант B: Через CLI**

```bash
npm install -g vercel
vercel login
cd /path/to/time-tracking-service
vercel --prod
```

### 1.3 Добавить Environment Variables в Vercel

Откройте **Settings → Environment Variables** в Vercel UI:

| Variable | Value | Required |
|----------|-------|----------|
| `SUPABASE_URL` | `https://xxx.supabase.co` | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGc...` | ✅ |
| `TELEGRAM_BOT_TOKEN` | `123456:ABCdef...` | ✅ |
| `TELEGRAM_WEBHOOK_SECRET` | `your-secret-token` | ✅ |
| `OBJECT_POSTCODE` | `108818` | ✅ |
| `MANAGER_CHAT_ID` | `987654321` | ⚠️ Optional |

**Где найти каждую:**

- **SUPABASE_URL**: Supabase Project Settings → API → URL
- **SUPABASE_SERVICE_ROLE_KEY**: Supabase Project Settings → API → Service Role Secret
- **TELEGRAM_BOT_TOKEN**: BotFather → `/mybots` → выбрать бота → Token
- **TELEGRAM_WEBHOOK_SECRET**: любая случайная строка (генерируется один раз, передаётся Telegram)
- **MANAGER_CHAT_ID**: ID чата менеджера в Telegram (число) — опционально, можно добавить позже

### 1.4 Проверить развёртывание

```bash
# 1. Проверить Dashboard доступен
curl https://time-tracking-service.vercel.app/
# Должен вернуть HTML login-страницы

# 2. Проверить Bot webhook
curl -X POST https://time-tracking-service.vercel.app/api/webhook \
  -H "Content-Type: application/json" \
  -H "X-Telegram-Bot-Api-Secret-Token: your-secret-token" \
  -d '{"message":{"text":"test"}}'
# Должен вернуть 200

# 3. Проверить Vercel logs
vercel logs https://time-tracking-service.vercel.app
# или в Vercel UI → Deployments → выбрать deployment → Logs
```

### 1.5 Зарегистрировать Telegram Webhook

Telegram должен отправлять фото на адрес вашего Vercel:

```bash
# Скопируйте в bot/.env:
TELEGRAM_BOT_TOKEN=123456:ABCdef...
TELEGRAM_WEBHOOK_SECRET=your-secret-token
VERCEL_URL=https://time-tracking-service.vercel.app

# Запустите регистрацию:
node bot/register-webhook.js
# Вывод: "Webhook registered successfully" или "Webhook updated"

# Или вручную через curl:
curl -X POST "https://api.telegram.org/bot{TOKEN}/setWebhook" \
  -d url="https://time-tracking-service.vercel.app/api/webhook" \
  -d secret_token="your-secret-token"
```

**Проверить регистрацию:**

```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/getWebhookInfo"
# Должен показать: "url": "https://time-tracking-service.vercel.app/api/webhook"
```

---

## Часть 2: GitHub Actions Setup (AI Worker)

### 2.1 Добавить Secrets в GitHub

1. GitHub UI → Settings → Secrets and variables → Actions → "New repository secret"

| Secret | Value |
|--------|-------|
| `SUPABASE_URL` | `https://xxx.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | `eyJhbGc...` |
| `TELEGRAM_BOT_TOKEN` | `123456:ABCdef...` (optional, для notify) |
| `MANAGER_CHAT_ID` | `987654321` (optional, для notify) |

### 2.2 Проверить Workflows

1. GitHub UI → Actions
2. Должны быть workflow'ы:
   - ✅ **Process Events** (trigger: schedule каждые 5-10 мин, manual)
   - ✅ **Delete Photos** (trigger: schedule раз в сутки)
   - ✅ **Compute Face Embeddings** (trigger: on-demand)

Все должны быть **enabled** (зелёная галка).

### 2.3 Тестовый запуск AI Worker

1. GitHub UI → Actions → "Process Events"
2. Нажмите кнопку **"Run workflow"**
3. Дождитесь завершения (обычно < 2 мин)
4. Проверьте **Logs** → должны быть сообщения обработки

---

## Часть 3: End-to-End Testing на Production

### 3.1 Отправить тестовое фото в Telegram

1. Откройте Telegram-группу вашего бота
2. Отправьте фото с подписью: **«Тест приход»**

**Ожидается:**
- [ ] Bot получил фото
- [ ] OCR обработал штамп и подпись
- [ ] Фото загружено в Supabase Storage
- [ ] Запись добавлена в events (status=pending)

**Проверка:** Supabase → events → должна быть новая запись с текущей датой

### 3.2 Запустить AI Worker

**GitHub Actions:**
1. Actions → "Process Events" → "Run workflow"
2. Дождитесь (< 2 мин)
3. Проверьте логи

**Ожидается:**
- [ ] Event обработан
- [ ] Status изменился с pending на done или needs_review
- [ ] Логи записаны в таблицу logs

### 3.3 Проверить Dashboard

1. Откройте https://time-tracking-service.vercel.app
2. Email: `admin@dashboard.local` (или тот, который настроили в Supabase Auth)
3. Введите пароль

**Проверьте страницы:**
- [ ] **Обзор**: статистика за день, таблица активности
- [ ] **Посещаемость**: логирование событий за день
- [ ] **Проверка**: if needs_review, можно отредактировать и сохранить
- [ ] **Табель**: за месяц, группировка по бригадам, Excel/PDF экспорт
- [ ] **Аналитика**: графики, ФОТ, аномалии
- [ ] **Логи**: события системы, фильтры

---

## Часть 4: Production Configuration

### 4.1 Настроить мониторинг

**Vercel:**
- Settings → Monitoring → Enable Sentry (опционально)
- Logs → автоматически сохраняются 24 часа

**GitHub Actions:**
- Настроить notifications: Settings → Notifications → Actions
- Или email при failure of workflow

### 4.2 Резервные копии Supabase

1. Supabase → Settings → Backups
2. Включить daily backups (минимум для paid plans)
3. Или экспортировать вручную раз в неделю

### 4.3 Обновления кода

```bash
# 1. Сделайте изменения локально
git add .
git commit -m "Feature: ..."
git push origin main

# 2. Vercel автоматически перестроит и задеплоит
# → Vercel UI → Deployments → должен быть новый deployment

# 3. GitHub Actions workflows обновятся автоматически
```

---

## Troubleshooting

### Верификация неудачна при регистрации webhook

```
error_code: 409
description: "Conflict: terminated by other getUpdates request..."
```

**Решение:** На боте включен polling mode. Отключите его:
```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/deleteWebhook"
```

Затем повторно зарегистрируйте webhook.

### Фото не загружается в Storage

```
error: "Storage bucket 'photos' not found"
```

**Решение:**
1. Supabase → Storage
2. Создайте bucket `photos` (если не существует)
3. Выставьте RLS политики (см. supabase/storage-rls.sql)

### AI Worker не обрабатывает события

**Проверить:**
1. GitHub Secrets установлены? → Actions → Settings → Secrets
2. Workflow enabled? → Actions → нужный workflow → должна быть зелёная галка
3. Проверить логи: Actions → workflow run → Logs
4. Проверить Supabase логи: Supabase → таблица logs

### Dashboard показывает "Unauthorised" при входе

**Решение:**
1. Проверить, что Supabase Auth включен
2. Проверить SUPABASE_KEY в dashboard/index.html (должен быть anon key, не service role)
3. Проверить, что пользователь создан в Supabase Auth

---

## Контрольный список перед продакшном

- [ ] Vercel deployment успешен (Dashboard доступен)
- [ ] Webhook зарегистрирован у Telegram
- [ ] GitHub Secrets добавлены
- [ ] Workflows enabled и работают
- [ ] Test end-to-end цикл пройден: фото → Bot → Worker → Dashboard
- [ ] Мониторинг/логирование настроено
- [ ] Резервные копии включены
- [ ] Team членам выданы доступы (Vercel, GitHub, Supabase)

---

## Ссылки

- **Vercel Docs**: https://vercel.com/docs
- **GitHub Actions**: https://docs.github.com/en/actions
- **Supabase**: https://supabase.com/docs
- **Telegram Bot API**: https://core.telegram.org/bots/api
- **Project Repository**: https://github.com/aleksis33375/time-tracking-service

---

## Поддержка

Если что-то не работает:
1. Проверьте **Vercel Logs** → Deployments → выбрать deployment → Logs
2. Проверьте **GitHub Actions Logs** → Actions → workflow run → Logs
3. Проверьте **Supabase Logs** → таблица logs в базе
4. Откройте **issue** на GitHub с описанием проблемы
