import { ensureInit } from '../_lib/db.js';
import { startSession } from '../_lib/proxy.js';
import { errorPage, htmlResponse } from '../_lib/util.js';

export async function onRequest(ctx) {
  const { request, env } = ctx;
  if ((request.headers.get('upgrade') || '').toLowerCase() !== 'websocket') {
    return htmlResponse(errorPage(404), 404);
  }
  try {
    await ensureInit(env);
  } catch (e) {
    console.error(e);
    return new Response('Service unavailable', { status: 503 });
  }
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  startSession(server, request, ctx);
  const proto = request.headers.get('sec-websocket-protocol');
  return new Response(null, { status: 101, webSocket: client, headers: proto ? { 'sec-websocket-protocol': proto.split(',')[0].trim() } : {} });
}
