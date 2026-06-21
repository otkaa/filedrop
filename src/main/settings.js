'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/**
 * Simple JSON-backed settings store. No native deps.
 * One instance is created in main.js with the Electron userData dir.
 */
class Settings {
  constructor(filePath, seed = {}) {
    this.filePath = filePath;
    this.data = Object.assign(this.defaults(), seed);
    this._load();
  }

  defaults() {
    return {
      // identity (generated once, then persisted)
      deviceId: crypto.randomUUID(),
      deviceName: os.hostname() || 'My Device',

      // internet relay code (8 chars, generated once then persisted forever).
      // null here; generated + persisted on first load (see _load).
      relayCode: null,

      // where received files land (overridden by main with app downloads path)
      downloadFolder: path.join(os.homedir(), 'Downloads'),

      // networking
      httpsPort: 53319, // file transfer (HTTPS)
      discoveryPort: 53318, // UDP multicast discovery
      multicastAddr: '224.0.0.168',

      // behaviour
      autoStart: false,
      hideIps: true, // hide IP addresses in the UI (show names only)
      stealth: false, // invisible mode: don't announce our presence
      theme: 'system', // 'system' | 'dark' | 'light'

      // notifications (all on by default)
      notifyMessages: true, // show an OS toast for an incoming chat message
      soundMessages: true, // play the custom "ding" for an incoming chat message
      notifyCalls: true, // show the click-to-answer toast for an incoming call
      soundCalls: true, // play the looping ring tone for an incoming call

      // manually-added addresses (host:port), persisted + auto-reconnected.
      // This is what makes the app usable over a VPN, where LAN discovery fails.
      savedPeers: [], // [{ host, port, name }]
    };
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        // merge persisted values over defaults so new keys get defaults
        this.data = Object.assign(this.defaults(), this.data, raw);
        // generate + persist the relay code once if missing (e.g. upgrade from
        // a build that predates the relay feature).
        if (!this.data.relayCode) {
          this.data.relayCode = genRelayCode();
          this._save();
        }
      } else {
        if (!this.data.relayCode) this.data.relayCode = genRelayCode();
        this._save(); // write initial file (also persists the generated id/name/code)
      }
    } catch (err) {
      // corrupt file — start fresh but keep a backup
      try {
        fs.renameSync(this.filePath, this.filePath + '.bak');
      } catch (_) {}
      if (!this.data.relayCode) this.data.relayCode = genRelayCode();
      this._save();
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      // non-fatal; settings just won't persist
      // eslint-disable-next-line no-console
      console.error('[settings] failed to save:', err.message);
    }
  }

  get all() {
    return Object.assign({}, this.data);
  }

  get(key) {
    return this.data[key];
  }

  /** Merge a partial object, persist, return the full settings. */
  update(partial) {
    this.data = Object.assign({}, this.data, partial || {});
    this._save();
    return this.all;
  }
}

// Relay-code alphabet: no I/L/O/0/1 so codes are unambiguous when read aloud or
// typed. 8 chars, generated with a secure RNG, persisted forever.
const RELAY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function genRelayCode() {
  const n = RELAY_ALPHABET.length;
  // rejection sampling for an unbiased pick from the alphabet
  let out = '';
  while (out.length < 8) {
    const buf = crypto.randomBytes(8);
    for (let i = 0; i < buf.length && out.length < 8; i++) {
      const x = buf[i];
      if (x < 256 - (256 % n)) out += RELAY_ALPHABET[x % n];
    }
  }
  return out;
}

module.exports = { Settings, genRelayCode, RELAY_ALPHABET };
