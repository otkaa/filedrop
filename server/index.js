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

/** code (UPPERCASE) -> { ws, deviceId, name, fingerprint, fcmToken } */
const peers = new Map();

// FCM push tokens kept PER CODE, persisting across disconnects — so we can push
// to a code whose app is fully CLOSED (its live `peers` entry is long gone).
/** code (UPPERCASE) -> fcmToken */
const fcmTokens = new Map();

// Missed chat messages for OFFLINE codes, replayed on reconnect.
/** code (UPPERCASE) -> Array<{ from, fromName, payload }> (cap 50, FIFO) */
const offlineQueue = new Map();
const OFFLINE_QUEUE_CAP = 50;

// ── Firebase Cloud Messaging (push to wake fully-closed apps) ──────────────
// Initializes ONCE from a service-account JSON in env FIREBASE_SERVICE_ACCOUNT.
// If it's missing/invalid we log a warning and DISABLE push — the relay still
// works for online peers and must never crash because FCM is misconfigured.
let admin = null;
let fcmReady = false;
let fcmError = null; // why push is off, surfaced in /health for diagnostics
(function initFcm() {
  let saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  // LOCAL testing fallback only: read the file if the env var isn't set.
  // Production always uses the env var; we never print/commit the contents.
  if (!saJson) {
    try {
      saJson = require('fs').readFileSync('C:\\Users\\Admin\\fcm-sa.json', 'utf8');
    } catch { /* no local file — that's fine */ }
  }
  if (!saJson) {
    fcmError = 'FIREBASE_SERVICE_ACCOUNT env var not set';
    console.warn('[fcm] FIREBASE_SERVICE_ACCOUNT not set — push DISABLED (online relay still works).');
    return;
  }
  try {
    const serviceAccount = JSON.parse(saJson);
    admin = require('firebase-admin');
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    fcmReady = true;
    console.log('[fcm] Firebase Admin initialized — push enabled.');
  } catch (e) {
    admin = null;
    fcmReady = false;
    fcmError = (e && e.message ? e.message : String(e)).slice(0, 160);
    console.warn('[fcm] invalid service account / init failed — push DISABLED:', e.message);
  }
})();

// Diagnostics: result of the most recent push attempt, surfaced via /health.
let lastPush = null;
// Diagnostics: how the most recent 'to' message was routed (forward vs offline push).
let lastTo = null;

// Fire-and-forget FCM send. Never throws; a bad/expired token logs and continues.
async function fcmSend(message, label) {
  if (!fcmReady || !admin) { lastPush = { at: Date.now(), label, ok: false, err: 'fcm-not-ready' }; return; }
  // How big is the data payload? FCM hard-caps a data message at 4096 bytes.
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(message.data || {}), 'utf8'); } catch (_) {}
  try {
    const id = await admin.messaging().send(message);
    lastPush = { at: Date.now(), label, ok: true, bytes, id: String(id).slice(-12) };
  } catch (e) {
    const err = (e && e.message ? e.message : String(e)).slice(0, 220);
    lastPush = { at: Date.now(), label, ok: false, bytes, err };
    console.warn(`[fcm] send failed (${label || 'msg'}):`, err);
  }
}

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
    // `fcm` = is push enabled (service account loaded); `tokens` = how many of
    // the online codes registered an FCM token. Diagnostics, no secrets.
    res.end(JSON.stringify({ ok: true, online: peers.size, fcm: fcmReady, tokens: fcmTokens.size, fcmError, lastTo, lastPush }));
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
        peers.set(code, {
          ws,
          deviceId,
          name: msg.name || 'Device',
          fingerprint: msg.fingerprint || null,
          fcmToken: msg.fcmToken || null,
        });
        // Remember the push token across disconnects so a CLOSED app can be woken.
        if (msg.fcmToken) fcmTokens.set(code, msg.fcmToken);
        send(ws, { type: 'registered', code, online: peers.size });
        // Deliver any chat messages that arrived while this code was offline.
        const queued = offlineQueue.get(code);
        if (queued && queued.length) {
          for (const item of queued) {
            send(ws, { type: 'from', from: item.from, fromName: item.fromName, payload: item.payload });
          }
          offlineQueue.delete(code);
        }
        break;
      }

      // address a peer by code; server forwards under their *from* identity
      case 'to': {
        const toCode = norm(msg.to);
        const target = peers.get(toCode);
        const me = myCode ? peers.get(myCode) : null;
        const payload = msg && msg.payload;
        const fromName = me ? me.name : undefined;
        const token = fcmTokens.get(toCode);
        const online = !!(target && target.ws.readyState === target.ws.OPEN);
        const isCallOffer = !!(payload && typeof payload === 'object' &&
                               payload.k === 'rtc' && payload.sig === 'offer');

        // CALLS: ALWAYS fire the VoIP push when we have a token, online or not.
        // A swipe-killed Android app commonly leaves a half-open socket here that
        // still reads as OPEN, so we must NOT gate the call wake-up on liveness
        // detection — exactly how WhatsApp/Discord deliver calls. The native call
        // screen dedupes by callId, so an app that ALSO gets the offer over its
        // live socket won't double-ring.
        if (isCallOffer && token) {
          fcmSend({
            token,
            android: { priority: 'high' },
            data: {
              type: 'call',
              callId: String(payload.callId || ''),
              fromCode: String(myCode || ''),
              fromName: String(fromName || ''),
              sdp: String(payload.sdp || ''),
            },
          }, online ? 'call+online' : 'call');
        }

        if (!online) {
          // Target's socket is OFFLINE. Tell the sender; for chat, queue + notify.
          send(ws, { type: 'peer-offline', to: toCode, ref: msg.ref });
          lastTo = { at: Date.now(), toCode, route: 'offline', hasToken: !!token,
                     k: payload && payload.k, sig: payload && payload.sig };
          if (token && payload && typeof payload === 'object' && payload.k === 'msg') {
            // Queue the missed chat message for replay on reconnect …
            let q = offlineQueue.get(toCode);
            if (!q) { q = []; offlineQueue.set(toCode, q); }
            q.push({ from: myCode, fromName, payload });
            while (q.length > OFFLINE_QUEUE_CAP) q.shift(); // drop oldest past cap
            // … and push a notification so it shows on a closed phone.
            fcmSend({
              token,
              android: { priority: 'high' },
              notification: {
                title: String(fromName || ''),
                body: String(payload.text || ''),
              },
              data: { type: 'msg', fromCode: String(myCode || '') },
            }, 'msg');
          }
          // Any other offline payload (answer/decline/hangup/candidate/ack):
          // nothing new — the peer-offline reply above is the whole story.
          return;
        }
        lastTo = { at: Date.now(), toCode, route: 'forward',
                   k: payload && payload.k, sig: payload && payload.sig };
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

// Drop dead sockets quickly so a swipe-killed app stops looking "online" (a
// half-open socket otherwise lingers until TCP gives up). 15s ping → a missed
// pong is reaped on the next tick, so a dead peer is gone within ~15-30s.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => console.log(`filedrop-relay listening on :${PORT}`));
