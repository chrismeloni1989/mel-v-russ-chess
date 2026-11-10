// HTTP layer for the game. `store` is a Netlify Blobs store (or a test double).
import { newState, whoIs, apply, view, other, GameError } from './logic.mjs';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

const ONLINE_MS = 25000;

export function makeHandler(store) {
  async function load() {
    const r = await store.getWithMetadata('state', { type: 'json' });
    return r ? { state: r.data, etag: r.etag } : { state: null, etag: null };
  }

  async function presence(me, ping) {
    const now = Date.now();
    if (ping) await store.setJSON(`seen-${me}`, { at: now });
    const opp = await store.get(`seen-${other(me)}`, { type: 'json' });
    return { oppSeen: opp ? opp.at : null, oppOnline: !!opp && now - opp.at < ONLINE_MS };
  }

  return async function handler(req) {
    const url = new URL(req.url);
    const site = url.origin;
    try {
      if (req.method === 'GET') {
        const tok = url.searchParams.get('p');
        const { state } = await load();
        if (!state) return json({ needsSetup: true });
        const me = whoIs(state, tok);
        if (!me) return json({ error: 'not-a-player' }, 403);
        const [pres, call] = await Promise.all([
          presence(me, url.searchParams.get('ping') === '1'),
          store.get('call', { type: 'json' }),
        ]);
        const since = Number(url.searchParams.get('v') || 0);
        const base = { now: Date.now(), ...pres, call: call || null };
        if (since === state.v) return json({ ...base, same: true });
        return json({ ...base, state: view(state, me, site) });
      }

      if (req.method === 'POST') {
        const body = await req.json().catch(() => ({}));

        if (body.type === 'setup') {
          const { state } = await load();
          if (state) return json({ error: 'Already set up. Use your private link.' }, 409);
          const s = newState();
          const r = await store.setJSON('state', s, { onlyIfNew: true });
          if (r && r.modified === false) return json({ error: 'Already set up.' }, 409);
          return json({ links: { mel: `${site}/?p=${s.tokens.mel}`, russ: `${site}/?p=${s.tokens.russ}` } });
        }

        // Start over: wipe everything so the site shows the setup screen again.
        if (body.type === 'reset') {
          const { state } = await load();
          if (!state) return json({ ok: true });
          if (!whoIs(state, body.p)) return json({ error: 'not-a-player' }, 403);
          await Promise.all(['state', 'call', 'seen-mel', 'seen-russ'].map((k) => store.delete(k)));
          return json({ ok: true });
        }

        // Camera & voice: pass the two phones' connection details between them.
        if (typeof body.type === 'string' && body.type.startsWith('call-')) {
          const { state } = await load();
          if (!state) return json({ error: 'Game not set up yet.' }, 409);
          const me = whoIs(state, body.p);
          if (!me) return json({ error: 'not-a-player' }, 403);
          const id = String(body.id || '').slice(0, 20);
          const sdp = typeof body.sdp === 'string' ? body.sdp.slice(0, 20000) : '';
          const cur = await store.get('call', { type: 'json' });
          let next = cur;
          if (body.type === 'call-offer' && id && sdp) {
            next = { id, from: me, offer: sdp, answer: null, at: Date.now() };
          } else if (body.type === 'call-answer') {
            if (!cur || cur.id !== id || cur.from === me) return json({ error: 'That call has ended.' }, 409);
            next = { ...cur, answer: sdp, at: Date.now() };
          } else if (body.type === 'call-end') {
            if (cur && cur.id === id) next = null;
          } else {
            return json({ error: 'Unknown action.' }, 400);
          }
          if (next !== cur) {
            if (next) await store.setJSON('call', next); else await store.delete('call');
          }
          return json({ now: Date.now(), call: next || null });
        }

        // Try twice in case both phones write at the same instant.
        for (let attempt = 0; attempt < 2; attempt++) {
          const { state, etag } = await load();
          if (!state) return json({ error: 'Game not set up yet.' }, 409);
          const me = whoIs(state, body.p);
          if (!me) return json({ error: 'not-a-player' }, 403);
          const next = apply(state, me, body);
          const r = await store.setJSON('state', next, { onlyIfMatch: etag });
          if (r && r.modified === false) continue;
          return json({ now: Date.now(), state: view(next, me, site) });
        }
        return json({ error: 'Busy — please try again.' }, 409);
      }
      return json({ error: 'Method not allowed' }, 405);
    } catch (e) {
      if (e instanceof GameError) return json({ error: e.message }, 400);
      console.error(e);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  };
}
