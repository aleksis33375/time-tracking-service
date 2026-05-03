# Deployment Status — AI Attendance System

**Дата обновления:** 2026-05-03  
**Статус:** ✅ Система в продакшне, работает

---

## Текущие URL

| Компонент | URL |
|---|---|
| Dashboard | https://time-tracking-service-beta.vercel.app/ |
| Webhook (Telegram) | https://time-tracking-service-beta.vercel.app/api/webhook |
| Supabase | https://weqvsquaftkxrafybrnk.supabase.co |

---

## Статус компонентов

### ✅ Vercel (Dashboard + Webhook)
- Задеплоен, работает
- `api/webhook.js` — принимает фото из Telegram, парсит подпись, сохраняет в Supabase
- `dashboard/index.html` — SPA, 7 страниц, доступен по URL выше
- Webhook зарегистрирован у Telegram (`setWebhook`)

### ✅ Supabase (База данных + Storage)
- Таблицы: `employees`, `events`, `logs`
- Storage buckets: `photos`, `ref-photos`
- RLS настроены
- Auth user: `admin@dashboard.local`

### ✅ GitHub Actions (AI Worker)
- `ai-worker.yml` — каждые 5 мин, обрабатывает pending → done/needs_review
- `cleanup-photos.yml` — ежедневно 02:00 UTC, удаляет фото старше 60 дней
- `face-embedding.yml` — каждые 10 мин, вычисляет face embeddings для новых сотрудников
- Все workflows включены и работают

---

## Настроенные секреты

### GitHub Secrets (для Actions)
- [x] `SUPABASE_URL`
- [x] `SUPABASE_SERVICE_ROLE_KEY`
- [x] `TELEGRAM_BOT_TOKEN`
- [ ] `MANAGER_CHAT_ID` — **не настроен** (уведомления руководителю не работают)

### Vercel Environment Variables
- [x] `SUPABASE_URL`
- [x] `SUPABASE_SERVICE_ROLE_KEY`
- [x] `TELEGRAM_BOT_TOKEN`
- [x] `TELEGRAM_WEBHOOK_SECRET`

---

## Что работает

- [x] Рабочий отправляет фото → сохраняется в events(status=pending)
- [x] AI Worker обрабатывает: face recognition, расчёт часов, fraud_flags
- [x] Автосоздание нового сотрудника при первом фото (команда «Авто»)
- [x] Нечеловеческие фото (лестница, предметы) отклоняются (BUG-038)
- [x] Двойные смены детектируются и попадают в needs_review
- [x] Dashboard: Обзор, Посещаемость, Проверка, Табель, Аналитика, Логи, Сотрудники
- [x] Экспорт Excel и PDF
- [x] Cleanup старых фото (60 дней)

## Что НЕ работает / Не настроено

- [ ] Telegram-уведомления руководителю при needs_review (нужен MANAGER_CHAT_ID)
- [ ] Парсинг времени из подписи (Фаза 11 — не реализована)

---

## Последние деплои

| Дата | Что изменилось |
|---|---|
| 2026-05-03 | BUG-038: отклонение фото без лица; авто-создание сотрудников (Этап C) |
| 2026-05-01 | Этап B: buffer-state алгоритм, детект двойных смен, UI карточки Review |
| 2026-05-01 | Этап A: фикс URL-encoding +00:00, pair-based расчёт часов (commit 6de68d4) |
| 2026-04-30 | BUG-030: EXIF + OCR timestamp extraction в webhook |
| 2026-04-25 | BUG-025: расширен парсер подписей (канца, канец и др.) |
