'use strict';

const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');
const { ipv4Interfaces } = require('./netinfo');

const PROTOCOL = 'filedrop/1';
const ANNOUNCE_INTERVAL = 3000; // ms between multicast announces
const PEER_TIMEOUT = 12000; // ms without an announce before a peer is "lost"
const PRUNE_INTERVAL = 4000;

/**
 * LAN peer discovery over UDP multicast.
 *
 * Each instance periodically multicasts a small JSON "announce" describing
 * itself (id, name, transfer port, TLS fingerprint). Peers are keyed by id and
 * their IP is taken from the packet source (never self-reported), which keeps
 * things correct across multiple network interfaces.
 *
 * Stealth mode: we keep *listening* (so we can still see others and send to
 * them) but never announce or reply, so nobody discovers us.
 */
class Discovery extends EventEmitter {
  constructor({ self, multicastAddr, port }) {
    super();
    this.self = self; // { id, name, port, fingerprint, os, version }
    this.multicastAddr = multicastAddr;
    this.port = port;
    this.stealth = false;
    this.peers = new Map(); // id -> peer
    this.socket = null;
    this._announceTimer = null;
    this._pruneTimer = null;
  }

  start() {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;

    socket.on('error', (err) => {
      this.emit('error', err);
    });

    socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));

    socket.bind(this.port, () => {
      try {
        socket.setMulticastTTL(1); // stay on the local subnet
        socket.setMulticastLoopback(true);
        this._addMembershipAllInterfaces();
      } catch (err) {
        this.emit('error', err);
      }
      // announce immediately + ask others to reveal themselves
      this._send('discover');
      this._send('announce');
      this._announceTimer = setInterval(() => {
        if (!this.stealth) this._send('announce');
      }, ANNOUNCE_INTERVAL);
    });

    this._pruneTimer = setInterval(() => this._prune(), PRUNE_INTERVAL);
  }

  stop() {
    clearInterval(this._announceTimer);
    clearInterval(this._pruneTimer);
    // polite goodbye so peers drop us promptly
    try {
      if (this.socket && !this.stealth) this._send('bye');
    } catch (_) {}
    try {
      this.socket && this.socket.close();
    } catch (_) {}
    this.socket = null;
  }

  setSelf(partial) {
    Object.assign(this.self, partial);
    if (!this.stealth) this._send('announce');
  }

  setStealth(on) {
    this.stealth = !!on;
    if (this.stealth) {
      // tell peers to forget us now
      try {
        this._send('bye');
      } catch (_) {}
    } else {
      this._send('announce');
    }
  }

  getPeers() {
    return Array.from(this.peers.values()).map((p) => ({
      id: p.id,
      name: p.name,
      ip: p.ip,
      port: p.port,
      fingerprint: p.fingerprint,
      os: p.os,
      version: p.version,
      lastSeen: p.lastSeen,
    }));
  }

  // --- internals -------------------------------------------------------------

  _addMembershipAllInterfaces() {
    // Join the multicast group on every IPv4 interface we can find, so
    // discovery works regardless of which NIC the user is on.
    let joinedAny = false;
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          try {
            this.socket.addMembership(this.multicastAddr, ni.address);
            joinedAny = true;
          } catch (_) {
            // some interfaces refuse membership; ignore
          }
        }
      }
    }
    if (!joinedAny) {
      // fall back to the default interface
      try {
        this.socket.addMembership(this.multicastAddr);
      } catch (_) {}
    }
  }

  _packet(type) {
    return Buffer.from(
      JSON.stringify({
        proto: PROTOCOL,
        type,
        id: this.self.id,
        name: this.self.name,
        port: this.self.port,
        fingerprint: this.self.fingerprint,
        os: this.self.os,
        version: this.self.version,
      })
    );
  }

  _send(type, addr) {
    if (!this.socket) return;
    if (this.stealth && type !== 'bye') return; // stealth: never reveal ourselves
    const pkt = this._packet(type);

    if (addr) {
      // direct unicast reply to a specific peer
      this.socket.send(pkt, 0, pkt.length, this.port, addr);
      return;
    }

    // Multicast out EVERY interface, not just the default one. With a VPN as
    // the default route, a single multicast send would only egress the tunnel;
    // sending per-interface keeps announcements reaching the real LAN too.
    const ifaces = ipv4Interfaces();
    if (!ifaces.length) {
      this.socket.send(pkt, 0, pkt.length, this.port, this.multicastAddr);
      return;
    }
    for (const ni of ifaces) {
      try {
        this.socket.setMulticastInterface(ni.address);
        this.socket.send(pkt, 0, pkt.length, this.port, this.multicastAddr);
      } catch (_) {
        // some interfaces refuse to be a multicast egress; skip them
      }
    }
  }

  _onMessage(buf, rinfo) {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (_) {
      return;
    }
    if (!msg || msg.proto !== PROTOCOL || !msg.id) return;
    if (msg.id === this.self.id) return; // ignore ourselves (loopback)

    if (msg.type === 'bye') {
      if (this.peers.delete(msg.id)) this.emit('peers');
      return;
    }

    // Validate untrusted fields from the packet. The port is later used in
    // https.request, so a non-integer/out-of-range value would only ever
    // produce confusing send failures — drop the announce instead of storing it.
    const port = Number(msg.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;

    const existing = this.peers.get(msg.id);
    const peer = {
      id: msg.id,
      name: typeof msg.name === 'string' && msg.name.trim() ? msg.name.slice(0, 64) : 'Unknown device',
      ip: rinfo.address,
      port,
      fingerprint: typeof msg.fingerprint === 'string' ? msg.fingerprint.slice(0, 128) : undefined,
      os: typeof msg.os === 'string' ? msg.os.slice(0, 32) : undefined,
      version: typeof msg.version === 'string' ? msg.version.slice(0, 16) : undefined,
      lastSeen: Date.now(),
    };
    this.peers.set(msg.id, peer);

    const changed =
      !existing ||
      existing.name !== peer.name ||
      existing.ip !== peer.ip ||
      existing.port !== peer.port ||
      existing.fingerprint !== peer.fingerprint;
    if (changed) this.emit('peers');

    // Someone is probing (or just appeared) — reply directly so they learn
    // about us quickly, unless we're hiding.
    if ((msg.type === 'discover' || !existing) && !this.stealth) {
      this._send('announce', rinfo.address);
    }
  }

  _prune() {
    const now = Date.now();
    let removed = false;
    for (const [id, p] of this.peers) {
      if (now - p.lastSeen > PEER_TIMEOUT) {
        this.peers.delete(id);
        removed = true;
      }
    }
    if (removed) this.emit('peers');
  }
}

module.exports = { Discovery };
