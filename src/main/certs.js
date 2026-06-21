'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

/**
 * Load (or generate on first run) a self-signed TLS certificate.
 * The SHA-256 fingerprint is advertised over discovery and pinned by the
 * sender, so a self-signed cert is safe against MITM on the LAN.
 */
function loadOrCreate(dir, deviceName) {
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');

  let key;
  let cert;

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    key = fs.readFileSync(keyPath, 'utf8');
    cert = fs.readFileSync(certPath, 'utf8');
  } else {
    const attrs = [{ name: 'commonName', value: 'filedrop-' + sanitizeCN(deviceName) }];
    const pems = selfsigned.generate(attrs, {
      keySize: 2048,
      days: 3650,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    });
    key = pems.private;
    cert = pems.cert;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
    fs.writeFileSync(certPath, cert);
  }

  return { key, cert, fingerprint: fingerprintOf(cert) };
}

/** SHA-256 over the DER bytes, lowercase hex, no separators. */
function fingerprintOf(certPem) {
  const der = pemToDer(certPem);
  return crypto.createHash('sha256').update(der).digest('hex');
}

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  return Buffer.from(b64, 'base64');
}

/** Normalize a Node tls fingerprint256 ("AB:CD:..") to compare with ours. */
function normalize(fp) {
  return String(fp || '').replace(/:/g, '').toLowerCase();
}

function sanitizeCN(name) {
  return String(name || 'device').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) || 'device';
}

module.exports = { loadOrCreate, fingerprintOf, normalize };
