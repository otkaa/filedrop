'use strict';

const os = require('os');

/** Non-internal IPv4 interfaces: [{ name, address, netmask }]. */
function ipv4Interfaces() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) {
        out.push({ name, address: ni.address, netmask: ni.netmask });
      }
    }
  }
  return out;
}

function ipToInt(ip) {
  const p = String(ip).split('.');
  return ((((+p[0] || 0) * 256 + (+p[1] || 0)) * 256 + (+p[2] || 0)) * 256 + (+p[3] || 0));
}

function maskBits(mask) {
  let n = ipToInt(mask) >>> 0;
  let c = 0;
  while (n) {
    c += n & 1;
    n >>>= 1;
  }
  return c;
}

/**
 * The local source IP that shares a subnet with `dest`, or null.
 *
 * Used to bind outbound LAN connections to the LAN interface so they keep
 * working when a full-tunnel VPN has taken over the default route. If no local
 * subnet matches (e.g. dest is a VPN-only or public address), returns null and
 * the OS routing table decides (correctly sending VPN traffic down the tunnel).
 */
function sourceAddressFor(dest) {
  if (!dest) return null;
  const d = ipToInt(dest);
  let best = null;
  let bestBits = -1;
  for (const ni of ipv4Interfaces()) {
    const mask = ipToInt(ni.netmask || '255.255.255.0');
    if (((d & mask) >>> 0) === ((ipToInt(ni.address) & mask) >>> 0)) {
      const bits = maskBits(ni.netmask || '255.255.255.0');
      if (bits > bestBits) {
        bestBits = bits;
        best = ni.address;
      }
    }
  }
  return best;
}

/** Heuristic: does this interface look like a VPN adapter? */
function looksVpn(name, ip) {
  if (/tun|tap|\bwg\b|wire|tailscale|zerotier|\bzt\d|nord|proton|mullvad|vpn|ppp|wintun/i.test(name)) return true;
  const p = String(ip).split('.').map(Number);
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT (Tailscale et al.)
  return false;
}

module.exports = { ipv4Interfaces, sourceAddressFor, looksVpn };
