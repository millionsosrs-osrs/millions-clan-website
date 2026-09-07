/**
 * Millions Boss Hunt — API Worker
 *
 * Public (no auth):
 *   GET  /api/state                 -> { kph, drops, bountyCompletions, bountyReveals }
 *
 * Admin (Authorization: Bearer <ADMIN_PASSWORD>):
 *   POST   /api/admin/drop          { boss, item, team, quantity }
 *   POST   /api/admin/drop/:id/undo
 *   POST   /api/admin/bounty        { bountyNumber, bountyType, team, placement }
 *   POST   /api/admin/bounty/:id/undo
 *   POST   /api/admin/kph           { boss, kph }
 *   POST   /api/admin/bounty-reveal { bountyNumber, bountyType, revealed }
 *   GET    /api/admin/audit-log
 *
 * Everything else falls through to static assets automatically.
 *
 * Binding required (wrangler.toml): D1 database as env.DB
 * Secret required: ADMIN_PASSWORD (wrangler secret put ADMIN_PASSWORD)
 */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authed(request, env) {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const secret = env.ADMIN_PASSWORD;
  if (!secret) return false; // fail closed if the secret was never set
  return safeEqual(token, secret);
}

async function logAudit(env, action, details) {
  await env.DB.prepare(
    'INSERT INTO audit_log (action, details, logged_at) VALUES (?, ?, ?)'
  ).bind(action, details, Date.now()).run();
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // ---------------------------------------------------------- PUBLIC
      if (path === '/api/state' && method === 'GET') {
        const [kphRows, dropRows, bountyRows, revealRows] = await Promise.all([
          env.DB.prepare('SELECT boss_name, actual_kph FROM boss_kph').all(),
          env.DB.prepare('SELECT id, boss_name, item_name, team, quantity, is_collection_log, logged_at FROM drops WHERE undone = 0 ORDER BY logged_at ASC').all(),
          env.DB.prepare('SELECT id, bounty_number, bounty_type, team, placement, logged_at FROM bounty_completions WHERE undone = 0 ORDER BY logged_at ASC').all(),
          env.DB.prepare('SELECT bounty_number, bounty_type, revealed, revealed_at FROM bounty_reveals').all(),
        ]);

        const kph = {};
        for (const r of kphRows.results) kph[r.boss_name] = r.actual_kph;

        return json({
          kph,
          drops: dropRows.results.map(r => ({
            id: r.id, boss: r.boss_name, item: r.item_name,
            team: r.team, quantity: r.quantity, isCollectionLog: !!r.is_collection_log,
            loggedAt: r.logged_at,
          })),
          bountyCompletions: bountyRows.results.map(r => ({
            id: r.id, bountyNumber: r.bounty_number, bountyType: r.bounty_type,
            team: r.team, placement: r.placement, loggedAt: r.logged_at,
          })),
          bountyReveals: revealRows.results.map(r => ({
            bountyNumber: r.bounty_number, bountyType: r.bounty_type,
            revealed: !!r.revealed, revealedAt: r.revealed_at,
          })),
        }, 200);
      }

      // ---------------------------------------------------------- ADMIN
      if (path.startsWith('/api/admin/')) {
        if (!authed(request, env)) return json({ error: 'Unauthorized' }, 401);

        // POST /api/admin/drop
        if (path === '/api/admin/drop' && method === 'POST') {
          const body = await request.json();
          const boss = String(body.boss || '').trim();
          const item = String(body.item || '').trim();
          const team = String(body.team || '').trim();
          const quantity = Number(body.quantity) || 1;
          const isCollectionLog = body.isCollectionLog ? 1 : 0;
          if (!boss || !item || !team) return json({ error: 'boss, item, and team are required' }, 400);
          if (quantity <= 0 || quantity > 100) return json({ error: 'quantity must be between 1 and 100' }, 400);

          const now = Date.now();
          const result = await env.DB.prepare(
            'INSERT INTO drops (boss_name, item_name, team, quantity, is_collection_log, logged_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id'
          ).bind(boss, item, team, quantity, isCollectionLog, now).first();

          await logAudit(env, 'drop_added', `Logged: ${team} +${quantity} ${item} (${boss})`);
          return json({ ok: true, id: result.id }, 201);
        }

        // POST /api/admin/drop/:id/undo
        let m = path.match(/^\/api\/admin\/drop\/(\d+)\/undo$/);
        if (m && method === 'POST') {
          const id = Number(m[1]);
          const row = await env.DB.prepare('SELECT * FROM drops WHERE id = ?').bind(id).first();
          if (!row) return json({ error: 'Not found' }, 404);
          await env.DB.prepare('UPDATE drops SET undone = 1, undone_at = ? WHERE id = ?')
            .bind(Date.now(), id).run();
          await logAudit(env, 'drop_undone', `Undid: ${row.team} +${row.quantity} ${row.item_name} (${row.boss_name})`);
          return json({ ok: true });
        }

        // POST /api/admin/bounty
        if (path === '/api/admin/bounty' && method === 'POST') {
          const body = await request.json();
          const bountyNumber = Number(body.bountyNumber);
          const bountyType = String(body.bountyType || '').trim();
          const team = String(body.team || '').trim();
          const placement = String(body.placement || '').trim();
          if (!bountyNumber || !bountyType || !team || !placement)
            return json({ error: 'bountyNumber, bountyType, team, and placement are required' }, 400);

          const now = Date.now();
          const result = await env.DB.prepare(
            'INSERT INTO bounty_completions (bounty_number, bounty_type, team, placement, logged_at) VALUES (?, ?, ?, ?, ?) RETURNING id'
          ).bind(bountyNumber, bountyType, team, placement, now).first();

          await logAudit(env, 'bounty_marked', `Bounty #${bountyNumber} (${bountyType}): ${team} — ${placement}`);
          return json({ ok: true, id: result.id }, 201);
        }

        // POST /api/admin/bounty/:id/undo
        m = path.match(/^\/api\/admin\/bounty\/(\d+)\/undo$/);
        if (m && method === 'POST') {
          const id = Number(m[1]);
          const row = await env.DB.prepare('SELECT * FROM bounty_completions WHERE id = ?').bind(id).first();
          if (!row) return json({ error: 'Not found' }, 404);
          await env.DB.prepare('UPDATE bounty_completions SET undone = 1, undone_at = ? WHERE id = ?')
            .bind(Date.now(), id).run();
          await logAudit(env, 'bounty_undone', `Undid bounty #${row.bounty_number} (${row.bounty_type}): ${row.team} — ${row.placement}`);
          return json({ ok: true });
        }

        // POST /api/admin/kph
        if (path === '/api/admin/kph' && method === 'POST') {
          const body = await request.json();
          const boss = String(body.boss || '').trim();
          const kph = Number(body.kph);
          if (!boss || !Number.isFinite(kph) || kph <= 0)
            return json({ error: 'boss and a positive kph are required' }, 400);

          await env.DB.prepare(
            'INSERT INTO boss_kph (boss_name, actual_kph) VALUES (?, ?) ON CONFLICT(boss_name) DO UPDATE SET actual_kph = excluded.actual_kph'
          ).bind(boss, kph).run();

          await logAudit(env, 'kph_updated', `KPH for ${boss} set to ${kph}`);
          return json({ ok: true });
        }

        // POST /api/admin/bounty-reveal
        if (path === '/api/admin/bounty-reveal' && method === 'POST') {
          const body = await request.json();
          const bountyNumber = Number(body.bountyNumber);
          const bountyType = String(body.bountyType || '').trim();
          const revealed = !!body.revealed;
          if (!bountyNumber || !bountyType)
            return json({ error: 'bountyNumber and bountyType are required' }, 400);

          await env.DB.prepare(
            `INSERT INTO bounty_reveals (bounty_number, bounty_type, revealed, revealed_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(bounty_number, bounty_type) DO UPDATE SET revealed = excluded.revealed, revealed_at = excluded.revealed_at`
          ).bind(bountyNumber, bountyType, revealed ? 1 : 0, revealed ? Date.now() : null).run();

          await logAudit(env, 'bounty_revealed', `Bounty #${bountyNumber} (${bountyType}) ${revealed ? 'revealed' : 'hidden'}`);
          return json({ ok: true });
        }

        // GET /api/admin/audit-log
        if (path === '/api/admin/audit-log' && method === 'GET') {
          const rows = await env.DB.prepare(
            'SELECT id, action, details, logged_at FROM audit_log ORDER BY logged_at DESC LIMIT 500'
          ).all();
          return json({ entries: rows.results });
        }

        // Probe used by the admin login screen to validate the password
        if (path === '/api/admin/probe' && method === 'POST') {
          return json({ ok: true });
        }

        return json({ error: 'Not found' }, 404);
      }

      // Anything else falls through to static assets
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: 'Server error: ' + err.message }, 500);
    }
  },
};
