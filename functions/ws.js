import { ensureInit } from './_lib/db.js';
import { userStatus } from './_lib/model.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bytesToUuid(bytes) {
  const h = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

function reject(message, status = 400) {
  return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

// Controlled VLESS/WS handshake validator for the university demo.
// This endpoint deliberately does NOT create an arbitrary TCP/Internet relay.
export async function onRequest(ctx) {
  const { request, env } = ctx;

  if (request.method !== 'GET') return reject('Method not allowed', 405);
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response(JSON.stringify({
      ok: true,
      service: 'MAMAX VLESS demo endpoint',
      websocket: '/ws',
      relay: false
    }), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  server.addEventListener('message', async (event) => {
    try {
      const data = event.data;
      if (!(data instanceof ArrayBuffer)) {
        server.close(1003, 'binary VLESS data required');
        return;
      }

      const b = new Uint8Array(data);
      if (b.length < 18 || b[0] !== 1) {
        server.close(1002, 'invalid VLESS request');
        return;
      }

      const uuid = bytesToUuid(b.slice(1, 17));
      if (!UUID_RE.test(uuid)) {
        server.close(1008, 'invalid UUID');
        return;
      }

      await ensureInit(env);
      const user = await env.DB.prepare(
        'SELECT id, uuid, enabled, expire_at, traffic_limit, up_bytes, down_bytes FROM users WHERE lower(uuid) = lower(?) LIMIT 1'
      ).bind(uuid).first();

      if (!user || userStatus(user) !== 'active') {
        server.close(1008, 'user not active');
        return;
      }

      // Return the VLESS response header, then close deliberately.
      // A real data-plane relay is intentionally not implemented here.
      server.send(new Uint8Array([1, 0, 0]));
      server.close(1000, 'demo handshake accepted');
    } catch (err) {
      console.error('VLESS demo handshake error', err);
      try { server.close(1011, 'internal error'); } catch {}
    }
  });

  server.addEventListener('error', (event) => {
    console.error('VLESS demo websocket error', event);
  });

  return new Response(null, {
    status: 101,
    webSocket: client
  });
}
