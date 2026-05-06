-- Migration: add aliases column to employees
-- Run once in Supabase SQL Editor

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS aliases text[] DEFAULT '{}';

-- After running this migration, go to Dashboard → Сотрудники →
-- find «Петрукович Александр» (or rename «Саша» first) →
-- Редактировать → Никнеймы → add «Саша»
