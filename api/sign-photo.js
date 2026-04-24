/**
 * GET /api/sign-photo?path=photos/{chatId}/{messageId}.jpg
 * Генерирует Supabase Storage signed URL через service role key.
 * Требует валидного Bearer-токена пользователя в заголовке Authorization.
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

  const signRes = await fetch(`${SUPABASE_URL}/storage/v1/object/sign/${bucket}/${obj}`, {
    method:  'POST',
    headers: {
      'apikey':        SERVICE_KEY,
      'Authorization': `Bearer ${SERVICE_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ expiresIn: 300 }),
  });

  const data = await signRes.json();
  if (!signRes.ok || !data.signedURL) {
    return res.status(500).json({ error: data.error || 'Failed to create signed URL' });
  }

  res.status(200).json({ signedURL: `${SUPABASE_URL}${data.signedURL}` });
}
