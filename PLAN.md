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
