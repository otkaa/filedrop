'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalize } = require('./certs');
const { sourceAddressFor } = require('./netinfo');

const MAX_RESUME_ATTEMPTS = 6;
const RETRY_DELAY = 1200; // ms

/**
 * Send a set of files to a peer.
 *
 * @param peer    { id, name, ip, port, fingerprint }
 * @param self    { id, name, os }
 * @param filePaths string[] absolute paths
 * @param hooks   { onTransfer(update), signal, version }
 */
async function sendFiles(peer, self, filePaths, hooks = {}) {
  const onTransfer = hooks.onTransfer || (() => {});
  const signal = hooks.signal;

  // gather metadata
  const metas = [];
  for (const p of filePaths) {
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch (err) {
      throw new Error(`cannot read ${p}: ${err.message}`);
    }
    metas.push({ id: crypto.randomUUID(), name: path.basename(p), size, path: p });
  }

  // One AbortController PER FILE so the user can cancel a single transfer
  // without killing the rest of the batch. A batch-level signal (app quit /
  // "cancel all") is chained to every file's controller.
  const controllers = {}; // meta.id -> AbortController
  const transferIds = {};
  for (const m of metas) {
    transferIds[m.id] = 'out-' + m.id;
    const ctrl = new AbortController();
    controllers[m.id] = ctrl;
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener('abort', () => ctrl.abort(), { once: true });
    }
    onTransfer({
      id: transferIds[m.id],
      direction: 'out',
      peer: peer.name,
      fileName: m.name,
      total: m.size,
      transferred: 0,
      status: 'pending',
      controller: ctrl, // main.js maps this for per-row cancel; stripped before the renderer
    });
  }

  const emit = (m, status, transferred) =>
    onTransfer({
      id: transferIds[m.id],
      direction: 'out',
      peer: peer.name,
      fileName: m.name,
      total: m.size,
      transferred: transferred != null ? transferred : 0,
      status,
    });

  // 1. prepare-upload (this is where the receiver is prompted to accept)
  let prep;
  try {
    prep = await request(peer, {
      method: 'POST',
      path: '/api/prepare-upload',
      json: {
        sender: { id: self.id, name: self.name, os: self.os },
        files: metas.map((m) => ({ id: m.id, name: m.name, size: m.size })),
      },
      signal,
    });
  } catch (err) {
    for (const m of metas) emit(m, 'error', 0);
    throw err;
  }

  if (prep.status === 403) {
    for (const m of metas) emit(m, 'declined', 0);
    const e = new Error('Recipient declined the transfer');
    e.declined = true;
    throw e;
  }
  if (prep.status !== 200 || !prep.body || !prep.body.sessionId) {
    for (const m of metas) emit(m, 'error', 0);
    throw new Error('Recipient is unavailable');
  }

  const sessionId = prep.body.sessionId;

  // 2. upload each file (with resume). The server returns files in the same
  // order we sent them, so we can pair by index.
  if (!Array.isArray(prep.body.files) || prep.body.files.length !== metas.length) {
    for (const m of metas) emit(m, 'error', 0);
    throw new Error('Recipient returned an unexpected response');
  }
  const results = [];
  for (let i = 0; i < prep.body.files.length; i++) {
    const ff = prep.body.files[i];
    const meta = metas[i]; // order is preserved by the server
    const token = ff.token;
    try {
      await uploadOne(peer, sessionId, ff.id, token, meta, {
        onProgress: (sent) => emit(meta, 'active', sent),
        signal: controllers[meta.id].signal,
      });
      emit(meta, 'done', meta.size);
      results.push({ name: meta.name, ok: true });
    } catch (err) {
      if (err && err.canceled) {
        emit(meta, 'canceled', 0);
        // drop just THIS file on the receiver, not the whole session
        try {
          await request(peer, {
            method: 'POST',
            path: `/api/cancel?session=${sessionId}&file=${ff.id}`,
          });
        } catch (_) {}
        results.push({ name: meta.name, ok: false, canceled: true });
        // a batch-level abort stops everything; a single-file cancel does not
        if (signal && signal.aborted) throw err;
        continue;
      }
      emit(meta, 'error', 0);
      results.push({ name: meta.name, ok: false, error: err.message });
    }
  }

  return { results };
}

async function uploadOne(peer, sessionId, fileId, token, meta, { onProgress, signal }) {
  let attempt = 0;
  // resumable loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (signal && signal.aborted) throw canceled();

    // how many bytes does the receiver already have?
    let offset = 0;
    try {
      const st = await request(peer, {
        method: 'GET',
        path: `/api/status?session=${sessionId}&file=${fileId}`,
        signal,
      });
      if (st.status === 200 && st.body) offset = Math.min(meta.size, Number(st.body.received) || 0);
    } catch (_) {
      // status is best-effort; assume 0 on failure
    }

    if (offset >= meta.size && meta.size > 0) {
      onProgress(meta.size);
      return; // already fully received
    }

    try {
      await streamUpload(peer, sessionId, fileId, token, meta, offset, { onProgress, signal });
      return;
    } catch (err) {
      if (err && err.canceled) throw err;
      attempt++;
      if (attempt >= MAX_RESUME_ATTEMPTS) throw err;
      await delay(RETRY_DELAY, signal);
    }
  }
}

function streamUpload(peer, sessionId, fileId, token, meta, offset, { onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const remaining = meta.size - offset;
    const options = baseOptions(peer);
    options.method = 'POST';
    options.path = `/api/upload?session=${sessionId}&file=${fileId}&token=${token}&offset=${offset}`;
    options.headers = {
      'content-type': 'application/octet-stream',
      'content-length': remaining,
    };

    const req = https.request(options);
    let settled = false;
    let sent = offset;

    // single point that removes the abort listener exactly once, on every
    // settle path (prevents listener accumulation on the shared signal).
    function finalize() {
      if (settled) return false;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      return true;
    }
    function fail(err) {
      if (finalize()) {
        try {
          req.destroy();
        } catch (_) {}
        reject(err);
      }
    }
    const onAbort = () => {
      if (finalize()) {
        try {
          req.destroy();
        } catch (_) {}
        reject(canceled());
      }
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }

    pinFingerprint(req, peer, (err) => fail(err));

    const rs = fs.createReadStream(meta.path, { start: offset });
    rs.on('data', (chunk) => {
      sent += chunk.length;
      onProgress(sent);
    });
    rs.on('error', (err) => fail(err));

    req.on('error', (err) => {
      if (finalize()) reject(err);
    });

    req.on('response', (res) => {
      if (!socketMatches(res.socket, peer)) {
        if (finalize()) {
          res.destroy();
          reject(new Error('Security check failed: device identity mismatch'));
        }
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (!finalize()) return;
        let body = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {}
        if (res.statusCode === 200 && (body.complete || body.received >= meta.size)) {
          resolve(body);
        } else if (res.statusCode === 200) {
          // partial — caller's resume loop will continue
          reject(new Error('incomplete'));
        } else {
          reject(new Error(body.error || `upload failed (${res.statusCode})`));
        }
      });
    });

    rs.pipe(req);
  });
}

// --- low-level request with fingerprint pinning ------------------------------

function baseOptions(peer) {
  // Bind the outbound socket to the local interface that shares a subnet with
  // the peer. This keeps LAN traffic on the LAN NIC even when a full-tunnel VPN
  // has hijacked the default route, so the app keeps working with a VPN on.
  const localAddress = sourceAddressFor(peer.ip) || undefined;
  return {
    host: peer.ip,
    port: peer.port,
    localAddress,
    rejectUnauthorized: false, // self-signed; we pin the fingerprint instead
    checkServerIdentity: () => undefined,
    // A dedicated, non-pooling agent per request: this guarantees a fresh TLS
    // handshake (so 'secureConnect' fires and pinning runs BEFORE we send any
    // bytes). A shared keep-alive agent would reuse a socket and silently skip
    // the fingerprint check.
    agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0, localAddress }),
  };
}

/** True if the socket's peer presents the fingerprint we expect. */
function socketMatches(socket, peer) {
  if (!peer.fingerprint) return true; // nothing to pin against (first contact)
  try {
    const cert = socket.getPeerCertificate();
    const got = normalize(cert && cert.fingerprint256);
    return !!got && got === normalize(peer.fingerprint);
  } catch (_) {
    return false;
  }
}

function pinFingerprint(req, peer, onMismatch) {
  if (!peer.fingerprint) return; // nothing to pin against
  req.on('socket', (socket) => {
    socket.on('secureConnect', () => {
      if (!socketMatches(socket, peer)) {
        onMismatch(new Error('Security check failed: device identity mismatch'));
      }
    });
  });
}

function request(peer, { method, path: reqPath, json, signal }) {
  return new Promise((resolve, reject) => {
    const options = baseOptions(peer);
    options.method = method;
    options.path = reqPath;
    options.headers = {};

    let payload = null;
    if (json !== undefined) {
      payload = Buffer.from(JSON.stringify(json));
      options.headers['content-type'] = 'application/json';
      options.headers['content-length'] = payload.length;
    }

    const req = https.request(options);
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(arg);
    };
    const onAbort = () => {
      try {
        req.destroy();
      } catch (_) {}
      done(reject, canceled());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    pinFingerprint(req, peer, (err) => {
      // settle with the identity error FIRST, so the socket-destroy error
      // that follows doesn't win the race and mask the real reason.
      done(reject, err);
      try {
        req.destroy();
      } catch (_) {}
    });

    req.on('error', (err) => done(reject, err));
    req.on('response', (res) => {
      if (!socketMatches(res.socket, peer)) {
        res.destroy();
        return done(reject, new Error('Security check failed: device identity mismatch'));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (_) {}
        done(resolve, { status: res.statusCode, body });
      });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Probe a host:port directly (used for "Add device by address" — reaches peers
 * that are in stealth mode and therefore not broadcasting). Trust-on-first-use:
 * we capture the cert fingerprint from the handshake and pin it from then on.
 */
function probe(host, port) {
  return new Promise((resolve, reject) => {
    const localAddress = sourceAddressFor(host) || undefined;
    const options = {
      host,
      port,
      method: 'GET',
      path: '/api/info',
      localAddress,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      agent: new https.Agent({ keepAlive: false, maxCachedSessions: 0, localAddress }),
      timeout: 4000,
    };
    const req = https.request(options);
    let fingerprint = null;
    req.on('socket', (socket) => {
      socket.on('secureConnect', () => {
        try {
          const cert = socket.getPeerCertificate();
          fingerprint = normalize(cert && cert.fingerprint256);
        } catch (_) {}
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.on('response', (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const info = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!info || !info.id) return reject(new Error('not a Filedrop device'));
          resolve({
            id: info.id,
            name: info.name || `${host}`,
            os: info.os,
            version: info.version,
            ip: host,
            port: Number(port),
            fingerprint,
            manual: true,
          });
        } catch (err) {
          reject(new Error('not a Filedrop device'));
        }
      });
    });
    req.end();
  });
}

function canceled() {
  const e = new Error('canceled');
  e.canceled = true;
  return e;
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(canceled());
        },
        { once: true }
      );
    }
  });
}

/**
 * Fire a small JSON POST at a peer over the same fingerprint-pinned channel
 * (used for chat messages and WebRTC signaling). Returns { status, body }.
 */
function postJson(peer, reqPath, json) {
  return request(peer, { method: 'POST', path: reqPath, json });
}

module.exports = { sendFiles, probe, postJson };
