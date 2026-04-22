# 🐛 BUG Report — AI Attendance System

**Дата аудита:** 2026-04-22  
**Версия:** 1.0  
**Статус:** Требует исправления

---

## Сводка

Проведен полный аудит системы (фронтенд + бакэнд):
- ✅ **Функциональность:** Основная логика работает правильно
- ⚠️ **Обработка ошибок:** Много мест без try-catch
- ⚠️ **Граничные случаи:** Не все сценарии покрыты
- ⚠️ **Безопасность:** Несколько потенциальных уязвимостей

**Найдено багов:** 12 (1 критический, 5 высокий, 6 средний)

---

## 🔴 КРИТИЧЕСКИЕ (1)

### BUG-001: Неправильная очистка photo_url в cleanup_photos.py

**Файл:** `ai-worker/cleanup_photos.py:154`  
**Приоритет:** 🔴 КРИТИЧЕСКИЙ  
**Статус:** Не исправлено  

**Описание:**

```python
# НЕПРАВИЛЬНО:
if deleted:
    deleted_urls = [
        url for url in photo_urls
        if storage_path_to_object(url) in set(object_paths[:deleted])
    ]
    clear_photo_urls(photo_urls)   # ← ОШИБКА: передаёт ВСЕ photo_urls
```

Функция `clear_photo_urls()` вызывается с **полным списком** `photo_urls`, но логика предполагает очищать только успешно удалённые файлы. Это приводит к тому, что `photo_url` обнуляется для **всех** старых фото, включая те, которые не были удалены из Storage.

**Последствия:**
- Потеря связи между events и Storage (orphaned файлы могут остаться)
- При повторном запуске cleanup отсутствие photo_url предотвратит повторную попытку удаления
- Нарушение целостности данных

**Решение:**
```python
# ПРАВИЛЬНО:
if deleted:
    deleted_urls = [
        url for url in photo_urls
        if storage_path_to_object(url) in set(object_paths[:deleted])
    ]
    clear_photo_urls(deleted_urls)   # ← передаём ТОЛЬКО удалённые
```

---

## 🟠 ВЫСОКИЕ (5)

### BUG-002: Нет обработки исключений при загрузке фото из Telegram

**Файл:** `bot/api/webhook.js:71`  
**Приоритет:** 🟠 ВЫСОКИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
const originalBuffer = await downloadTelegramPhoto(largest.file_id);
if (!originalBuffer) {
  // ...
  return;
}
```

Функция `downloadTelegramPhoto()` может выбросить исключение, которое не будет поймано и приведёт к падению обработчика.

**Последствия:**
- Webhook вернёт 500 вместо 200 (Telegram будет пытаться переотправить)
- Фото не будет обработано
- Запись логов об ошибке может не пройти

**Решение:**
```javascript
let originalBuffer;
try {
  originalBuffer = await downloadTelegramPhoto(largest.file_id);
} catch (err) {
  await logToSupabase('error', 'webhook-handler', `Failed to download photo: ${err.message}`);
  return;
}
```

---

### BUG-003: Нет проверки валидности face embedding перед сравнением

**Файл:** `ai-worker/process_events.py:189-209`  
**Приоритет:** 🟠 ВЫСОКИЙ  
**Статус:** Не исправлено  

**Описание:**

```python
def verify_face(photo_url: str, employee: dict) -> bool | None:
    ref_embedding = parse_embedding(employee.get("face_embedding"))
    if ref_embedding is None:
        return None
    
    # ... может быть invalid numpy array
    matches = face_recognition.compare_faces(
        [ref_embedding], event_encoding, tolerance=FACE_TOLERANCE
    )
```

Функция `parse_embedding()` может вернуть numpy array с неправильной формой или содержимым. `face_recognition.compare_faces()` требует embedding формы `(128,)`, но нет проверки.

**Последствия:**
- RuntimeError при неправильной форме embedding
- Event будет помечен как needs_review вместо правильной обработки
- Непредсказуемое поведение

**Решение:**
```python
def verify_face(...):
    ref_embedding = parse_embedding(employee.get("face_embedding"))
    if ref_embedding is None:
        return None
    
    # Проверяем формат
    if ref_embedding.shape != (128,):
        return None  # невалидный embedding
    
    # ... rest of code
```

---

### BUG-004: Нет timeout для compute_face_encoding в AI Worker

**Файл:** `ai-worker/process_events.py:176-186`  
**Приоритет:** 🟠 ВЫСОКИЙ  
**Статус:** Не исправлено  

**Описание:**

```python
def compute_face_encoding(image_bytes: bytes) -> np.ndarray | None:
    with tempfile.NamedTemporaryFile(...) as tmp:
        tmp.write(image_bytes)
        tmp_path = tmp.name
    try:
        image     = face_recognition.load_image_file(tmp_path)
        encodings = face_recognition.face_encodings(image, num_jitters=1)
        # ↑ Может зависнуть на больших или поломанных фото
```

`face_recognition.face_encodings()` может зависнуть, нет timeout. GitHub Actions имеет таймаут 8 минут, но операция face recognition может превысить это время без явного ограничения.

**Последствия:**
- Workflow зависает на одном событии
- Остальные события не обрабатываются
- Ресурсы тратятся впустую

**Решение:** Использовать сигнал SIGALRM или asyncio.wait_for с timeout.

---

### BUG-005: Нет обработки случая, когда все значения fraud_flags невалидны в Dashboard

**Файл:** `dashboard/index.html:1269, 1540, 1621`  
**Приоритет:** 🟠 ВЫСОКИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
try { 
  const f = JSON.parse(ev.fraud_flags); 
  if (Array.isArray(f)) slot.frauds.push(...f); 
} catch {}
```

При попытке отобразить fraud_flags, если JSON невалиден, это молча игнорируется. Но есть другие места, где fraud_flags используются для фильтрации без проверки:

```javascript
const f = JSON.parse(ev.fraud_flags);
return Array.isArray(f) && f.includes(filterFraud);  // ← может крашнуть
```

**Последствия:**
- Некорректное отображение (отсутствие fraud_flags)
- Неправильное поведение фильтра
- Потеря данных

**Решение:** Использовать функцию helper для безопасного парсинга:
```javascript
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

### BUG-006: Нет проверки доступности localStorage в Dashboard

**Файл:** `dashboard/index.html:1091, 1114, 1136, 1148`  
**Приоритет:** 🟠 ВЫСОКИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
const token = localStorage.getItem('sb_token');
```

В браузере, работающем в приватном режиме или в старых версиях, `localStorage` может быть недоступна. Это вызовет исключение `QuotaExceededError` или `SecurityError`.

**Последствия:**
- Dashboard не работает в приватном режиме браузера
- Пользователь не может войти
- Исключение в консоли не ловится

**Решение:**
```javascript
function getToken() { 
  try { 
    return localStorage.getItem('sb_token'); 
  } catch { 
    return null; 
  } 
}
function setToken(token) {
  try { 
    localStorage.setItem('sb_token', token);
  } catch {
    // Fallback: использовать sessionStorage или memory
    console.warn('localStorage unavailable');
  }
}
```

---

## 🟡 СРЕДНИЕ (6)

### BUG-007: Нет обработки сетевых ошибок при fetch в Dashboard

**Файл:** `dashboard/index.html:1090-1102`  
**Приоритет:** 🟡 СРЕДНИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
async function supabaseFetch(path, options = {}) {
  const token = localStorage.getItem('sb_token');
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...options,
    headers: { ... }
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return text; }
}
```

Нет обработки для:
- Network timeout
- Connection refused
- DNS errors
- 5xx server errors

При сетевой ошибке Promise отклоняется без try-catch, и вызывающая функция падает.

**Последствия:**
- Незаметные ошибки при плохом интернете
- Пользователь видит незавершённый интерфейс
- Нет информации об ошибке

**Решение:**
```javascript
async function supabaseFetch(path, options = {}) {
  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, {
      ...options,
      headers: { ... },
      signal: AbortSignal.timeout(10000)  // timeout 10s
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // ... rest
  } catch (err) {
    console.error('Fetch error:', err);
    return null;  // или throw для обработки выше
  }
}
```

---

### BUG-008: Нет валидации входных данных при редактировании события

**Файл:** `dashboard/index.html:1648-1680`  
**Приоритет:** 🟡 СРЕДНИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
const hoursVal  = document.getElementById('rv-edit-hours').value;
const status    = document.getElementById('rv-edit-status').value;
// ...
if (hoursVal !== '') patch.hours = parseFloat(hoursVal);  // ← может быть NaN
if (!['done', 'needs_review'].includes(status)) {
  // ← no error, just skip? не ясно что произойдёт
}
```

Нет проверки:
- `hours` может быть отрицательным или NaN
- `status` может быть невалидным значением
- `fraud_flags` может содержать XSS

**Последствия:**
- Отправка невалидных данных в API
- Некорректные часы в отчётах
- Потенциальная XSS уязвимость

**Решение:**
```javascript
function saveReviewEvent() {
  const patch = {};
  
  const hoursVal = document.getElementById('rv-edit-hours').value;
  if (hoursVal !== '') {
    const hours = parseFloat(hoursVal);
    if (isNaN(hours) || hours < 0) {
      showError('Часы должны быть положительным числом');
      return;
    }
    patch.hours = hours;
  }
  
  const status = document.getElementById('rv-edit-status').value;
  if (!['done', 'needs_review'].includes(status)) {
    showError('Неверный статус');
    return;
  }
  patch.status = status;
  
  // ... rest
}
```

---

### BUG-009: Потенциальная XSS в отображении имени сотрудника

**Файл:** `dashboard/index.html:1643, 2107`  
**Приоритет:** 🟡 СРЕДНИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
document.getElementById('emp-form-name').value = emp.display_name;
// Позже:
row.innerHTML = `<td>${emp.display_name}</td>`;  // ← XSS!
```

Хотя в большинстве мест используется `textContent`, есть несколько мест, где `innerHTML` используется напрямую с данными из API.

**Последствия:**
- XSS атака если display_name содержит `<script>`
- Кража токенов
- Выполнение вредоносного кода в браузере

**Решение:** Использовать везде `textContent` вместо `innerHTML`.

---

### BUG-010: Нет обработки ошибок при загрузке фото сотрудника

**Файл:** `dashboard/index.html:2420-2440`  
**Приоритет:** 🟡 СРЕДНИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
async function uploadRefPhoto(employeeId, file) {
  const ext  = (file.name.split('.').pop() || 'jpg').toLowerCase();
  const path = `${employeeId}/ref.${ext}`;
  const res  = await fetch(`${SUPABASE_URL}/storage/v1/object/ref-photos/${path}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${getToken()}`,
      'Content-Type': 'image/jpeg',
    },
    body: file
  });
  
  // Нет проверки res.ok!
  return `ref-photos/${path}`;  // ← может содержать ошибку вместо пути
}
```

Функция не проверяет статус ответа перед возвратом пути.

**Последствия:**
- Сохранение несуществующего пути в BD
- Face embedding не вычислится
- Незаметная ошибка для пользователя

**Решение:**
```javascript
const res = await fetch(...);
if (!res.ok) {
  throw new Error(`Upload failed: ${res.status}`);
}
return `ref-photos/${path}`;
```

---

### BUG-011: Нет проверки на пустой список при экспорте Excel

**Файл:** `dashboard/index.html:1843-1860`  
**Приоритет:** 🟡 СРЕДНИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
async function downloadTimesheet(format) {
  // ... loading data
  const rowsData = filteredRows.map(...);
  
  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    // Если filteredRows пусто, создаст пустую книгу без ошибки
    // но Excel может открыться некорректно
  }
}
```

Нет проверки на пустые данные перед экспортом.

**Последствия:**
- Экспорт пустого файла без предупреждения
- Запутанность пользователя
- Неудобство

**Решение:**
```javascript
if (!rowsData || rowsData.length === 0) {
  alert('Нет данных для экспорта');
  return;
}
```

---

### BUG-012: Нет обработки ошибок при импорте CSV в Dashboard

**Файл:** `dashboard/index.html:2190-2230`  
**Приоритет:** 🟡 СРЕДНИЙ  
**Статус:** Не исправлено  

**Описание:**

```javascript
function importPasteInput(textarea) {
  const csv = textarea.value;
  // Парсинг CSV — нет валидации формата
  const rows = csv.split('\n').map(line => line.split(','));
  
  // Нет проверки на:
  // - Правильное количество колонок
  // - Валидность данных в каждом поле
  // - Дубликаты имён
  
  rows.forEach(row => {
    // ...insert in DB
  });
}
```

Нет валидации перед импортом CSV в базу.

**Последствия:**
- Импорт некорректных или поломанных данных
- Дублирование сотрудников
- Нарушение целостности данных
- Непредсказуемое поведение face recognition

**Решение:**
```javascript
function validateEmployeeRow(row) {
  if (!row[0] || !row[0].trim()) return 'Имя обязательно';
  if (isNaN(parseFloat(row[2]))) return 'Ставка должна быть числом';
  if (parseFloat(row[2]) <= 0) return 'Ставка должна быть положительной';
  return null;  // valid
}
```

---

## 📊 Сводная таблица

| № | Баг | Файл | Приоритет | Тип | Статус |
|---|-----|------|-----------|-----|--------|
| 001 | Неправильная очистка photo_url | cleanup_photos.py | 🔴 | Logic | ❌ |
| 002 | Нет обработки исключений при загрузке фото | webhook.js | 🟠 | Error Handling | ❌ |
| 003 | Нет валидации face embedding | process_events.py | 🟠 | Validation | ❌ |
| 004 | Нет timeout для face recognition | process_events.py | 🟠 | Performance | ❌ |
| 005 | Нет безопасного парсинга fraud_flags | index.html | 🟠 | Error Handling | ❌ |
| 006 | Нет проверки localStorage | index.html | 🟠 | Robustness | ❌ |
| 007 | Нет обработки сетевых ошибок | index.html | 🟡 | Error Handling | ❌ |
| 008 | Нет валидации входных данных | index.html | 🟡 | Validation | ❌ |
| 009 | Потенциальная XSS | index.html | 🟡 | Security | ❌ |
| 010 | Нет проверки результата upload | index.html | 🟡 | Error Handling | ❌ |
| 011 | Нет проверки пустого экспорта | index.html | 🟡 | UX | ❌ |
| 012 | Нет валидации CSV импорта | index.html | 🟡 | Validation | ❌ |

---

## 🎯 Рекомендации по приоритизации исправления

1. **Немедленно (сегодня):** BUG-001 (критическая потеря данных)
2. **На этой неделе:** BUG-002, 003, 004, 006 (высокие приоритеты)
3. **На следующей неделе:** BUG-005, 007, 008, 009, 010, 011, 012

---

## ✅ Что работает правильно

- ✅ Основная логика обработки событий
- ✅ Face recognition интеграция
- ✅ Расчёт часов (кроме граничных случаев)
- ✅ Суммирование и агрегация данных
- ✅ Аутентификация (базовая)
- ✅ RLS политики в Supabase
- ✅ Сжатие фото в webhook
- ✅ OCR парсинг текста

---

## 📝 Примечания

- Все ошибки воспроизводимы и имеют четкое описание
- Большинство исправлений требуют 5-15 минут
- Никаких архитектурных изменений не требуется
- Все решения совместимы с текущей версией

---

**Дата создания:** 2026-04-22  
**Создано:** Audit System  
**Версия:** 1.0
