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
 *   POST   /api/admin/prize-pool    { amount }
 *   POST   /api/admin/manual-adjustment { boss, item, adjustment }
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
        const [kphRows, dropRows, bountyRows, revealRows, settingsRows, adjustRows] = await Promise.all([
          env.DB.prepare('SELECT boss_name, actual_kph FROM boss_kph').all(),
          env.DB.prepare('SELECT id, boss_name, item_name, team, rsn, quantity, is_collection_log, logged_at FROM drops WHERE undone = 0 ORDER BY logged_at ASC').all(),
          env.DB.prepare('SELECT id, bounty_number, bounty_type, team, placement, logged_at FROM bounty_completions WHERE undone = 0 ORDER BY logged_at ASC').all(),
          env.DB.prepare('SELECT bounty_number, bounty_type, revealed, revealed_at FROM bounty_reveals').all(),
          env.DB.prepare('SELECT key, value FROM event_settings').all(),
          env.DB.prepare('SELECT boss_name, item_name, adjustment FROM item_manual_adjustments').all(),
        ]);

        const kph = {};
        for (const r of kphRows.results) kph[r.boss_name] = r.actual_kph;
        const settings = {};
        for (const r of settingsRows.results) settings[r.key] = r.value;
        const manualAdjustments = {};
        for (const r of adjustRows.results) manualAdjustments[r.boss_name + '||' + r.item_name] = r.adjustment;

        return json({
          kph,
          prizePool: Number(settings.prizePool || 0),
          manualAdjustments,
          drops: dropRows.results.map(r => ({
            id: r.id, boss: r.boss_name, item: r.item_name,
            team: r.team, rsn: r.rsn, quantity: r.quantity, isCollectionLog: !!r.is_collection_log,
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

      // ------------------------------------------------- PUBLIC SUBMISSION
      // Anyone can submit a drop with evidence — no password needed, since
      // nothing here touches the live scoreboard until an admin approves it.
      if (path === '/api/submit-drop' && method === 'POST') {
        const form = await request.formData();
        const boss = String(form.get('boss') || '').trim();
        const item = String(form.get('item') || '').trim();
        const team = String(form.get('team') || '').trim();
        const rsn = String(form.get('rsn') || '').trim().slice(0, 32) || null;
        const quantity = Number(form.get('quantity')) || 1;
        const isCollectionLog = form.get('isCollectionLog') === 'true' ? 1 : 0;
        const image = form.get('image');

        if (!boss || !item || !team) return json({ error: 'boss, item, and team are required' }, 400);
        if (!rsn) return json({ error: 'RSN is required' }, 400);
        if (quantity <= 0 || quantity > 100) return json({ error: 'quantity must be between 1 and 100' }, 400);
        if (!image || typeof image === 'string') return json({ error: 'An evidence screenshot is required' }, 400);
        if (image.size > 8 * 1024 * 1024) return json({ error: 'Image must be under 8MB' }, 400);
        if (!image.type || !image.type.startsWith('image/')) return json({ error: 'File must be an image' }, 400);

        const now = Date.now();
        const ext = (image.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
        const imageKey = `submissions/${now}-${crypto.randomUUID()}.${ext}`;
        await env.SUBMISSIONS_BUCKET.put(imageKey, image.stream(), {
          httpMetadata: { contentType: image.type },
        });

        const result = await env.DB.prepare(
          `INSERT INTO pending_submissions (boss_name, item_name, team, rsn, quantity, is_collection_log, image_key, status, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?) RETURNING id`
        ).bind(boss, item, team, rsn, quantity, isCollectionLog, imageKey, now).first();

        return json({ ok: true, id: result.id }, 201);
      }

      // Serves an evidence image out of R2. Public so both the review page
      // and (once approved) anyone checking history can view it.
      let imgMatch = path.match(/^\/api\/submission-image\/(.+)$/);
      if (imgMatch && method === 'GET') {
        const obj = await env.SUBMISSIONS_BUCKET.get(decodeURIComponent(imgMatch[1]));
        if (!obj) return new Response('Not found', { status: 404 });
        return new Response(obj.body, {
          headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/png', 'Cache-Control': 'public, max-age=31536000' },
        });
      }

      // Wiki image cache/proxy. Fetches the real OSRS Wiki image the FIRST
      // time any visitor requests it, stores a permanent copy in R2, and
      // serves every request after that straight from R2 — so the wiki only
      // ever sees one request per unique image, total, ever, instead of one
      // per pageview.
      if (path === '/api/img' && method === 'GET') {
        const src = url.searchParams.get('src');
        if (!src) return new Response('Missing src', { status: 400 });
        if (!src.startsWith('https://oldschool.runescape.wiki/')) return new Response('Invalid src', { status: 400 });

        const cacheKey = 'wiki-cache/' + src.replace('https://oldschool.runescape.wiki/images/', '');

        let obj = await env.SUBMISSIONS_BUCKET.get(cacheKey);
        if (!obj) {
          const wikiResp = await fetch(src, { headers: { 'User-Agent': 'MillionsClanBossHunt/1.0' } });
          if (!wikiResp.ok) return new Response('Not found', { status: 404 });
          const contentType = wikiResp.headers.get('Content-Type') || 'image/png';
          const bytes = await wikiResp.arrayBuffer();
          await env.SUBMISSIONS_BUCKET.put(cacheKey, bytes, { httpMetadata: { contentType } });
          return new Response(bytes, {
            headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=31536000, immutable' },
          });
        }
        return new Response(obj.body, {
          headers: { 'Content-Type': obj.httpMetadata?.contentType || 'image/png', 'Cache-Control': 'public, max-age=31536000, immutable' },
        });
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
          const rsn = String(body.rsn || '').trim().slice(0, 32) || null;
          const quantity = Number(body.quantity) || 1;
          const isCollectionLog = body.isCollectionLog ? 1 : 0;
          if (!boss || !item || !team) return json({ error: 'boss, item, and team are required' }, 400);
          if (quantity <= 0 || quantity > 100) return json({ error: 'quantity must be between 1 and 100' }, 400);

          const now = Date.now();
          const result = await env.DB.prepare(
            'INSERT INTO drops (boss_name, item_name, team, rsn, quantity, is_collection_log, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id'
          ).bind(boss, item, team, rsn, quantity, isCollectionLog, now).first();

          await logAudit(env, 'drop_added', `Logged: ${rsn ? rsn + ' (' + team + ')' : team} — ${item} (${boss})`);
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
          await logAudit(env, 'drop_undone', `Undid: ${row.team} — ${row.item_name} (${row.boss_name})`);
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

        // POST /api/admin/prize-pool
        if (path === '/api/admin/prize-pool' && method === 'POST') {
          const body = await request.json();
          const amount = Number(body.amount);
          if (!Number.isFinite(amount) || amount < 0)
            return json({ error: 'amount must be a non-negative number' }, 400);

          await env.DB.prepare(
            `INSERT INTO event_settings (key, value) VALUES ('prizePool', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          ).bind(String(Math.round(amount))).run();

          await logAudit(env, 'prize_pool_updated', `Prize pool set to ${Math.round(amount).toLocaleString()} GP`);
          return json({ ok: true });
        }

        // POST /api/admin/manual-adjustment
        if (path === '/api/admin/manual-adjustment' && method === 'POST') {
          const body = await request.json();
          const boss = String(body.boss || '').trim();
          const item = String(body.item || '').trim();
          const adjustment = Number(body.adjustment);
          if (!boss || !item) return json({ error: 'boss and item are required' }, 400);
          if (!Number.isFinite(adjustment) || adjustment < 0 || adjustment > 10)
            return json({ error: 'adjustment must be a number between 0 and 10' }, 400);

          await env.DB.prepare(
            `INSERT INTO item_manual_adjustments (boss_name, item_name, adjustment) VALUES (?, ?, ?)
             ON CONFLICT(boss_name, item_name) DO UPDATE SET adjustment = excluded.adjustment`
          ).bind(boss, item, adjustment).run();

          await logAudit(env, 'manual_adjustment_updated', `Manual adjustment for ${item} (${boss}) set to ${adjustment}`);
          return json({ ok: true });
        }

        // GET /api/admin/audit-log
        if (path === '/api/admin/audit-log' && method === 'GET') {
          const rows = await env.DB.prepare(
            'SELECT id, action, details, logged_at FROM audit_log ORDER BY logged_at DESC LIMIT 500'
          ).all();
          return json({ entries: rows.results });
        }

        // GET /api/admin/pending-submissions
        if (path === '/api/admin/pending-submissions' && method === 'GET') {
          const rows = await env.DB.prepare(
            `SELECT id, boss_name, item_name, team, rsn, quantity, is_collection_log, image_key, status, submitted_at
             FROM pending_submissions WHERE status = 'pending' ORDER BY submitted_at ASC`
          ).all();
          return json({
            submissions: rows.results.map(r => ({
              id: r.id, boss: r.boss_name, item: r.item_name, team: r.team, rsn: r.rsn,
              quantity: r.quantity, isCollectionLog: !!r.is_collection_log,
              imageUrl: '/api/submission-image/' + encodeURIComponent(r.image_key),
              submittedAt: r.submitted_at,
            })),
          });
        }

        // POST /api/admin/pending-submissions/:id/approve
        let approveMatch = path.match(/^\/api\/admin\/pending-submissions\/(\d+)\/approve$/);
        if (approveMatch && method === 'POST') {
          const id = Number(approveMatch[1]);
          const sub = await env.DB.prepare('SELECT * FROM pending_submissions WHERE id = ?').bind(id).first();
          if (!sub) return json({ error: 'Not found' }, 404);
          if (sub.status !== 'pending') return json({ error: 'Already reviewed' }, 400);

          const now = Date.now();
          await env.DB.prepare(
            'INSERT INTO drops (boss_name, item_name, team, rsn, quantity, is_collection_log, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).bind(sub.boss_name, sub.item_name, sub.team, sub.rsn, sub.quantity, sub.is_collection_log, now).run();
          await env.DB.prepare(
            `UPDATE pending_submissions SET status = 'approved', reviewed_at = ? WHERE id = ?`
          ).bind(now, id).run();

          await logAudit(env, 'submission_approved', `Approved: ${sub.rsn || sub.team} — ${sub.item_name} (${sub.boss_name})`);
          return json({ ok: true });
        }

        // POST /api/admin/pending-submissions/:id/reject
        let rejectMatch = path.match(/^\/api\/admin\/pending-submissions\/(\d+)\/reject$/);
        if (rejectMatch && method === 'POST') {
          const id = Number(rejectMatch[1]);
          const sub = await env.DB.prepare('SELECT * FROM pending_submissions WHERE id = ?').bind(id).first();
          if (!sub) return json({ error: 'Not found' }, 404);
          if (sub.status !== 'pending') return json({ error: 'Already reviewed' }, 400);

          await env.DB.prepare(
            `UPDATE pending_submissions SET status = 'rejected', reviewed_at = ? WHERE id = ?`
          ).bind(Date.now(), id).run();

          await logAudit(env, 'submission_rejected', `Rejected: ${sub.rsn || sub.team} — ${sub.item_name} (${sub.boss_name})`);
          return json({ ok: true });
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
