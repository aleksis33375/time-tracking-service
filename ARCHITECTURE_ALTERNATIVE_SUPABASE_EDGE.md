# ⚠️ АЛЬТЕРНАТИВНАЯ АРХИТЕКТУРА — Supabase Edge Functions

**Дата создания:** 2026-04-23  
**Статус:** АРХИВ / АЛЬТЕРНАТИВА НА БУДУЩЕЕ  
**Текущий статус:** Не используется (используется Vercel Webhook)

---

## ПОЯСНЕНИЕ

Этот файл сохраняет информацию о **альтернативной архитектуре** с использованием Supabase Edge Functions вместо Vercel Serverless Functions.

**Почему сохраняется:**
- Может быть полезно при миграции в будущем
- Supabase Edge Functions могут быть дешевле при определённых масштабах
- Может потребоваться при смене провайдера облачных вычислений

---

## ТЕКУЩАЯ АРХИТЕКТУРА (Vercel)

```
Фото в Telegram-группе
    ↓ (sends photo)
Vercel Webhook: POST /api/webhook
    ├─ OCR: parseStampText (дата/время/индекс)
    ├─ OCR: parseCaptionText (имя/тип события)
    ├─ Сжатие фото: Sharp
    ├─ Supabase: INSERT events (status=pending)
    └─ Supabase: INSERT logs
    
GitHub Actions: AI Worker (каждые 5 мин)
    ├─ Fetch pending events
    ├─ Face recognition
    ├─ Расчет часов
    └─ UPDATE events (status=done/needs_review)
    
Dashboard (Vercel static)
    └─ Supabase: GET events, employees, logs
```

**Файлы:** `api/webhook.js`, `package.json` (dependencies: sharp, tesseract.js)

---

## АЛЬТЕРНАТИВНАЯ АРХИТЕКТУРА (Supabase Edge)

Для будущей миграции на Supabase Edge Functions:

```
Фото в Telegram-группе
    ↓ (sends photo)
Supabase Edge Function: /webhook
    ├─ OCR: parseStampText (дата/время/индекс)
    ├─ OCR: parseCaptionText (имя/тип события)
    ├─ Сжатие фото: Sharp (или ImageMagick)
    ├─ Storage: Upload photo
    ├─ Database: INSERT events (status=pending)
    └─ Database: INSERT logs
    
GitHub Actions: AI Worker (каждые 5 мин)
    ├─ Fetch pending events
    ├─ Face recognition
    ├─ Расчет часов
    └─ UPDATE events (status=done/needs_review)
    
Supabase Pages (или Vercel static)
    └─ Supabase: GET events, employees, logs
```

**Файлы:** `supabase/functions/webhook/index.ts`, `deno.json`

---

## СРАВНЕНИЕ

| Параметр | Vercel (текущий) | Supabase Edge (альтернатива) |
|----------|------------------|------------------------------|
| **Язык** | JavaScript (Node.js) | TypeScript (Deno) |
| **Deployment** | Vercel UI + Git | Supabase CLI |
| **Стоимость** | $20-100/мес | $25/мес (фиксированно) |
| **Холодный старт** | ~500ms | ~100ms (дешевле) |
| **Масштабируемость** | Очень хорошая | Хорошая |
| **Интеграция с Supabase** | API calls | Native (быстрее) |
| **Есть ли примеры** | Да (много) | Да (меньше) |

---

## МИГРАЦИЯ НА SUPABASE EDGE (если потребуется)

### Шаг 1: Создать Edge Function

```bash
supabase functions new webhook
```

### Шаг 2: Переписать webhook.js → webhook/index.ts

```typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")

serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 })

  const update = await req.json()
  const msg = update.message || update.channel_post
  
  if (!msg?.photo) return new Response(JSON.stringify({ ok: true }), { status: 200 })

  // OCR, upload, etc.
  
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  await supabase.from("events").insert([...])

  return new Response(JSON.stringify({ ok: true }), { status: 200 })
})
```

### Шаг 3: Deploy

```bash
supabase functions deploy webhook
```

### Шаг 4: Обновить Telegram webhook URL

```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/setWebhook" \
  -d url="https://project-id.supabase.co/functions/v1/webhook"
```

---

## КОГДА ДЕЛАТЬ МИГРАЦИЮ?

**Не нужна сейчас (ненужная преждевременная оптимизация)**

**Рассмотреть в будущем если:**
- Текущие расходы на Vercel > 50$/мес
- Нужна лучшая интеграция между webhook и Supabase
- Холодный старт становится проблемой

**Достаточно время:** 2-3 часа работы

---

## ДОКУМЕНТАЦИЯ

- [Supabase Edge Functions Docs](https://supabase.com/docs/guides/functions)
- [Deno Documentation](https://deno.land/manual@latest)
- [Supabase CLI Reference](https://supabase.com/docs/reference/cli/introduction)

---

**Сохранено как альтернатива на будущее.**  
**Текущий статус:** Не требуется (используется Vercel)
