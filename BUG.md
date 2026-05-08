# 🐛 BUG Report — AI Attendance System

**Дата обновления:** 2026-05-08  
**Версия:** 3.0 (Консолидированный список)  
**Статус:** 41 баг к исправлению (приоритизированы)

---

## 📊 СВОДКА

Проведён полный аудит системы (фронтенд + бэкенд):
- ✅ **Функциональность:** Основная логика работает  
- 🔴 **КРИТИЧЕСКИЕ:** 20 багов (data loss, security, infinite loops)
- 🟠 **ВЫСОКИЕ:** 8 багов (operational, monitoring, performance)
- 🟡 **СРЕДНИЕ:** 7 багов (UX, optimization)
- ⚪ **НИЗКИЕ:** 6 багов (theoretical, edge cases)

**Всего найдено:** 41 баг к исправлению

---

# 🔴 КРИТИЧЕСКИЕ (20) — СРОЧНО

## Шаг 1: Инфраструктура & Безопасность (первых 4 критических)

### BUG-001: Vercel timeout убивает OCR — события теряются навсегда

- **Файл:** (отсутствует) `/vercel.json`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** OCR занимает 20–30 сек, Hobby-план Vercel = 10 сек. Функция убивается до `insertEvent()`, Telegram получил `200 OK` → событие потеряно **безвозвратно**.
- **Решение:** Создать `/vercel.json`:
```json
{
  "functions": {
    "api/webhook.js": { "maxDuration": 60 },
    "api/sign-photo.js": { "maxDuration": 10 }
  }
}
```

---

### BUG-002: CHECK constraint не включает 'duplicate' — бесконечный цикл

- **Файл:** `supabase/events.sql:10`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** AI-worker пытается сохранить `status='duplicate'` → PostgreSQL отклоняет → событие застревает в `processing` 15 мин → восстанавливается в `pending` → снова ошибка → **бесконечный цикл**.
- **Решение (Supabase SQL Editor):**
```sql
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_status_check,
  ADD CONSTRAINT events_status_check
    CHECK (status IN ('pending','processing','done','needs_review','duplicate','rejected'));
```

---

### BUG-003: Webhook открыт, если WEBHOOK_SECRET не задан

- **Файл:** `api/webhook.js:33-35`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Условие `if (WEBHOOK_SECRET && ...)` пропускает проверку если `WEBHOOK_SECRET` пустой → endpoint публичен → любой может создавать события.
- **Решение:**
```js
if (!WEBHOOK_SECRET || secret !== WEBHOOK_SECRET) {
  return res.status(403).end();
}
```

---

### BUG-004: RLS разрешает authenticated удалять сотрудников

- **Файл:** `supabase/rls.sql`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Политики разрешают любому authenticated пользователю удалять **всех** сотрудников или добавлять события. Anon key вшит в HTML → кто найдёт, может зарегистрироваться в Supabase.
- **Решение:** Удалить политики `for delete to authenticated` и `for insert to authenticated`. Все записи только через `service_role`.

---

## Шаг 2: XSS уязвимости (3 критических)

### BUG-005: XSS в onclick — `name_from_photo` (Telegram caption)

- **Файл:** `dashboard/index.html:1486`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** `name_from_photo` из Telegram caption без JS-экранирования. Подпись `');alert(1);//` ломает `onclick="goTo('review',{highlightEmployeeId:'${eid}'})"`.
- **Решение:**
```js
onclick="goTo('review',${JSON.stringify({highlightEmployeeId: eid})})"
```

---

### BUG-006: XSS в onclick — `display_name` при архивировании

- **Файл:** `dashboard/index.html:2644`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** `escHtml()` экранирует `"` но не `'`. Если `display_name = "Иван');alert(1);//"` → XSS.
- **Решение:**
```js
onclick="archiveEmployee('${emp.id}',${JSON.stringify(emp.display_name)})"
```

---

### BUG-007: XSS в tooltip — `event_type` без экранирования

- **Файл:** `dashboard/index.html:2952-2958`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** `${TYPE[ev.type] || ev.type}` вставляется в HTML без экранирования. Может содержать `<img onerror=...>`.
- **Решение:**
```js
${TYPE[ev.type] || escHtml(ev.type)}
```

---

### BUG-008: Path traversal в sign-photo.js — доступ к биометрическим фото

- **Файл:** `api/sign-photo.js:29-36`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Авторизованный пользователь передаёт `?path=ref-photos/uuid/face.jpg` → доступ к bucket `ref-photos` с биометрией. Утечка персональных данных.
- **Решение:**
```js
if (!path || !path.startsWith('photos/') || path.includes('..')) {
  return res.status(403).json({ error: 'Forbidden' });
}
```

---

## Шаг 3: Старые критические из первого аудита (8)

### BUG-009: Неправильная очистка photo_url в cleanup_photos.py

- **Файл:** `ai-worker/cleanup_photos.py:154`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** `clear_photo_urls(photo_urls)` передаёт **ВСЕ** URL вместо только удалённых. Обнуляет связь между events и Storage.
- **Решение:**
```python
clear_photo_urls(deleted_urls)  # только удалённые
```

---

### BUG-010: downloadTelegramPhoto() без try/catch — 500 ошибка

- **Файл:** `api/webhook.js:71`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Исключение не ловится → webhook вернёт 500 → Telegram повторит, но фото не обработается.
- **Решение:**
```js
try {
  originalBuffer = await downloadTelegramPhoto(file_id);
} catch (err) {
  await logToSupabase('error', 'webhook', `Download failed: ${err.message}`);
  return;
}
```

---

### BUG-011: face_embedding не валидируется перед compare_faces

- **Файл:** `ai-worker/process_events.py:189-209`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** `parse_embedding()` может вернуть неправильную форму → RuntimeError при `compare_faces()`.
- **Решение:**
```python
if ref_embedding.shape != (128,):
    return None  # невалидный embedding
```

---

### BUG-012: face_encodings() может зависнуть навсегда

- **Файл:** `ai-worker/process_events.py:176-186`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Нет timeout для `face_recognition.face_encodings()`. Может зависнуть на больших фото. GitHub Actions timeout = 8 мин.
- **Решение:** Добавить timeout (SIGALRM или asyncio.wait_for).

---

### BUG-013: fraud_flags без try/catch при JSON.parse

- **Файл:** `dashboard/index.html:1269, 1540`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Невалидный JSON в fraud_flags → вылет при фильтрации.
- **Решение:**
```js
function parseFraudFlags(str) {
  try { 
    const f = JSON.parse(str || '[]'); 
    return Array.isArray(f) ? f : []; 
  } catch { 
    return []; 
  }
}
```

---

### BUG-014: localStorage может упасть в приватном режиме

- **Файл:** `dashboard/index.html:1091`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** В приватном режиме браузера → SecurityError → dashboard не работает.
- **Решение:**
```js
try { 
  return localStorage.getItem('sb_token'); 
} catch { 
  return null; 
}
```

---

### BUG-015: fetch() без timeout и обработки ошибок

- **Файл:** `dashboard/index.html:1090-1102`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** При плохом интернете Promise падает без try/catch → интерфейс зависает.
- **Решение:**
```js
try {
  const res = await fetch(..., {signal: AbortSignal.timeout(10000)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (err) {
  console.error(err);
  return null;
}
```

---

### BUG-016: Нет валидации входных данных при редактировании

- **Файл:** `dashboard/index.html:1648-1680`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** `hours` может быть NaN или отрицательным. Отправляется в API без проверки.
- **Решение:**
```js
if (isNaN(hours) || hours < 0 || hours > 24) {
  showError('Часы: 0-24');
  return;
}
```

---

### BUG-017: employee name может содержать HTML — XSS через innerHTML

- **Файл:** `dashboard/index.html:1643, 2107`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Где-то используется `innerHTML` с данными из API вместо `textContent`.
- **Решение:** Везде использовать `textContent` для пользовательских данных.

---

### BUG-018: uploadRefPhoto() не проверяет res.ok

- **Файл:** `dashboard/index.html`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Upload может упасть, но функция вернёт путь → сохранит несуществующий URL в БД. Также PATCH для сохранения URL в БД не проверял результат — при его ошибке фото было в Storage, но ссылка в DB не сохранялась.
- **Решение:** `uploadRefPhoto` теперь кидает исключение при `!res.ok`. PATCH заменён на прямой `fetch` с `Prefer: return=minimal` и проверкой `patchRes.ok`.

---

### BUG-019: Экспорт Excel без проверки пустых данных

- **Файл:** `dashboard/index.html`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Если за выбранный период ни у одного сотрудника нет записей о часах — Excel создавался тихо с пустыми ячейками часов. Пользователь не понимал, что файл пустой.
- **Решение:** Добавлена проверка `hasHours` — если ни одного часа нет, показывается confirm с предупреждением. Пользователь может отменить или осознанно скачать пустой табель.

---

### BUG-020: CSV импорт без валидации

- **Файл:** `dashboard/index.html`
- **Приоритет:** 🔴 КРИТИЧЕСКИЙ
- **Статус:** ✅ Исправлено 2026-05-08
- **Описание:** Дублей против существующей базы не проверялось. Результат POST-запроса всегда считался ошибкой из-за 204 No Content → `res.json()` кидал исключение → счётчик ошибок срабатывал даже при успехе.
- **Решение:** Добавлена проверка `dbNames` против `allEmployees` перед импортом. POST заменён на прямой `fetch` с проверкой `res.ok` — корректно обрабатывает 204 No Content.

---

# 🟠 ВЫСОКИЕ (8)

### BUG-021: notify_manager не вызывается для дубликатов

- **Файл:** `ai-worker/process_events.py:738-810`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** При дублях → руководитель не уведомлён → часы не считаются.
- **Решение:** Добавить `notify_manager()` перед `continue`.

---

### BUG-022: Мониторинг не ловит warning'и ('warn' vs 'warning')

- **Файл:** `.github/workflows/monitor-logs.yml:80`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** Мониторинг ищет `'warn'`, worker пишет `'warning'` → несовпадение.
- **Решение:**
```js
if (l.level === 'warning' || l.level === 'warn' || l.level === 'error')
```

---

### BUG-023: BATCH_SIZE × FACE_TIMEOUT > 8 мин GitHub Actions timeout

- **Файл:** `ai-worker/process_events.py:27-29`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** 20 × 30 сек = 600 сек > 8 мин → воркер убивается.
- **Решение:**
```python
BATCH_SIZE = 10      # 10 × 25 = 250 сек ✓
FACE_TIMEOUT = 25
```

---

### BUG-024: N+1 — все_employees загружается 20 раз вместо 1

- **Файл:** `ai-worker/process_events.py:215-220`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** `find_employee_by_name()` загружает employees для каждого события.
- **Решение:** Кэшировать до цикла в `main()`.

---

### BUG-025: guardedFetch(null) показывает "Всё проверено" вместо ошибки

- **Файл:** `dashboard/index.html:1382, 1680, 3171`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** При сетевой ошибке `null` → пустой массив → ложное "всё хорошо".
- **Решение:** Проверять `null` отдельно, показывать error-banner.

---

### BUG-026: SELECT * тянет face_embedding — 50 KB лишних данных

- **Файл:** `dashboard/index.html:2605`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** `face_embedding` — массив 128 float = 1 KB × 50 сотрудников = лишние 50 KB при каждой загрузке.
- **Решение:** Указать конкретные колонки в `select`.

---

### BUG-027: Pillow 10.4.0 содержит CVE

- **Файл:** `ai-worker/requirements-worker.txt`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Не исправлено
- **Описание:** Устаревшая версия с известными уязвимостями.
- **Решение:**
```
Pillow==11.2.1
```

---

### BUG-028: ⚙️ MANAGER_CHAT_ID пустой — нет уведомлений

- **Файл:** `.env:12`
- **Приоритет:** 🟠 ВЫСОКИЙ
- **Статус:** Требует действия руководителя (конфигурация)
- **Описание:** MANAGER_CHAT_ID не задан → все уведомления отключены молча.
- **Действие:** Руководитель должен:
  1. Написать `@userinfobot` в Telegram
  2. Добавить ID в GitHub Secrets → `MANAGER_CHAT_ID=<id>`
  3. Добавить ID в Vercel → Environment Variables

---

# 🟡 СРЕДНИЕ (7)

### BUG-029: Sequential PATCH вместо batch

- **Файл:** `dashboard/index.html:1855`
- **Описание:** confirmDoubleShift отправляет 4 запроса последовательно вместо 1 batch.

---

### BUG-030: Нет bulk-approve в вкладке Review

- **Файл:** `dashboard/index.html`
- **Описание:** Каждое needs_review требует минимум 2 клика. Нет одобрения нескольких сразу.

---

### BUG-031: daily_rate=0 показывает "—" вместо предупреждения

- **Файл:** `dashboard/index.html:3406`
- **Описание:** Авто-созданные сотрудники показывают "—" вместо предупреждения о незаполненной ставке.

---

### BUG-032: SheetJS загружается с внешнего CDN

- **Файл:** `dashboard/index.html:3453`
- **Описание:** Нарушает CLAUDE.md правило 6. Если CDN недоступен → Excel-экспорт не работает.

---

### BUG-033: face_timeout без флага — событие идёт в done без проверки

- **Файл:** `ai-worker/process_events.py:363`
- **Описание:** При timeout распознавания лица → нет флага → событие проходит без верификации.

---

### BUG-034: Нет авто-обновления дашборда

- **Файл:** `dashboard/index.html`
- **Описание:** Руководитель должен вручную F5 для обновления новых needs_review.

---

### BUG-035: sb_get/sb_patch без try/except — падение весь воркер

- **Файл:** `ai-worker/process_events.py:56-82`
- **Описание:** `ConnectionError` → необработанное исключение → весь воркер падает → события в `processing` 15 мин.

---

# ⚪ НИЗКИЕ (6)

### BUG-036: Supabase anon key в HTML

- **Описание:** Видна в исходнике, но приемлемо при RLS.

---

### BUG-037: Token в localStorage — XSS уязвив при наличии XSS

- **Описание:** При XS (BUG-005 и др.) атакующий читает token.

---

### BUG-038: Timing attack на webhook secret

- **Описание:** Теоретический (Vercel latency добавляет шум).

---

### BUG-039: GitHub Actions без SHA pin

- **Описание:** Supply chain risk (теоретический).

---

### BUG-040: Blob URLs не revoke — утечка памяти

- **Описание:** При длительной работе в табеле может быть утечка памяти.

---

### BUG-041: SIGALRM не работает на Windows

- **Описание:** GitHub Actions = Ubuntu, не влияет на продакшн.

---

## 📋 ИТОГОВАЯ ТАБЛИЦА

| Приоритет | Кол-во | Статус |
|-----------|--------|--------|
| 🔴 КРИТИЧЕСКИЕ | 20 | **СРОЧНО** |
| 🟠 ВЫСОКИЕ | 8 | **СРОЧНО** |
| 🟡 СРЕДНИЕ | 7 | Можно отложить |
| ⚪ НИЗКИЕ | 6 | Теоретические |
| **ВСЕГО** | **41** | |

---

## ✅ ЧТО РАБОТАЕТ ПРАВИЛЬНО

- ✅ Основная логика обработки событий
- ✅ Face recognition интеграция (при наличии timeout)
- ✅ Расчёт часов (при наличии парей)
- ✅ Аутентификация (базовая)
- ✅ Сжатие фото в webhook

---

**Дата создания:** 2026-04-22  
**Обновлено:** 2026-05-08  
**Версия:** 3.0 (Консолидировано)
