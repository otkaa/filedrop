'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');

const VERSION = require('../../package.json').version;
const PROGRESS_THROTTLE = 150; // ms between progress emits per file

/**
 * HTTPS server that receives files.
 *
 * Flow:
 *   1. POST /api/prepare-upload  -> ask the user to accept/decline.
 *   2. GET  /api/status          -> how many bytes of a file we already have.
 *   3. POST /api/upload          -> stream the bytes (supports resume via ?offset).
 *
 * Files are streamed straight to a "<name>.part" file and renamed on
 * completion, so multi-GB transfers never sit in memory.
 */
class ReceiveServer extends EventEmitter {
  constructor({ tls, getSettings, requestApproval, self }) {
    super();
    this.tls = tls; // { key, cert }
    this.getSettings = getSettings; // () => settings object
    this.requestApproval = requestApproval; // (sender, files) => Promise<bool>
    this.self = self; // { id, name, os }
    this.server = null;
    this.sessions = new Map(); // sessionId -> session
    this._buckets = new Map(); // remoteAddress -> token bucket (chat/rtc flood guard)
  }

  /** Per-source token bucket: ~5 msgs/sec sustained, burst 20. */
  _rateOk(req) {
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
    const now = Date.now();
    const b = this._buckets.get(ip) || { tokens: 20, ts: now };
    b.tokens = Math.min(20, b.tokens + ((now - b.ts) * 5) / 1000);
    b.ts = now;
    if (b.tokens < 1) {
      this._buckets.set(ip, b);
      return false;
    }
    b.tokens -= 1;
    this._buckets.set(ip, b);
    return true;
  }

  start(port, host) {
    return new Promise((resolve, reject) => {
      this.server = https.createServer(
        { key: this.tls.key, cert: this.tls.cert },
        (req, res) => this._route(req, res)
      );
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve(port);
      });
    });
  }

  stop() {
    try {
      this.server && this.server.close();
    } catch (_) {}
  }

  // --- routing ---------------------------------------------------------------

  _route(req, res) {
    const url = new URL(req.url, 'https://localhost');
    const route = `${req.method} ${url.pathname}`;
    try {
      switch (route) {
        case 'GET /api/info':
          return this._json(res, 200, {
            id: this.self.id,
            name: this.self.name,
            os: this.self.os,
            version: VERSION,
          });
        case 'POST /api/prepare-upload':
          return this._prepareUpload(req, res);
        case 'GET /api/status':
          return this._status(req, res, url);
        case 'POST /api/upload':
          return this._upload(req, res, url);
        case 'POST /api/cancel':
          return this._cancel(req, res, url);
        case 'POST /api/message':
          return this._message(req, res);
        case 'POST /api/rtc':
          return this._rtc(req, res);
        default:
          return this._json(res, 404, { error: 'not found' });
      }
    } catch (err) {
      this._json(res, 500, { error: err.message });
    }
  }

  async _prepareUpload(req, res) {
    let body;
    try {
      body = await readJson(req, 1 << 20); // cap metadata at 1 MiB
    } catch (err) {
      return this._json(res, 400, { error: 'bad request' });
    }
    const sender = body && body.sender;
    const files = Array.isArray(body && body.files) ? body.files : null;
    if (!sender || !files || files.length === 0) {
      return this._json(res, 400, { error: 'missing sender or files' });
    }

    const total = files.reduce((n, f) => n + (Number(f.size) || 0), 0);
    let accepted = false;
    try {
      accepted = await this.requestApproval(
        { id: sender.id, name: sender.name || 'Unknown', os: sender.os },
        files.map((f) => ({ name: String(f.name || 'file'), size: Number(f.size) || 0 }))
      );
    } catch (_) {
      accepted = false;
    }
    if (!accepted) {
      return this._json(res, 403, { error: 'declined' });
    }

    const settings = this.getSettings();
    const dir = settings.downloadFolder;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      return this._json(res, 500, { error: 'cannot create download folder' });
    }

    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      sender: { id: sender.id, name: sender.name || 'Unknown', os: sender.os },
      dir,
      files: new Map(),
      total,
      createdAt: Date.now(),
    };

    const out = [];
    for (const f of files) {
      const fileId = crypto.randomUUID();
      const safeName = safeFilename(f.name);
      const entry = {
        id: fileId,
        name: safeName,
        size: Number(f.size) || 0,
        token: crypto.randomBytes(16).toString('hex'),
        partPath: path.join(dir, safeName + '.part'),
        finalPath: null, // resolved on completion (collision-safe)
        received: 0,
        status: 'pending',
        lastEmit: 0,
        transferId: 'in-' + fileId,
      };
      // resume support: if a matching .part already exists, continue from there
      try {
        const st = fs.statSync(entry.partPath);
        entry.received = st.size;
      } catch (_) {}
      session.files.set(fileId, entry);
      out.push({ id: fileId, name: safeName, token: entry.token, received: entry.received });

      this.emit('transfer', {
        id: entry.transferId,
        direction: 'in',
        peer: session.sender.name,
        fileName: safeName,
        total: entry.size,
        transferred: entry.received,
        status: 'pending',
      });
    }

    this.sessions.set(sessionId, session);
    // GC stale sessions that never complete
    setTimeout(() => this.sessions.delete(sessionId), 6 * 60 * 60 * 1000).unref();

    return this._json(res, 200, { sessionId, files: out });
  }

  _status(req, res, url) {
    const session = this.sessions.get(url.searchParams.get('session'));
    const entry = session && session.files.get(url.searchParams.get('file'));
    if (!entry) return this._json(res, 404, { error: 'unknown file' });
    let received = entry.received;
    try {
      received = fs.statSync(entry.partPath).size;
      entry.received = received;
    } catch (_) {}
    return this._json(res, 200, { received });
  }

  _upload(req, res, url) {
    const session = this.sessions.get(url.searchParams.get('session'));
    const entry = session && session.files.get(url.searchParams.get('file'));
    if (!entry) return this._json(res, 404, { error: 'unknown file' });
    if (url.searchParams.get('token') !== entry.token) {
      return this._json(res, 403, { error: 'bad token' });
    }

    // single-flight per file: refuse a second concurrent upload of the same
    // file so two write streams can't corrupt the same .part. A resume is
    // still allowed once the previous request has fully settled.
    if (entry.uploading) {
      return this._json(res, 409, { error: 'upload already in progress', received: entry.received });
    }

    const offset = Math.max(0, parseInt(url.searchParams.get('offset') || '0', 10) || 0);

    // current on-disk size must line up with the requested offset
    let onDisk = 0;
    try {
      onDisk = fs.statSync(entry.partPath).size;
    } catch (_) {}
    if (offset > onDisk) {
      return this._json(res, 409, { error: 'offset gap', received: onDisk });
    }

    // Enforce the declared (user-approved) size. Reject an oversized body up
    // front, and cap the running byte count below — otherwise a peer could
    // declare "1 byte", get approved, then stream gigabytes (disk-exhaustion
    // DoS + defeats size-based approval).
    const cap = entry.size;
    const remaining = cap - offset;
    const declaredLen = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLen) && declaredLen > remaining) {
      return this._json(res, 413, { error: 'declared size exceeded' });
    }

    entry.uploading = true;
    let finished = false;
    const settle = () => {
      if (finished) return false;
      finished = true;
      entry.uploading = false;
      req.removeListener('data', onData);
      return true;
    };

    const ws = fs.createWriteStream(entry.partPath, {
      flags: offset > 0 ? 'r+' : 'w',
      start: offset,
    });
    entry.received = offset;
    entry.status = 'active';

    const onData = (chunk) => {
      entry.received += chunk.length;
      if (entry.received > cap) {
        // overflow: abort hard, discard the partial, write nothing more
        if (settle()) {
          try { req.unpipe(ws); } catch (_) {}
          try { ws.destroy(); } catch (_) {}
          try { req.destroy(); } catch (_) {}
          try { fs.unlinkSync(entry.partPath); } catch (_) {}
          entry.status = 'error';
          this._emitProgress(session, entry, 'error');
          if (!res.headersSent) this._json(res, 413, { error: 'declared size exceeded' });
        }
        return;
      }
      const now = Date.now();
      if (now - entry.lastEmit >= PROGRESS_THROTTLE) {
        entry.lastEmit = now;
        this._emitProgress(session, entry, 'active');
      }
    };
    req.on('data', onData);

    const cleanupFail = (status, message) => {
      if (!settle()) return;
      entry.status = 'error';
      this._emitProgress(session, entry, 'error');
      if (!res.headersSent) this._json(res, status, { error: message });
    };

    req.on('aborted', () => {
      if (!settle()) return;
      // keep the .part file so the sender can resume
      try {
        ws.destroy();
      } catch (_) {}
      entry.status = 'paused';
      this._emitProgress(session, entry, 'paused');
    });

    ws.on('error', (err) => cleanupFail(500, err.message));

    req.pipe(ws);

    ws.on('finish', () => {
      if (finished) return; // overflow/abort already settled this request
      let finalSize = entry.received;
      try {
        finalSize = fs.statSync(entry.partPath).size;
      } catch (_) {}
      if (cap && finalSize < cap) {
        // partial (connection cut cleanly mid-stream) — allow resume
        if (!settle()) return;
        entry.status = 'paused';
        entry.received = finalSize;
        this._emitProgress(session, entry, 'paused');
        return this._json(res, 200, { received: finalSize, complete: false });
      }
      if (finalSize > cap) {
        // defensive: more bytes than declared slipped through
        if (!settle()) return;
        try {
          fs.unlinkSync(entry.partPath);
        } catch (_) {}
        entry.status = 'error';
        this._emitProgress(session, entry, 'error');
        return this._json(res, 413, { error: 'declared size exceeded' });
      }
      if (!settle()) return;
      // finalize: rename .part -> unique final name
      const finalPath = uniquePath(path.join(session.dir, entry.name));
      try {
        fs.renameSync(entry.partPath, finalPath);
      } catch (err) {
        entry.status = 'error';
        this._emitProgress(session, entry, 'error');
        return this._json(res, 500, { error: 'cannot finalize file' });
      }
      entry.finalPath = finalPath;
      entry.status = 'done';
      entry.received = finalSize;
      this._emitProgress(session, entry, 'done');
      this._json(res, 200, { received: finalSize, complete: true });
    });
  }

  _cancel(req, res, url) {
    const session = this.sessions.get(url.searchParams.get('session'));
    if (session) {
      const fileId = url.searchParams.get('file');
      // with ?file= cancel just that one file; otherwise cancel the whole session
      const entries = fileId
        ? [session.files.get(fileId)].filter(Boolean)
        : Array.from(session.files.values());
      for (const entry of entries) {
        if (entry.status !== 'done') {
          try {
            fs.unlinkSync(entry.partPath);
          } catch (_) {}
          entry.status = 'canceled';
          this._emitProgress(session, entry, 'canceled');
        }
      }
      if (!fileId) this.sessions.delete(session.id);
    }
    return this._json(res, 200, { ok: true });
  }

  // --- chat --------------------------------------------------------------
  async _message(req, res) {
    if (!this._rateOk(req)) return this._json(res, 429, { error: 'rate limited' });
    let body;
    try {
      body = await readJson(req, 256 * 1024);
    } catch (_) {
      return this._json(res, 400, { error: 'bad request' });
    }
    const from = body && body.from;
    const text = body && typeof body.text === 'string' ? body.text : null;
    if (!from || !from.id || text == null) {
      return this._json(res, 400, { error: 'missing fields' });
    }
    this.emit('message', {
      peerId: String(from.id),
      peerName: String(from.name || 'Unknown').slice(0, 64),
      text: text.slice(0, 8000),
      ts: Number(body.ts) || Date.now(),
    });
    return this._json(res, 200, { ok: true });
  }

  // --- WebRTC signaling (offer/answer/decline/hangup/busy) ---------------
  async _rtc(req, res) {
    if (!this._rateOk(req)) return this._json(res, 429, { error: 'rate limited' });
    let body;
    try {
      body = await readJson(req, 512 * 1024); // SDP with embedded ICE candidates
    } catch (_) {
      return this._json(res, 400, { error: 'bad request' });
    }
    const from = body && body.from;
    const kind = body && body.kind;
    const ALLOWED = new Set(['offer', 'answer', 'decline', 'busy', 'hangup']);
    if (!from || !from.id || !ALLOWED.has(kind)) {
      return this._json(res, 400, { error: 'missing or invalid fields' });
    }
    // SDP only carries on offer/answer; other kinds must not smuggle a payload
    const sdp = (kind === 'offer' || kind === 'answer') && typeof body.sdp === 'string' ? body.sdp : null;
    this.emit('signal', {
      peerId: String(from.id),
      peerName: String(from.name || 'Unknown').slice(0, 64),
      kind,
      callId: body.callId ? String(body.callId).slice(0, 64) : null,
      sdp,
      // reachback details so we can reply to a stealth/unlisted caller
      peerIp: (req.socket && req.socket.remoteAddress) || null,
      peerPort: from.port ? Number(from.port) : null,
      peerFingerprint: typeof from.fingerprint === 'string' ? from.fingerprint.slice(0, 128) : null,
    });
    return this._json(res, 200, { ok: true });
  }

  _emitProgress(session, entry, status) {
    this.emit('transfer', {
      id: entry.transferId,
      direction: 'in',
      peer: session.sender.name,
      fileName: entry.name,
      total: entry.size,
      transferred: entry.received,
      status,
      finalPath: entry.finalPath || undefined,
    });
  }

  _json(res, status, obj) {
    const buf = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length });
    res.end(buf);
  }
}

// --- helpers -----------------------------------------------------------------

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function safeFilename(name) {
  let n = path.basename(String(name || 'file'));
  n = n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+/, '').trim();
  return n || 'file';
}

/** Return a path that doesn't exist, appending " (1)", " (2)", ... if needed. */
function uniquePath(p) {
  if (!fs.existsSync(p)) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; i < 10000; i++) {
    const candidate = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

module.exports = { ReceiveServer };
