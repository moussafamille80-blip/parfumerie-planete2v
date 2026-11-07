// Fonction Vercel : lit et enregistre les données de Planète 2 dans Upstash Redis (créé depuis Vercel).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PASS = process.env.APP_PASSWORD;
const KEY = 'planete2:db';
const BK = 'planete2:bk:';           // sauvegardes datées : planete2:bk:AAAA-MM-JJ
const TTL = 60 * 60 * 24 * 90;       // conservées 90 jours
const EMPTY = { rev: 0, db: { products: [], moves: [] } };
const idOk = id => /^(\d{4}-\d{2}-\d{2}|avant-restauration)$/.test(String(id));
const day = () => new Date().toISOString().slice(0, 10);

async function redis(cmd) {
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || 'redis');
  return j.result;
}
const current = async () => { const raw = await redis(['GET', KEY]); return raw ? JSON.parse(raw) : EMPTY; };
const persist = async state => { // état courant + sauvegarde du jour (dernier état de la journée)
  const txt = JSON.stringify(state);
  await redis(['SET', KEY, txt]);
  await redis(['SET', BK + day(), txt, 'EX', TTL]);
};
const valid = d => d && Array.isArray(d.products) && Array.isArray(d.moves);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(503).json({ error: 'storage' });
  if (!PASS) return res.status(503).json({ error: 'password' });
  if (req.headers['x-app-password'] !== PASS) return res.status(401).json({ error: 'auth' });
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      if (q.backups !== undefined) {
        const keys = (await redis(['KEYS', BK + '*'])) || [];
        return res.status(200).json({ backups: keys.map(k => k.slice(BK.length)).filter(idOk).sort().reverse() });
      }
      if (q.backup !== undefined) {
        if (!idOk(q.backup)) return res.status(400).json({ error: 'id' });
        const raw = await redis(['GET', BK + q.backup]);
        return raw ? res.status(200).json(JSON.parse(raw)) : res.status(404).json({ error: 'absent' });
      }
      return res.status(200).json(await current());
    }
    const b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    if (req.method === 'PUT') {
      if (!valid(b.db)) return res.status(400).json({ error: 'format' });
      const cur = await current();
      if (b.rev !== cur.rev) return res.status(409).json(cur); // quelqu'un d'autre a modifié entre-temps
      const next = { rev: cur.rev + 1, db: { products: b.db.products, moves: b.db.moves, sales: Array.isArray(b.db.sales) ? b.db.sales : [], cash: Array.isArray(b.db.cash) ? b.db.cash : [], orders: Array.isArray(b.db.orders) ? b.db.orders : [], cap: Array.isArray(b.db.cap) ? b.db.cap : [] } };
      await persist(next);
      return res.status(200).json({ rev: next.rev });
    }
    if (req.method === 'POST' && b.restore) { // retour à une sauvegarde datée
      if (!idOk(b.restore)) return res.status(400).json({ error: 'id' });
      const cur = await current();
      if (b.rev !== cur.rev) return res.status(409).json(cur);
      const raw = await redis(['GET', BK + b.restore]);
      if (!raw) return res.status(404).json({ error: 'absent' });
      const snap = JSON.parse(raw);
      if (!valid(snap.db)) return res.status(500).json({ error: 'format' });
      await redis(['SET', BK + 'avant-restauration', JSON.stringify(cur), 'EX', TTL]); // filet de sécurité
      const next = { rev: cur.rev + 1, db: snap.db };
      await persist(next);
      return res.status(200).json(next);
    }
    return res.status(405).json({ error: 'method' });
  } catch (e) { return res.status(500).json({ error: 'server', detail: String(e.message).slice(0, 80) }); }
};
