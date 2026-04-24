/**
 * GET /api/sign-photo?path=photos/{chatId}/{messageId}.jpg
 * Прокси для файлов Supabase Storage.
 * Валидирует Bearer-токен пользователя, затем скачивает файл через service role key
 * и отдаёт байты напрямую — без signed URL (они нестабильны с некоторыми путями).
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end();

  const authHeader = req.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Проверяем что токен пользователя валиден
  const userToken = authHeader.slice(7);
  const authCheck = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${userToken}`,
    },
  });
  if (!authCheck.ok) return res.status(401).json({ error: 'Invalid token' });

  const { path } = req.query;
  if (!path) return res.status(400).json({ error: 'Missing path' });

  const slash = path.indexOf('/');
  if (slash === -1) return res.status(400).json({ error: 'Invalid path format' });

  const bucket = path.slice(0, slash);
  const obj    = path.slice(slash + 1);

  // Скачиваем файл напрямую через service role key
  const fileRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${obj}`, {
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
    },
  });

  if (!fileRes.ok) {
    return res.status(fileRes.status).json({ error: 'File not found' });
  }

  const contentType = fileRes.headers.get('content-type') || 'image/jpeg';
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.status(200).end(buffer);
}
