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
      } else {
        this._save(); // write initial file (also persists the generated id/name)
      }
    } catch (err) {
      // corrupt file — start fresh but keep a backup
      try {
        fs.renameSync(this.filePath, this.filePath + '.bak');
      } catch (_) {}
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

module.exports = { Settings };
