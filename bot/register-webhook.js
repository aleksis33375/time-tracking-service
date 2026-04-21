/**
 * Регистрация Telegram webhook.
 * Запускать ПОСЛЕ деплоя на Vercel:
 *   node register-webhook.js
 */

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const VERCEL_URL     = process.env.VERCEL_URL; // https://your-project.vercel.app

if (!BOT_TOKEN || !WEBHOOK_SECRET || !VERCEL_URL) {
  console.error('Нужны переменные: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, VERCEL_URL');
  process.exit(1);
}

const webhookUrl = `${VERCEL_URL}/api/webhook`;

async function main() {
  console.log(`Регистрирую webhook: ${webhookUrl}`);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url:             webhookUrl,
      secret_token:    WEBHOOK_SECRET,
      allowed_updates: ['message', 'channel_post'],
    }),
  });

  const data = await res.json();
  console.log('Ответ Telegram:', data);

  if (data.ok) {
    console.log('Webhook успешно зарегистрирован!');
  } else {
    console.error('Ошибка регистрации:', data.description);
    process.exit(1);
  }

  // Проверка
  const infoRes  = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`);
  const infoData = await infoRes.json();
  console.log('\nТекущий webhook:', infoData.result);
}

main().catch(console.error);
