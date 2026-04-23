# Deployment Status — AI Attendance System

**Date:** 2026-04-22  
**Status:** ✅ Ready for Vercel deployment

## What's Been Configured

### ✅ Vercel Configuration
- [x] `vercel.json` — Project config, rewrites, headers
- [x] `.vercelignore` — Excludes unnecessary files (tests, docs, AI Worker)
- [x] `bot/package.json` — Build script added
- [x] API webhook — Configured for `POST /api/webhook`
- [x] Dashboard SPA — Rewrites root to index.html

### ✅ Environment Setup
- [x] Required env vars documented (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN, etc.)
- [x] GitHub Secrets template provided
- [x] Vercel Secrets guide created

### ✅ Documentation
- [x] `DEPLOYMENT.md` — Step-by-step deployment guide (30 min)
  - Part 1: Vercel Dashboard + Bot deployment
  - Part 2: GitHub Actions setup
  - Part 3: End-to-end testing on production
  - Part 4: Production configuration & monitoring
  - Troubleshooting section
- [x] Webhook registration instructions
- [x] Monitoring & backup setup guide

### ✅ GitHub Actions
- [x] `ai-worker/process_events.py` — Scheduled workflow (cron: 5-10 min)
- [x] `ai-worker/cleanup_photos.py` — Scheduled workflow (cron: daily)
- [x] `ai-worker/compute_embeddings.py` — On-demand for face embedding
- [x] All workflows in `.github/workflows/*.yml`

### ✅ Dashboard
- [x] Single-page application (index.html) — ready for static hosting
- [x] 7 pages fully functional: Обзор, Посещаемость, Проверка, Табель, Аналитика, Логи, Сотрудники
- [x] All Supabase integrations working
- [x] Export (Excel, PDF) functional

### ✅ Bot
- [x] Webhook handler — `api/webhook.js`
- [x] OCR parsing (stamp & caption) — tested & verified
- [x] Photo upload to Supabase Storage
- [x] Event creation with parsed data

---

## Next Steps (Manual)

1. **Create Vercel Account**
   - Go to https://vercel.com/new
   - Sign in with GitHub
   - Import `time-tracking-service` repo

2. **Add Environment Variables in Vercel UI**
   ```
   SUPABASE_URL = https://xxx.supabase.co
   SUPABASE_SERVICE_ROLE_KEY = eyJhbGc...
   TELEGRAM_BOT_TOKEN = 123456:ABCdef...
   TELEGRAM_WEBHOOK_SECRET = your-secret
   OBJECT_POSTCODE = 108818
   ```

3. **Register Telegram Webhook**
   ```bash
   node bot/register-webhook.js
   # Or manually via curl (see DEPLOYMENT.md)
   ```

4. **Add GitHub Secrets**
   - Settings → Secrets → Actions
   - Add same env vars as above

5. **Test End-to-End**
   - Send test photo via Telegram
   - Run "Process Events" workflow manually
   - Check Dashboard for results

6. **Enable Scheduled Workflows**
   - Actions → "Process Events" → Enable
   - Actions → "Delete Photos" → Enable
   - (Already scheduled in `.github/workflows/*.yml`)

---

## Deployment URLs (After Vercel Deploy)

Once deployed to Vercel:

```
Dashboard:     https://time-tracking-service.vercel.app/
Webhook:       https://time-tracking-service.vercel.app/api/webhook
```

Or with custom domain:
```
Dashboard:     https://yourdomain.com/
Webhook:       https://yourdomain.com/api/webhook
```

---

## Architecture Diagram

```
Telegram User
    ↓ (sends photo)
Telegram API
    ↓ 
Vercel: POST /api/webhook
    ├─ OCR: parseStampText (date/time/postcode)
    ├─ OCR: parseCaptionText (name/event_type)
    ├─ Supabase: INSERT events (status=pending)
    └─ Supabase: INSERT logs
    
Scheduled: every 5-10 min
    ↓
GitHub Actions: process_events.py
    ├─ Fetch pending events
    ├─ Find employee (fuzzy match)
    ├─ Verify face (if embedding exists)
    ├─ Calculate hours
    ├─ UPDATE events (status=done or needs_review)
    └─ Supabase: INSERT logs, notify Telegram manager

Manager/Admin
    ↓ (accesses)
Vercel: GET /
    └─ Dashboard (static SPA)
       ├─ Supabase Auth (login)
       ├─ Read events/employees (REST API)
       ├─ Can edit events via "Проверка" page
       └─ PDF/Excel export

Scheduled: once daily
    ↓
GitHub Actions: cleanup_photos.py
    └─ Delete photos older than 60 days from Storage
```

---

## Files Modified/Created for Deployment

```
Root:
├── vercel.json                  ← Project config
├── .vercelignore               ← Ignore patterns
├── DEPLOYMENT.md               ← Deployment guide
├── DEPLOYMENT_STATUS.md        ← This file
│
bot/:
├── package.json                ← Updated with build script
├── vercel.json                 ← Existing config
├── api/webhook.js              ← Existing webhook handler
│
dashboard/:
├── index.html                  ← Existing SPA
│
.github/workflows/:
├── process_events.yml          ← Existing scheduled workflow
├── delete_photos.yml           ← Existing scheduled workflow
└── compute_embeddings.yml      ← Existing on-demand workflow
```

---

## Estimated Timeline

| Phase | Duration | Status |
|-------|----------|--------|
| Create Vercel account | 2 min | Manual |
| Deploy via Vercel UI | 5 min | Automatic |
| Add environment variables | 5 min | Manual |
| Register Telegram webhook | 2 min | Manual |
| Add GitHub Secrets | 3 min | Manual |
| Enable workflows | 2 min | Manual |
| Test E2E cycle | 10 min | Manual |
| **Total** | **~30 min** | ✅ Ready |

---

## Support Resources

- **Vercel Docs**: https://vercel.com/docs
- **GitHub Actions**: https://docs.github.com/actions
- **Supabase**: https://supabase.com/docs
- **Telegram Bot API**: https://core.telegram.org/bots/api
- **Project Issues**: https://github.com/aleksis33375/time-tracking-service/issues

---

**Last updated:** 2026-04-22  
**Configuration version:** 1.0  
**Ready for production deployment:** ✅ YES
