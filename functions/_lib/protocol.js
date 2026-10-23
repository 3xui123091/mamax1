// پارس پروتکل VLESS (بدون وابستگی به Cloudflare تا قابل تست باشد)
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const td = new TextDecoder();

export function bytesToUuid(b) {
  const h = (i) => HEX[b[i]];
  return `${h(0)}${h(1)}${h(2)}${h(3)}-${h(4)}${h(5)}-${h(6)}${h(7)}-${h(8)}${h(9)}-${h(10)}${h(11)}${h(12)}${h(13)}${h(14)}${h(15)}`;
}

export function parseVlessHeader(buf) {
  const len = buf.byteLength;
  if (len < 24) return { error: 'short' };
  const version = buf[0];
  const uuid = bytesToUuid(buf.subarray(1, 17));
  let p = 18 + buf[17];
  if (len < p + 4) return { error: 'short' };
  const cmd = buf[p++];
  const port = (buf[p] << 8) | buf[p + 1];
  p += 2;
  const atype = buf[p++];
  let host;
  if (atype === 1) {
    if (len < p + 4) return { error: 'short' };
    host = `${buf[p]}.${buf[p + 1]}.${buf[p + 2]}.${buf[p + 3]}`;
    p += 4;
  } else if (atype === 2) {
    const l = buf[p++];
    if (!l || len < p + l) return { error: 'short' };
    host = td.decode(buf.subarray(p, p + l));
    p += l;
  } else if (atype === 3) {
    if (len < p + 16) return { error: 'short' };
    const dv = new DataView(buf.buffer, buf.byteOffset + p, 16);
    const parts = [];
    for (let i = 0; i < 8; i++) parts.push(dv.getUint16(i * 2).toString(16));
    host = parts.join(':');
    p += 16;
  } else {
    return { error: 'atype' };
  }
  return { version, uuid, cmd, port, host, offset: p };
}

export function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// فریم‌های UDP در VLESS: [طول ۲ بایتی][داده]
export function splitUdp(buf) {
  const frames = [];
  let p = 0;
  while (buf.length - p >= 2) {
    const l = (buf[p] << 8) | buf[p + 1];
    if (buf.length - p - 2 < l) break;
    frames.push(buf.subarray(p + 2, p + 2 + l));
    p += 2 + l;
  }
  return { frames, rest: buf.subarray(p) };
}
export function frameUdp(payload) {
  const out = new Uint8Array(2 + payload.length);
  out[0] = payload.length >> 8;
  out[1] = payload.length & 255;
  out.set(payload, 2);
  return out;
}

// Early Data (0-RTT) که از هدر Sec-WebSocket-Protocol می‌آید
export function decodeEarlyData(value) {
  if (!value) return null;
  try {
    const s = value.split(',')[0].trim().replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length ? out : null;
  } catch {
    return null;
  }
}
