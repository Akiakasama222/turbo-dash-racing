// Vercel serverless function: private rooms, race state stored in Upstash Redis (REST, no dependencies).
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const ROOM_RE = /^[A-Z0-9]{4,6}$/, ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', DAY = 86400;

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
const K = (room, s) => `t:${room}:${s}`;           // every key belongs to one room
const newState = () => ({ raceId: 'r0', status: 'waiting', goAt: 0, seed: 1 + Math.floor(Math.random() * 2147483000) });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!URL_ || !TOKEN) return res.status(500).json({ error: 'Redis not connected. Add Upstash Redis in Vercel Storage and redeploy.' });
  try {
    const now = Date.now();
    const b = req.method === 'POST' ? (typeof req.body === 'string' ? parse(req.body) || {} : req.body || {}) : {};

    if (b.action === 'create') {                    // make a new private room; the creator is its referee
      const pin = String(b.pin || '').slice(0, 8);
      for (let i = 0; i < 6; i++) {
        const code = Array.from({ length: 4 }, () => ALPHA[Math.floor(Math.random() * ALPHA.length)]).join('');
        const [ok] = await redis([['SET', K(code, 'state'), JSON.stringify(newState()), 'EX', DAY, 'NX']]);
        if (ok) { if (pin) await redis([['SET', K(code, 'pin'), pin, 'EX', DAY]]); return res.json({ ok: true, room: code, pinRequired: !!pin }); }
      }
      return res.status(503).json({ error: 'Could not create a room, please try again' });
    }

    const room = String((req.method === 'GET' ? req.query.room : b.room) || '').toUpperCase();
    if (!ROOM_RE.test(room)) return res.status(400).json({ error: 'Bad room code' });
    const [stRaw, pin] = await redis([['GET', K(room, 'state')], ['GET', K(room, 'pin')]]);
    const state = parse(stRaw);
    if (!state) return res.status(404).json({ error: 'Room not found' });
    const alive = () => { const c = [['EXPIRE', K(room, 'state'), DAY]]; if (pin) c.push(['EXPIRE', K(room, 'pin'), DAY]); return c; };

    if (req.method === 'GET') {
      const id = state.raceId;
      const [racers, finishes, fx] = await redis([['HGETALL', K(room, 'racers:' + id)], ['HGETALL', K(room, 'finishes:' + id)], ['HGETALL', K(room, 'fx:' + id)]]);
      return res.json({ now, pinRequired: !!pin, state, racers: hash(racers), finishes: hash(finishes), fx: hash(fx) });
    }
    if (req.method !== 'POST') return res.status(405).end();
    const uid = String(b.uid || '').slice(0, 24);

    if (b.action === 'auth') {
      if (pin && b.pin !== pin) return res.status(401).json({ error: 'Wrong referee PIN' });
      return res.json({ ok: true });
    }
    if (b.action === 'start' || b.action === 'reset') {
      if (pin && b.pin !== pin) return res.status(401).json({ error: 'Wrong referee PIN' });
      const next = b.action === 'start'
        ? { ...state, status: 'countdown', goAt: now + 4000 }
        : { raceId: 'r' + now, status: 'waiting', goAt: 0, seed: 1 + Math.floor(Math.random() * 2147483000) }; // new random track
      await redis([['SET', K(room, 'state'), JSON.stringify(next), 'EX', DAY], ...(pin ? [['EXPIRE', K(room, 'pin'), DAY]] : [])]);
      return res.json({ ok: true, state: next, now });
    }
    if (!uid) return res.status(400).json({ error: 'uid required' });

    if (b.action === 'join' || b.action === 'progress') {
      const key = K(room, 'racers:' + state.raceId);
      const rec = { name: clean(b.name), car: String(b.car || 'c1').slice(0, 4), progress: Math.max(0, Math.min(100, +b.progress || 0)), x: Math.round(+b.x || 0), y: Math.round(+b.y || 0), h: +(+b.h || 0).toFixed(2), t: now };
      await redis([['HSET', key, uid, JSON.stringify(rec)], ['EXPIRE', key, DAY], ...(b.action === 'join' ? alive() : [])]);
      return res.json({ ok: true });
    }
    if (b.action === 'power') {
      // Attack power-ups: stun (1 random), universal (everyone else), reverse (1 random), block (1 random)
      const DUR = { stun: 2500, universal: 2000, reverse: 2500, block: 3000 };
      const kind = b.kind;
      if (!DUR[kind]) return res.status(400).json({ error: 'Unknown power' });
      if (state.status !== 'countdown' || now < state.goAt) return res.json({ ok: true, hits: [] });
      const id = state.raceId, fk = K(room, 'fx:' + id), eff = kind === 'universal' ? 'stun' : kind;
      const [rs, fs, xs] = await redis([['HGETALL', K(room, 'racers:' + id)], ['HGETALL', K(room, 'finishes:' + id)], ['HGETALL', fk]]);
      const done = new Set(hash(fs).map(f => f.id));
      const busy = new Set(hash(xs).filter(x => x.until > now).map(x => x.id));
      let targets = hash(rs).filter(r => r.id !== uid && !done.has(r.id) && r.t > now - 6000 && (r.progress || 0) < 100);
      if (kind !== 'universal') {
        targets = targets.filter(r => !busy.has(r.id + '|' + eff));
        if (targets.length) targets = [targets[Math.floor(Math.random() * targets.length)]];
      }
      if (!targets.length) return res.json({ ok: true, hits: [] });
      const cmds = targets.map(v => ['HSET', fk, v.id + '|' + eff, JSON.stringify({ until: now + DUR[kind], by: clean(b.name), kind: eff })]);
      cmds.push(['EXPIRE', fk, DAY]);
      await redis(cmds);
      return res.json({ ok: true, hits: targets.map(v => ({ id: v.id, name: v.name })) });
    }
    if (b.action === 'finish') {
      if (state.status !== 'countdown' || now < state.goAt) return res.status(400).json({ error: 'No race running' });
      const key = K(room, 'finishes:' + state.raceId);
      const ms = now - state.goAt; // server-side clock = fair timing
      const rec = { uid, name: clean(b.name), ms };
      const [added] = await redis([['HSETNX', key, uid, JSON.stringify(rec)], ['EXPIRE', key, DAY]]);
      return res.json({ ok: true, ms, first: !!added });
    }
    res.status(400).json({ error: 'Unknown action' });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
