// Vercel serverless function: shared race state stored in Upstash Redis (REST, no dependencies).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const PIN = process.env.REFEREE_PIN || ''; // optional: set in Vercel to protect Start/Reset

async function redis(cmds) {
  const r = await fetch(URL_ + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('Redis error ' + r.status);
  return (await r.json()).map(x => x.result);
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const hash = flat => { const o = []; for (let i = 0; i < (flat || []).length; i += 2) { const v = parse(flat[i + 1]); if (v) o.push({ id: flat[i], ...v }); } return o; };
const clean = s => String(s || '').replace(/[<>]/g, '').slice(0, 14);
const getState = async () => parse((await redis([['GET', 'turbo:state']]))[0]) || { raceId: 'r0', status: 'waiting', goAt: 0 };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Redis not connected. Add Upstash Redis in Vercel Storage and redeploy.' });
  try {
    const now = Date.now();
    if (req.method === 'GET') {
      const state = await getState();
      const [racers, finishes] = await redis([['HGETALL', 'racers:' + state.raceId], ['HGETALL', 'finishes:' + state.raceId]]);
      return res.json({ now, pinRequired: !!PIN, state, racers: hash(racers), finishes: hash(finishes) });
    }
    if (req.method !== 'POST') return res.status(405).end();
    const b = typeof req.body === 'string' ? parse(req.body) || {} : req.body || {};
    const state = await getState();
    const uid = String(b.uid || '').slice(0, 24);

    if (b.action === 'start' || b.action === 'reset') {
      if (PIN && b.pin !== PIN) return res.status(401).json({ error: 'Wrong referee PIN' });
      const next = b.action === 'start'
        ? { ...state, status: 'countdown', goAt: now + 4000 }
        : { raceId: 'r' + now, status: 'waiting', goAt: 0 };
      await redis([['SET', 'turbo:state', JSON.stringify(next), 'EX', 86400]]);
      return res.json({ ok: true, state: next, now });
    }
    if (!uid) return res.status(400).json({ error: 'uid required' });

    if (b.action === 'join' || b.action === 'progress') {
      const key = 'racers:' + state.raceId;
      const rec = { name: clean(b.name), car: String(b.car || '🚗').slice(0, 4), progress: Math.max(0, Math.min(100, +b.progress || 0)) };
      await redis([['HSET', key, uid, JSON.stringify(rec)], ['EXPIRE', key, 86400]]);
      return res.json({ ok: true });
    }
    if (b.action === 'finish') {
      if (state.status !== 'countdown' || now < state.goAt) return res.status(400).json({ error: 'No race running' });
      const key = 'finishes:' + state.raceId;
      const ms = now - state.goAt; // server-side clock = fair timing
      const rec = { uid, name: clean(b.name), ms };
      const [added] = await redis([['HSETNX', key, uid, JSON.stringify(rec)], ['EXPIRE', key, 86400]]);
      return res.json({ ok: true, ms, first: !!added });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
