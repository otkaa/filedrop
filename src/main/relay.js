'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

const DEFAULT_URL = 'wss://filedrop-relay.onrender.com';
const PING_INTERVAL = 25000; // app-level keepalive (server answers {type:'pong'})
const BACKOFF_STEPS = [1000, 2000, 5000, 10000]; // reconnect backoff, capped at 10s
const LOOKUP_TIMEOUT = 8000;

/**
 * RelayClient — one outbound WebSocket to the rendezvous/relay server.
 *
 * Why this exists: the relay makes "just works over the internet" possible.
 * Every device opens ONE outbound WS (works through any NAT, no port-forward),
 * registers its persistent CODE, and reaches a friend by addressing THEIR code.
 * The server forwards the opaque app payload (chat / call signaling) to the peer.
 *
 * This client:
 *   - auto-reconnects with backoff and RE-REGISTERS on every (re)open,
 *   - pings every ~25s as an app-level keepalive,
 *   - splits inbound {type:'from'} into 'message' (payload.k==='msg'),
 *     'signal' (payload.k==='rtc') and 'ack' (payload.k==='ack') events,
 *   - exposes sendTo(code, payload) and lookup(code) -> Promise<{online,name}>.
 *
 * Events:
 *   'ready'   ({ code, online })       — registration accepted
 *   'message' ({ from, fromName, fromFingerprint, payload })  // chat
 *   'signal'  ({ from, fromName, fromFingerprint, payload })  // call signaling
 *   'ack'     ({ from, fromName, fromFingerprint, payload })  // delivery/read receipt
 *   'offline' ({ to, ref })            — a sendTo target wasn't connected
 *   'status'  ({ connected })          — transport up/down (UI hint)
 */
class RelayClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.url = opts.url || DEFAULT_URL;
    this.deviceId = String(opts.deviceId || '');
    this.deviceName = String(opts.deviceName || 'Device');
    this.fingerprint = opts.fingerprint || null;
    this.code = normCode(opts.code);

    this.ws = null;
    this.connected = false; // socket OPEN
    this.registered = false; // server accepted our register
    this.closed = false; // stop() was called — don't reconnect
    this._backoffIdx = 0;
    this._pingTimer = null;
    this._reconnectTimer = null;
    this._lookups = new Map(); // normalized code -> { resolve, timer }
  }

  /** Open the socket (idempotent). */
  connect() {
    if (this.closed) return;
    if (this.ws) return;
    this._open();
  }

  _open() {
    if (this.closed) return;
    let ws;
    try {
      ws = new WebSocket(this.url, { handshakeTimeout: 15000 });
    } catch (err) {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this._backoffIdx = 0; // reset backoff on a healthy connection
      this._register();
      this._startPing();
      this.emit('status', { connected: true });
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (_) {
        return;
      }
      this._handle(msg);
    });

    ws.on('close', () => this._onDown());
    ws.on('error', () => {
      // 'close' fires after 'error'; let _onDown handle reconnect.
    });
  }

  _onDown() {
    this.connected = false;
    this.registered = false;
    this._stopPing();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
      } catch (_) {}
    }
    this.ws = null;
    this.emit('status', { connected: false });
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.closed) return;
    if (this._reconnectTimer) return;
    const delay = BACKOFF_STEPS[Math.min(this._backoffIdx, BACKOFF_STEPS.length - 1)];
    this._backoffIdx++;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._open();
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  _register() {
    this._send({
      type: 'register',
      code: this.code,
      deviceId: this.deviceId,
      name: this.deviceName,
      fingerprint: this.fingerprint || null,
    });
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, PING_INTERVAL);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _handle(msg) {
    switch (msg && msg.type) {
      case 'registered':
        this.registered = true;
        this.emit('ready', { code: msg.code, online: msg.online });
        break;

      case 'register-failed':
        // A different live device owns this code. Regenerate + re-register so we
        // still get online (the renderer should persist the new code via the
        // 'code-changed' event).
        this.emit('register-failed', { reason: msg.reason });
        this.code = (typeof this._regenerate === 'function' ? this._regenerate() : this.code);
        this._register();
        break;

      case 'from': {
        const payload = msg.payload || {};
        const evt = {
          from: normCode(msg.from),
          fromName: msg.fromName,
          fromFingerprint: msg.fromFingerprint,
          payload,
        };
        if (payload.k === 'msg') this.emit('message', evt);
        else if (payload.k === 'rtc') this.emit('signal', evt);
        else if (payload.k === 'ack') this.emit('ack', evt);
        // other payload kinds (e.g. future file metadata) are ignored for now
        break;
      }

      case 'peer-offline':
        this.emit('offline', { to: normCode(msg.to), ref: msg.ref });
        break;

      case 'lookup-result': {
        const code = normCode(msg.code);
        const pending = this._lookups.get(code);
        if (pending) {
          clearTimeout(pending.timer);
          this._lookups.delete(code);
          pending.resolve({ online: !!msg.online, name: msg.name });
        }
        break;
      }

      case 'pong':
      default:
        break;
    }
  }

  _send(obj) {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(obj));
        return true;
      } catch (_) {}
    }
    return false;
  }

  /**
   * Send an app payload to a peer by their code.
   * @param code  peer's relay code (any case/format; normalized here)
   * @param payload  e.g. {k:'msg',text,ts} or {k:'rtc',sig,callId,sdp}
   * @param ref  optional id echoed back in 'peer-offline'
   * @returns true if the frame was handed to an OPEN socket
   */
  sendTo(code, payload, ref) {
    return this._send({ type: 'to', to: normCode(code), payload, ref });
  }

  /** Is a code online right now? Resolves {online, name}; never rejects. */
  lookup(code) {
    const c = normCode(code);
    return new Promise((resolve) => {
      if (!c || !this._send({ type: 'lookup', code: c })) {
        return resolve({ online: false, name: undefined });
      }
      // last writer wins if two lookups race for the same code
      const prev = this._lookups.get(c);
      if (prev) {
        clearTimeout(prev.timer);
        prev.resolve({ online: false, name: undefined });
      }
      const timer = setTimeout(() => {
        if (this._lookups.get(c)) {
          this._lookups.delete(c);
          resolve({ online: false, name: undefined });
        }
      }, LOOKUP_TIMEOUT);
      if (timer.unref) timer.unref();
      this._lookups.set(c, { resolve, timer });
    });
  }

  /** Update our display name; re-register so peers see the new name. */
  setName(name) {
    this.deviceName = String(name || 'Device');
    if (this.connected) this._register();
  }

  /** Provide a generator used when the server reports our code is taken. */
  setRegenerate(fn) {
    this._regenerate = fn;
  }

  stop() {
    this.closed = true;
    this._stopPing();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const [, p] of this._lookups) {
      clearTimeout(p.timer);
      try {
        p.resolve({ online: false, name: undefined });
      } catch (_) {}
    }
    this._lookups.clear();
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch (_) {}
      this.ws = null;
    }
    this.connected = false;
    this.registered = false;
  }
}

/** Normalize a code the same way the server does: uppercase, strip non-alnum. */
function normCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Group an 8-char code as "XXXX-XXXX" for display. */
function formatCode(code) {
  const c = normCode(code);
  if (c.length <= 4) return c;
  return c.slice(0, 4) + '-' + c.slice(4, 8) + (c.length > 8 ? c.slice(8) : '');
}

module.exports = { RelayClient, normCode, formatCode };
