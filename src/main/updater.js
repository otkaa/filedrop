'use strict';

const { EventEmitter } = require('events');
const { app } = require('electron');

let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
} catch (_) {
  autoUpdater = null;
}

const CHECK_INTERVAL = 6 * 60 * 60 * 1000; // re-check every 6 hours

/**
 * Thin wrapper around electron-updater.
 *
 * Flow matches the user's intent: check -> notify "update available" ->
 * user clicks Update -> download (progress) -> relaunch on the new version.
 *
 * Only active in a PACKAGED build with a publish feed (GitHub Releases). In dev
 * (`npm start`) it reports state 'disabled' and does nothing.
 */
class Updater extends EventEmitter {
  constructor() {
    super();
    this.state = { state: app.isPackaged && autoUpdater ? 'idle' : 'disabled', version: null, percent: 0, error: null };
    this._wired = false;
    this._installAfter = false;
    this._timer = null;
    this._initTimer = null;
  }

  get enabled() {
    return !!autoUpdater && app.isPackaged;
  }

  start() {
    if (!this.enabled) return;
    this._wire();
    this._initTimer = setTimeout(() => this.check(false), 8000);
    if (this._initTimer.unref) this._initTimer.unref();
    this._timer = setInterval(() => this.check(false), CHECK_INTERVAL);
    if (this._timer.unref) this._timer.unref();
  }

  _wire() {
    if (this._wired) return;
    this._wired = true;
    autoUpdater.autoDownload = false; // wait for the user to click
    autoUpdater.autoInstallOnAppQuit = true; // also apply on next normal quit

    autoUpdater.on('checking-for-update', () => this._set({ state: 'checking', error: null }));
    autoUpdater.on('update-available', (info) => {
      this._set({ state: 'available', version: info && info.version });
      this.emit('available', info);
    });
    autoUpdater.on('update-not-available', () => this._set({ state: 'none' }));
    autoUpdater.on('download-progress', (p) =>
      this._set({ state: 'downloading', percent: Math.round((p && p.percent) || 0) })
    );
    autoUpdater.on('update-downloaded', (info) => {
      this._set({ state: 'downloaded', version: info && info.version });
      this.emit('downloaded', info);
      if (this._installAfter) this.install();
    });
    autoUpdater.on('error', (err) => this._set({ state: 'error', error: cleanErr(err) }));
  }

  check(manual) {
    if (!this.enabled) {
      if (manual) this._set({ state: 'disabled' });
      return;
    }
    autoUpdater.checkForUpdates().catch((err) => this._set({ state: 'error', error: cleanErr(err) }));
  }

  /** Download the available update; when done, optionally relaunch into it. */
  download(installWhenDone) {
    if (!this.enabled) return;
    this._installAfter = !!installWhenDone;
    this._set({ state: 'downloading', percent: 0 });
    autoUpdater.downloadUpdate().catch((err) => this._set({ state: 'error', error: cleanErr(err) }));
  }

  install() {
    if (!this.enabled) return;
    try {
      autoUpdater.quitAndInstall(false, true); // not-silent, force-run-after
    } catch (_) {}
  }

  _set(partial) {
    this.state = Object.assign({}, this.state, partial);
    this.emit('status', this.state);
  }
}

function cleanErr(err) {
  const raw = (err && err.message) || String(err || 'update error');
  const m = raw.toLowerCase();
  // No repo / no release published yet -> not an error the user caused.
  if (/404|not found|no published|cannot find|unable to find|latest\.yml|releases\/latest/.test(m)) {
    return 'No update server set up yet — see the README to enable updates';
  }
  if (/enotfound|econnrefused|etimedout|getaddrinfo|network|socket hang|eai_again|dns/.test(m)) {
    return "Couldn't reach the update server (no internet?)";
  }
  return raw.split('\n')[0].slice(0, 140);
}

module.exports = { Updater };
