'use strict';
// Filedrop relay — a tiny rendezvous + relay server.
//
// How it makes "just works over the internet" possible:
//  - Every device opens ONE outbound WebSocket to this server (works through any
//    home router / phone carrier NAT, no port-forwarding, no VPN).
//  - On connect it REGISTERS its unique code (e.g. "K7PX-9M2Q").
//  - To reach a friend you send messages addressed to THEIR code; the server
//    looks up that code's live socket and forwards the message.
//
// The payload is opaque to the server — it carries the app's own messages
// (chat, call signaling, file metadata), so the same app protocol rides over
// the relay when peers aren't on the same LAN.

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;

/** code (UPPERCASE) -> { ws, deviceId, name, fingerprint } */
const peers = new Map();

function norm(code) {
  // forgiving: case-insensitive, ignore dashes/spaces/punctuation so a user can
  // type "k7px-9m2q", "K7PX 9M2Q" or "K7PX9M2Q" and they all match.
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

const server = http.createServer((req, res) => {
  // health check for the host + a friendly landing page
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, online: peers.size }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end(`filedrop-relay ok — ${peers.size} device(s) online`);
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 * 1024 });

wss.on('connection', (ws) => {
  let myCode = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return; // control channel is JSON only (file bytes go elsewhere)
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'register': {
        const code = norm(msg.code);
        const deviceId = String(msg.deviceId || '');
        if (!code || !deviceId) { send(ws, { type: 'error', error: 'bad-register' }); return; }
        const existing = peers.get(code);
        // reject only if a DIFFERENT, still-connected device owns this code
        if (existing && existing.deviceId !== deviceId && existing.ws.readyState === existing.ws.OPEN) {
          send(ws, { type: 'register-failed', reason: 'code-taken' });
          return;
        }
        if (existing && existing.ws !== ws) { try { existing.ws.close(); } catch {} }
        myCode = code;
        peers.set(code, { ws, deviceId, name: msg.name || 'Device', fingerprint: msg.fingerprint || null });
        send(ws, { type: 'registered', code, online: peers.size });
        break;
      }

      // address a peer by code; server forwards under their *from* identity
      case 'to': {
        const target = peers.get(norm(msg.to));
        const me = myCode ? peers.get(myCode) : null;
        if (!target || target.ws.readyState !== target.ws.OPEN) {
          send(ws, { type: 'peer-offline', to: norm(msg.to), ref: msg.ref });
          return;
        }
        send(target.ws, {
          type: 'from',
          from: myCode,
          fromName: me ? me.name : undefined,
          fromFingerprint: me ? me.fingerprint : undefined,
          payload: msg.payload,
        });
        break;
      }

      // is this code online right now?
      case 'lookup': {
        const target = peers.get(norm(msg.code));
        send(ws, {
          type: 'lookup-result',
          code: norm(msg.code),
          online: !!(target && target.ws.readyState === target.ws.OPEN),
          name: target ? target.name : undefined,
        });
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    if (myCode && peers.get(myCode) && peers.get(myCode).ws === ws) peers.delete(myCode);
  });
  ws.on('error', () => {});
});

// drop dead sockets so codes free up
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`filedrop-relay listening on :${PORT}`));
