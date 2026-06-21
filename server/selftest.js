'use strict';
// Spins up the relay, connects two fake clients (Alice + Bob), and checks that
// a message addressed Alice->Bob by CODE is delivered. Exits non-zero on failure.
const { spawn } = require('child_process');
const WebSocket = require('ws');

const srv = spawn('node', [__dirname + '/index.js'], { env: { ...process.env, PORT: '8099' } });
srv.stdout.on('data', d => process.stdout.write('[srv] ' + d));
srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));

function client(code, deviceId, name) {
  const ws = new WebSocket('ws://127.0.0.1:8099');
  ws.on('open', () => ws.send(JSON.stringify({ type: 'register', code, deviceId, name })));
  return ws;
}

function fail(msg) { console.error('FAIL:', msg); srv.kill(); process.exit(1); }

setTimeout(() => {
  const alice = client('AAAA-1111', 'dev-alice', 'Alice');
  const bob = client('BOBB-2222', 'dev-bob', 'Bob');
  let aliceReg = false, bobReg = false, delivered = false, offlineSeen = false;

  alice.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'registered') { aliceReg = true; }
    if (m.type === 'peer-offline') { offlineSeen = true; console.log('OK: offline detection works'); }
  });
  bob.on('message', d => {
    const m = JSON.parse(d);
    if (m.type === 'registered') bobReg = true;
    if (m.type === 'from') {
      if (m.from === 'AAAA-1111' && m.payload && m.payload.text === 'hello bob') {
        delivered = true;
        console.log('OK: Alice->Bob by code delivered, fromName =', m.fromName);
      }
    }
  });

  // after both register, Alice messages Bob by code, then messages an offline code
  setTimeout(() => {
    if (!aliceReg || !bobReg) fail('registration did not complete');
    alice.send(JSON.stringify({ type: 'to', to: 'bobb-2222', payload: { text: 'hello bob' } }));
    alice.send(JSON.stringify({ type: 'to', to: 'ZZZZ-9999', payload: { text: 'nobody' }, ref: 'x' }));
  }, 400);

  setTimeout(() => {
    if (delivered && offlineSeen) { console.log('ALL PASS'); srv.kill(); process.exit(0); }
    fail(`delivered=${delivered} offlineSeen=${offlineSeen}`);
  }, 1200);
}, 600);
