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
- [ ] Supabase Auth integration
- [ ] Row Level Security на employees, events, logs
- [ ] Login-страница в Dashboard
- [ ] Защита всех страниц Dashboard авторизацией

---

## Фаза 3 — Базовый Dashboard + регистрация сотрудников
- [ ] SPA-оболочка (index.html, навигация, стили)
- [ ] Страница «Сотрудники»: список, добавление, редактирование
- [ ] Soft delete (архивирование) — история часов сохраняется
- [ ] Массовый импорт сотрудников из Excel/CSV (онбординг 120+)
- [ ] Поля сотрудника: имя (любое, как на фото), роль, бригада,
      дневная ставка, эталонное фото
- [ ] Авто-расчёт часовой ставки = дневная ставка ÷ 8
- [ ] Загрузка эталонного фото в Supabase Storage
- [ ] GitHub Actions workflow: вычисление face embedding при регистрации
- [ ] Сохранение embedding в employees

---

## Фаза 4 — Telegram Bot (Vercel Serverless Function)
- [ ] Создать бота через BotFather, отключить privacy mode
- [ ] Добавить бота в существующую группу
- [ ] Vercel Serverless Function: webhook handler
- [ ] Регистрация webhook с secret_token + валидация заголовка
      X-Telegram-Bot-Api-Secret-Token
- [ ] Фильтрация: обрабатывать ТОЛЬКО фото, остальное игнорировать
- [ ] Сжатие входящего фото до ~150 КБ перед сохранением
- [ ] OCR верхней правой области: дата, время, город, индекс
- [ ] OCR нижней области: имя сотрудника + тип события
      («начало смены» / «конец смены»)
- [ ] Сверка индекса с OBJECT_POSTCODE →
      если не совпал: fraud_flag = "wrong_location"
- [ ] Сохранение сжатого фото в Supabase Storage
- [ ] Запись в events: status=pending, photo_timestamp, name_from_photo,
      event_type_raw, postcode_from_photo, fraud_flags

---

## Фаза 5 — AI Worker (GitHub Actions с батчингом)
- [ ] Workflow: запуск по cron каждые 5–10 минут
- [ ] concurrency: group в workflow (запрет параллельных запусков)
- [ ] Атомарный захват записей: UPDATE status=processing + processing_started_at
- [ ] Восстановление зависших: processing > 15 мин → вернуть в pending
- [ ] Поиск сотрудника по name_from_photo
- [ ] Face recognition как верификация (лицо соответствует подписи?)
- [ ] Несовпадение лица → fraud_flag="face_mismatch", status=needs_review
- [ ] event_type берётся из event_type_raw (не угадывается по времени)
- [ ] Расчёт часов: последний «конец смены» − первый «начало смены»
      за этот день. Обед НЕ вычитается. Результат — дробное число (9.5 = 9ч 30м)
- [ ] Если за день только приход ИЛИ только уход →
      incomplete_day, status=needs_review
- [ ] Выходные (сб, вс) обрабатываются как будние — те же правила расчёта
- [ ] Обновление events: status=done, employee_id, event_type, hours
- [ ] Нераспознанные / с fraud_flags → status=needs_review
- [ ] Telegram-уведомление руководителю в личку при появлении needs_review
- [ ] Запись бизнес-событий в таблицу logs

---

## Фаза 6 — Автоудаление старых фото
- [ ] Отдельный GitHub Actions workflow по cron (раз в сутки)
- [ ] Удаление файлов фото из Storage старше 30 дней
- [ ] Записи в events остаются навсегда (удаляются только файлы)
- [ ] Запись в logs: сколько файлов удалено за прогон

---

## Фаза 7 — Главная страница «Табель» (флагман)
- [ ] Структура таблицы: ФИО, роль, дневная ставка, ст-ть часа,
      переход часов, дни периода, итоговые часы, сумма
- [ ] Авто-расчёт «Переход часов» из предыдущего периода
- [ ] Авто-расчёт «Всего часов» = SUM(дни),
      «Сумма» = Всего часов × Стоимость часа
- [ ] Группировка по бригадам + зелёные подитоги
      (пустая строка-разделитель между бригадами)
- [ ] Оранжевая подсветка субботы/воскресенья
      (визуальная, не влияет на расчёт)
- [ ] Красная подсветка needs_review
- [ ] Иконка ⚠️ на ячейке при наличии fraud_flags
- [ ] Hover по ячейке дня → всплывает фото из Telegram
- [ ] Поиск по ФИО, сворачивание бригад
- [ ] Выбор периода: день / неделя / месяц / произвольный
- [ ] Кнопка «Скачать Excel»: разбиение на листы по неделям
      (23.03-31.03, 01.04-08.04 и т.д.) — формат совпадает с текущим
- [ ] Кнопка «Скачать PDF» (для печати и подписи)
- [ ] Мобильная вёрстка: упрощённый вид (скролл по дням)

---

## Фаза 8 — Остальные страницы Dashboard
- [ ] Страница «Главная / Обзор» (сводка за день по объекту)
- [ ] Страница «Посещаемость» (таблица отметок по сотрудникам)
- [ ] Страница «Ручная корректировка» (правки, needs_review, fraud_flags)
- [ ] Страница «Аналитика» (графики, ФОТ, аномалии)
- [ ] Страница «События системы» (журнал из таблицы logs)

---

## Фаза 9 — Финал
- [ ] Тестирование на реальных данных (end-to-end)
- [ ] Деплой Dashboard + Bot на Vercel
- [ ] AI Worker GitHub Actions в продакшн-режиме
- [ ] Документация для клиента
