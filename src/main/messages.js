'use strict';

const fs = require('fs');
const path = require('path');

const MAX_PER_PEER = 500;

/** JSON-backed chat history, keyed by peer id. */
class MessageStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {}; // peerId -> [{ dir:'in'|'out', text, ts }]
    this._saveTimer = null;
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) || {};
      }
    } catch (_) {
      this.data = {};
    }
  }

  _save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data));
      } catch (_) {}
    }, 400);
    this._saveTimer.unref && this._saveTimer.unref();
  }

  add(peerId, msg) {
    if (!peerId) return msg;
    const list = this.data[peerId] || (this.data[peerId] = []);
    list.push(msg);
    if (list.length > MAX_PER_PEER) list.splice(0, list.length - MAX_PER_PEER);
    this._save();
    return msg;
  }

  get(peerId) {
    return this.data[peerId] ? this.data[peerId].slice() : [];
  }

  /** Every peer id that has stored history (used to rehydrate peers on launch). */
  peerIds() {
    return Object.keys(this.data);
  }

  /** Map of peerId -> { last, unreadHint } for list badges (unread tracked in main). */
  lastByPeer() {
    const out = {};
    for (const id of Object.keys(this.data)) {
      const list = this.data[id];
      out[id] = list[list.length - 1] || null;
    }
    return out;
  }

  clear(peerId) {
    delete this.data[peerId];
    this._save();
  }
}

module.exports = { MessageStore };
