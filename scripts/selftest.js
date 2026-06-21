'use strict';

/**
 * End-to-end test of the networking core (no Electron needed).
 * Exercises the REAL ReceiveServer + sender + certs + discovery modules.
 *
 *   node scripts/selftest.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const certs = require('../src/main/certs');
const { ReceiveServer } = require('../src/main/server');
const { sendFiles } = require('../src/main/sender');
const { Discovery } = require('../src/main/discovery');

let failures = 0;
function ok(name) {
  console.log('  \x1b[32m✓\x1b[0m ' + name);
}
function bad(name, err) {
  failures++;
  console.log('  \x1b[31m✗ ' + name + '\x1b[0m' + (err ? ' — ' + (err.message || err) : ''));
}
function assert(cond, name, err) {
  cond ? ok(name) : bad(name, err);
}

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'filedrop-test-'));
const dirs = {
  certA: mk('certA'),
  certB: mk('certB'),
  downloads: mk('downloads'),
  src: mk('src'),
};
function mk(n) {
  const p = path.join(ROOT, n);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (c) => h.update(c))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject);
  });
}

function makeFile(p, bytes) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(p);
    let written = 0;
    const chunk = crypto.randomBytes(1 << 20); // 1 MiB pattern, varied per write
    (function write() {
      let ahead = true;
      while (written < bytes && ahead) {
        const n = Math.min(chunk.length, bytes - written);
        // vary first bytes so blocks differ
        chunk.writeUInt32BE(written & 0xffffffff, 0);
        ahead = ws.write(Buffer.from(chunk.subarray(0, n)));
        written += n;
      }
      if (written < bytes) ws.once('drain', write);
      else ws.end(resolve);
    })();
    ws.on('error', reject);
  });
}

function rawRequest(opts, bodyStream) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      Object.assign({ rejectUnauthorized: false, checkServerIdentity: () => undefined }, opts),
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let body = null;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString());
          } catch (_) {}
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on('error', reject);
    if (bodyStream && bodyStream.pipe) bodyStream.pipe(req);
    else {
      if (bodyStream) req.write(bodyStream);
      req.end();
    }
    return req;
  });
}

(async function run() {
  console.log('\nFiledrop self-test');
  console.log('workdir:', ROOT, '\n');

  // --- certs ---------------------------------------------------------------
  console.log('certs:');
  const tlsB = certs.loadOrCreate(dirs.certB, 'DeviceB');
  const tlsA = certs.loadOrCreate(dirs.certA, 'DeviceA');
  assert(/^[0-9a-f]{64}$/.test(tlsB.fingerprint), 'fingerprint is 64-char hex');
  const reload = certs.loadOrCreate(dirs.certB, 'DeviceB');
  assert(reload.fingerprint === tlsB.fingerprint, 'cert persists across loads');

  // --- start receiver (Device B) ------------------------------------------
  console.log('\nserver + transfer:');
  let approvalDecision = true;
  let lastSender = null;
  const server = new ReceiveServer({
    tls: tlsB,
    getSettings: () => ({ downloadFolder: dirs.downloads }),
    requestApproval: async (sender) => {
      lastSender = sender;
      return approvalDecision;
    },
    self: { id: 'device-b', name: 'DeviceB', os: 'Linux' },
  });
  const port = await server.start(53319);
  ok('server listening on ' + port);

  const peerB = {
    id: 'device-b',
    name: 'DeviceB',
    ip: '127.0.0.1',
    port,
    fingerprint: tlsB.fingerprint,
  };
  const selfA = { id: 'device-a', name: 'DeviceA', os: 'Windows' };

  // small file
  const small = path.join(dirs.src, 'note.txt');
  fs.writeFileSync(small, 'hello from DeviceA — ' + 'x'.repeat(5000));
  await sendFiles(peerB, selfA, [small], {});
  const smallDst = path.join(dirs.downloads, 'note.txt');
  assert(fs.existsSync(smallDst), 'small file received');
  assert((await sha256File(small)) === (await sha256File(smallDst)), 'small file hash matches');
  assert(lastSender && lastSender.name === 'DeviceA', 'receiver saw correct sender name');

  // large file (streamed) — 150 MiB
  console.log('\nlarge file (150 MiB, streamed):');
  const big = path.join(dirs.src, 'movie.bin');
  await makeFile(big, 150 * 1024 * 1024);
  const bigHash = await sha256File(big);
  const rssBefore = process.memoryUsage().rss;
  let maxRss = rssBefore;
  const memTimer = setInterval(() => {
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }, 50);
  await sendFiles(peerB, selfA, [big], {});
  clearInterval(memTimer);
  const bigDst = path.join(dirs.downloads, 'movie.bin');
  assert(fs.existsSync(bigDst), 'large file received');
  assert((await sha256File(bigDst)) === bigHash, 'large file hash matches (150 MiB)');
  const growthMB = (maxRss - rssBefore) / (1024 * 1024);
  assert(
    growthMB < 100,
    `streamed without buffering whole file (RSS grew ${growthMB.toFixed(0)} MiB << 150)`,
    new Error(`RSS grew ${growthMB.toFixed(0)} MiB`)
  );

  // --- resume via sender (pre-seeded partial) ------------------------------
  console.log('\nresume:');
  const resumeName = 'resume-me.bin';
  const resumeSrc = path.join(dirs.src, resumeName);
  await makeFile(resumeSrc, 20 * 1024 * 1024);
  const resumeHash = await sha256File(resumeSrc);
  // seed a .part with the first half (as if a previous transfer was interrupted)
  const half = 10 * 1024 * 1024;
  const partPath = path.join(dirs.downloads, resumeName + '.part');
  await new Promise((res, rej) => {
    const ws = fs.createWriteStream(partPath);
    fs.createReadStream(resumeSrc, { start: 0, end: half - 1 }).pipe(ws).on('finish', res).on('error', rej);
  });
  await sendFiles(peerB, selfA, [resumeSrc], {});
  const resumeDst = path.join(dirs.downloads, resumeName);
  assert(fs.existsSync(resumeDst), 'resumed file finalized');
  assert((await sha256File(resumeDst)) === resumeHash, 'resumed file hash matches');

  // --- raw partial-then-resume (simulated network drop) --------------------
  console.log('\nnetwork-drop resume (raw protocol):');
  const dropName = 'dropped.bin';
  const dropSrc = path.join(dirs.src, dropName);
  await makeFile(dropSrc, 8 * 1024 * 1024);
  const dropHash = await sha256File(dropSrc);
  const dropSize = fs.statSync(dropSrc).size;
  const prep = await rawRequest(
    { host: '127.0.0.1', port, method: 'POST', path: '/api/prepare-upload', headers: { 'content-type': 'application/json' } },
    JSON.stringify({ sender: { id: 'device-a', name: 'DeviceA' }, files: [{ name: dropName, size: dropSize }] })
  );
  assert(prep.status === 200 && prep.body.sessionId, 'prepare-upload accepted');
  const sess = prep.body.sessionId;
  const fileId = prep.body.files[0].id;
  const token = prep.body.files[0].token;

  // send first 3 MiB then hard-destroy the socket
  await new Promise((resolve) => {
    const req = https.request({
      host: '127.0.0.1', port, method: 'POST',
      path: `/api/upload?session=${sess}&file=${fileId}&token=${token}&offset=0`,
      headers: { 'content-length': dropSize },
      rejectUnauthorized: false, checkServerIdentity: () => undefined,
    });
    let sent = 0;
    const rs = fs.createReadStream(dropSrc);
    rs.on('data', (c) => {
      sent += c.length;
      if (sent >= 3 * 1024 * 1024) {
        rs.destroy();
        req.destroy(); // simulate a dropped connection
        setTimeout(resolve, 200);
      }
    });
    req.on('error', () => {});
    rs.pipe(req);
  });

  const status = await rawRequest({ host: '127.0.0.1', port, method: 'GET', path: `/api/status?session=${sess}&file=${fileId}` });
  assert(status.body && status.body.received > 0 && status.body.received < dropSize, `server kept partial (${status.body.received} bytes)`);

  const offset = status.body.received;
  const fin = await rawRequest(
    { host: '127.0.0.1', port, method: 'POST', path: `/api/upload?session=${sess}&file=${fileId}&token=${token}&offset=${offset}`, headers: { 'content-length': dropSize - offset } },
    fs.createReadStream(dropSrc, { start: offset })
  );
  assert(fin.status === 200 && fin.body.complete, 'resume completed transfer');
  const dropDst = path.join(dirs.downloads, dropName);
  assert(fs.existsSync(dropDst) && (await sha256File(dropDst)) === dropHash, 'dropped+resumed file hash matches');

  // --- security: decline ---------------------------------------------------
  console.log('\nsecurity:');
  approvalDecision = false;
  let declined = false;
  try {
    await sendFiles(peerB, selfA, [small], {});
  } catch (e) {
    declined = !!e.declined;
  }
  assert(declined, 'decline is rejected with declined flag');
  approvalDecision = true;

  // --- security: fingerprint mismatch is refused ---------------------------
  let pinned = false;
  try {
    await sendFiles({ ...peerB, fingerprint: 'deadbeef'.repeat(8) }, selfA, [small], {});
  } catch (e) {
    pinned = /identity mismatch/i.test(e.message);
  }
  assert(pinned, 'wrong fingerprint is refused (MITM protection)');

  // --- filename safety -----------------------------------------------------
  const evil = path.join(dirs.src, 'evil.txt');
  fs.writeFileSync(evil, 'nope');
  // forge a traversal name via raw prepare-upload
  const ev = await rawRequest(
    { host: '127.0.0.1', port, method: 'POST', path: '/api/prepare-upload', headers: { 'content-type': 'application/json' } },
    JSON.stringify({ sender: { id: 'x', name: 'x' }, files: [{ name: '../../escaped.txt', size: 4 }] })
  );
  const safe = ev.body.files[0].name;
  assert(!safe.includes('..') && !safe.includes('/') && !safe.includes('\\'), `path traversal sanitized ("${safe}")`);

  // --- hardening: byte-cap / single-flight / per-file cancel ---------------
  console.log('\nhardening (disk-DoS, concurrency, per-file cancel):');
  const prepare = (files) =>
    rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/prepare-upload', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ sender: { id: 'x', name: 'X' }, files })
    );

  // (a) content-length larger than the approved size is rejected up front
  {
    const p = await prepare([{ name: 'cap-cl.bin', size: 1000 }]);
    const f = p.body.files[0];
    const code = await new Promise((resolve) => {
      const req = https.request({
        host: '127.0.0.1', port, method: 'POST',
        path: `/api/upload?session=${p.body.sessionId}&file=${f.id}&token=${f.token}&offset=0`,
        headers: { 'content-length': 5000 }, rejectUnauthorized: false, checkServerIdentity: () => undefined,
      });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
      req.on('error', () => resolve('err'));
      req.end(Buffer.alloc(5000));
    });
    assert(code === 413, `oversized content-length rejected up front (got ${code})`);
    assert(!fs.existsSync(path.join(dirs.downloads, 'cap-cl.bin')), 'oversized-declared file never created');
  }

  // (b) streamed overflow (chunked, no content-length) is capped; .part discarded
  {
    const big = path.join(dirs.src, 'overflow.src');
    await makeFile(big, 300 * 1024); // 300 KiB streamed against a declared 2000 bytes
    const p = await prepare([{ name: 'cap-stream.bin', size: 2000 }]);
    const f = p.body.files[0];
    await new Promise((resolve) => {
      const req = https.request({
        host: '127.0.0.1', port, method: 'POST',
        path: `/api/upload?session=${p.body.sessionId}&file=${f.id}&token=${f.token}&offset=0`,
        rejectUnauthorized: false, checkServerIdentity: () => undefined, // no content-length -> chunked
      });
      req.on('response', (res) => { res.resume(); res.on('end', () => setTimeout(resolve, 150)); });
      req.on('error', () => setTimeout(resolve, 150));
      fs.createReadStream(big).pipe(req);
    });
    assert(!fs.existsSync(path.join(dirs.downloads, 'cap-stream.bin')), 'overflowed file not finalized');
    assert(!fs.existsSync(path.join(dirs.downloads, 'cap-stream.bin.part')), 'overflowed .part discarded (no disk fill)');
  }

  // (c) single-flight: two concurrent uploads to the same file -> one is 409
  {
    const conc = path.join(dirs.src, 'concurrent.bin');
    await makeFile(conc, 6 * 1024 * 1024);
    const sz = fs.statSync(conc).size;
    const p = await prepare([{ name: 'concurrent.bin', size: sz }]);
    const f = p.body.files[0];
    const doUpload = () =>
      new Promise((resolve) => {
        const req = https.request({
          host: '127.0.0.1', port, method: 'POST',
          path: `/api/upload?session=${p.body.sessionId}&file=${f.id}&token=${f.token}&offset=0`,
          headers: { 'content-length': sz }, rejectUnauthorized: false, checkServerIdentity: () => undefined,
        });
        req.on('response', (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
        req.on('error', () => resolve('err'));
        fs.createReadStream(conc).pipe(req);
      });
    const [a, b] = await Promise.all([doUpload(), doUpload()]);
    assert(a === 409 || b === 409, `concurrent upload to same file returns 409 (got ${a}, ${b})`);
  }

  // (d) per-file cancel leaves the session and sibling files intact
  {
    const p = await prepare([{ name: 'keep.bin', size: 4 }, { name: 'cancelme.bin', size: 4 }]);
    const keep = p.body.files[0];
    const cancelme = p.body.files[1];
    const cr = await rawRequest({ host: '127.0.0.1', port, method: 'POST', path: `/api/cancel?session=${p.body.sessionId}&file=${cancelme.id}` });
    assert(cr.status === 200, 'per-file cancel accepted');
    const st = await rawRequest({ host: '127.0.0.1', port, method: 'GET', path: `/api/status?session=${p.body.sessionId}&file=${keep.id}` });
    assert(st.status === 200, 'session survives per-file cancel (sibling still reachable)');
    const up = await rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: `/api/upload?session=${p.body.sessionId}&file=${keep.id}&token=${keep.token}&offset=0`, headers: { 'content-length': 4 } },
      Buffer.from('keep')
    );
    assert(up.status === 200 && up.body && up.body.complete, 'sibling completes after the other file was canceled');
  }

  // --- comms: chat + WebRTC signaling endpoints ---------------------------
  console.log('\ncomms (chat + signaling):');
  {
    let gotMsg = null;
    let gotSig = null;
    server.on('message', (m) => (gotMsg = m));
    server.on('signal', (s) => (gotSig = s));

    const mr = await rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/message', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ from: { id: 'a', name: 'Alice' }, text: 'hello there', ts: 123 })
    );
    assert(
      mr.status === 200 && gotMsg && gotMsg.text === 'hello there' && gotMsg.peerName === 'Alice' && gotMsg.peerId === 'a',
      'chat message delivered + emitted'
    );

    const sr = await rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/rtc', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ from: { id: 'a', name: 'Alice', port: 53999, fingerprint: 'ab'.repeat(32) }, kind: 'offer', callId: 'c1', sdp: 'v=0\r\n' })
    );
    assert(
      sr.status === 200 && gotSig && gotSig.kind === 'offer' && gotSig.callId === 'c1' && gotSig.sdp === 'v=0\r\n',
      'rtc signal delivered + emitted'
    );
    assert(
      gotSig && gotSig.peerPort === 53999 && gotSig.peerFingerprint === 'ab'.repeat(32) && !!gotSig.peerIp,
      'rtc signal carries reachback info (stealth-caller answerable)'
    );

    // SDP must not ride on non-offer/answer kinds
    const hr = await rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/rtc', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ from: { id: 'a' }, kind: 'hangup', callId: 'c1', sdp: 'sneaky' })
    );
    assert(hr.status === 200 && gotSig && gotSig.kind === 'hangup' && gotSig.sdp === null, 'sdp stripped from hangup signal');

    const kr = await rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/rtc', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ from: { id: 'a' }, kind: 'evil', callId: 'c1' })
    );
    assert(kr.status === 400, 'invalid rtc kind rejected (400)');

    const br = await rawRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/api/message', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ from: { id: 'a' } }) // missing text
    );
    assert(br.status === 400, 'malformed chat message rejected (400)');

    // flood guard: many concurrent messages -> some get 429
    const flood = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        rawRequest(
          { host: '127.0.0.1', port, method: 'POST', path: '/api/message', headers: { 'content-type': 'application/json' } },
          JSON.stringify({ from: { id: 'a', name: 'A' }, text: 'spam ' + i })
        ).then((r) => r.status)
      )
    );
    assert(flood.filter((s) => s === 429).length > 0, `message flood is rate-limited (${flood.filter((s) => s === 429).length}/40 got 429)`);
  }

  // --- vpn resilience: outbound source-address binding --------------------
  console.log('\nvpn resilience (source-address binding):');
  {
    const netinfo = require('../src/main/netinfo');
    assert(netinfo.sourceAddressFor('127.0.0.1') === null, 'loopback dest -> no binding (null)');
    assert(netinfo.sourceAddressFor('8.8.8.8') === null, 'non-local dest -> no binding (null)');
    const lan = netinfo.ipv4Interfaces()[0];
    if (lan) {
      assert(netinfo.sourceAddressFor(lan.address) === lan.address, `same-subnet dest binds to LAN source (${lan.address})`);
      // a real transfer to our OWN LAN IP exercises the localAddress-bound socket
      const f = path.join(dirs.src, 'vpn.txt');
      fs.writeFileSync(f, 'routed over the LAN nic ' + 'z'.repeat(3000));
      const lanPeer = { id: 'device-b', name: 'DeviceB', ip: lan.address, port, fingerprint: tlsB.fingerprint };
      try {
        await sendFiles(lanPeer, selfA, [f], {});
        const dst = path.join(dirs.downloads, 'vpn.txt');
        assert(fs.existsSync(dst) && (await sha256File(dst)) === (await sha256File(f)), 'transfer to own LAN IP works with source binding');
      } catch (e) {
        bad('transfer to own LAN IP works with source binding', e);
      }
    } else {
      console.log('  \x1b[33m~ skipped LAN-IP transfer: no external IPv4 on this host\x1b[0m');
    }
  }

  server.stop();

  // --- discovery (best-effort; multicast may be blocked in CI) -------------
  console.log('\ndiscovery (multicast, best-effort):');
  await testDiscovery();

  // --- summary -------------------------------------------------------------
  console.log('\n' + (failures === 0 ? '\x1b[32mALL CORE TESTS PASSED\x1b[0m' : `\x1b[31m${failures} FAILURE(S)\x1b[0m`));
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error('\n\x1b[31mTEST CRASHED:\x1b[0m', err);
  cleanup();
  process.exit(1);
});

function testDiscovery() {
  return new Promise((resolve) => {
    const common = { multicastAddr: '224.0.0.171', port: 53400 };
    const a = new Discovery({ self: { id: 'disc-a', name: 'A', port: 1, fingerprint: 'fa', os: 'Windows' }, ...common });
    const b = new Discovery({ self: { id: 'disc-b', name: 'B', port: 2, fingerprint: 'fb', os: 'Linux' }, ...common });
    let done = false;
    const finish = (found) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { a.stop(); b.stop(); } catch (_) {}
      if (found) ok('two instances discovered each other over multicast');
      else console.log('  \x1b[33m~ skipped: no multicast in this environment (fine on a real LAN)\x1b[0m');
      resolve();
    };
    const check = () => {
      const aSeesB = a.getPeers().some((p) => p.id === 'disc-b');
      const bSeesA = b.getPeers().some((p) => p.id === 'disc-a');
      if (aSeesB && bSeesA) finish(true);
    };
    a.on('peers', check);
    b.on('peers', check);
    a.on('error', () => {});
    b.on('error', () => {});
    a.start();
    b.start();
    const timer = setTimeout(() => finish(false), 4000);
  });
}

function cleanup() {
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (_) {}
}
