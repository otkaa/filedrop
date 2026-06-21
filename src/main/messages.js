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
    const list = this.data[peerId] ? this.data[peerId].slice() : [];
    // Backward-compat: messages stored before receipts existed have no status.
    // An outgoing message we managed to store was at least handed off, so treat
    // a missing status as 'sent' (a single ✓) rather than leaving it blank.
    return list.map((m) => (m && m.dir === 'out' && !m.status ? { ...m, status: 'sent' } : m));
  }

  /**
   * Set the status of a single outgoing message (found by its id) to `status`,
   * but only when its current status is in `fromStatuses` (so a stale ack can't
   * walk a message backwards, e.g. delivered -> sent). Returns true if changed.
   */
  setStatusById(peerId, id, status, fromStatuses) {
    if (!peerId || !id) return false;
    const list = this.data[peerId];
    if (!list) return false;
    for (const m of list) {
      if (m && m.dir === 'out' && m.id === id) {
        const cur = m.status || 'sent';
        if (fromStatuses && !fromStatuses.includes(cur)) return false;
        if (cur === status) return false;
        m.status = status;
        this._save();
        return true;
      }
    }
    return false;
  }

  /**
   * Mark EVERY outgoing message to a peer whose current status is in
   * `fromStatuses` as `status` (used for a "read everything" ack, which carries
   * no id). Returns true if any message changed.
   */
  setStatusAll(peerId, status, fromStatuses) {
    if (!peerId) return false;
    const list = this.data[peerId];
    if (!list) return false;
    let changed = false;
    for (const m of list) {
      if (!m || m.dir !== 'out') continue;
      const cur = m.status || 'sent';
      if (fromStatuses && !fromStatuses.includes(cur)) continue;
      if (cur === status) continue;
      m.status = status;
      changed = true;
    }
    if (changed) this._save();
    return changed;
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
