'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { ipv4Interfaces, looksVpn } = require('./netinfo');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  dialog,
  shell,
  screen,
  session,
  desktopCapturer,
  clipboard,
  nativeImage,
  Notification,
} = require('electron');

const { Settings, genRelayCode, RELAY_ALPHABET } = require('./settings');
const certs = require('./certs');
const { Discovery } = require('./discovery');
const { ReceiveServer } = require('./server');
const { sendFiles, probe, postJson } = require('./sender');
const { MessageStore } = require('./messages');
const { Updater } = require('./updater');
const { RelayClient, normCode, formatCode } = require('./relay');
const autostart = require('./autostart');

const VERSION = require('../../package.json').version;
const ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.png');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');

let settings;
let tray = null;
let win = null;
let discovery = null;
let server = null;
let self = null;
let messages = null;
let updater = null;
let relay = null; // internet rendezvous/relay client (additive; LAN unchanged)

const transfers = new Map(); // id -> transfer update
const pendingRequests = new Map(); // id -> { resolve, timer, data }
const manualPeers = new Map(); // id -> peer (added by address)
const relayPeers = new Map(); // code (id) -> relay-only peer { id, name, relay:true, relayCode }
const transferToController = new Map(); // outgoing transferId -> AbortController
const unread = new Map(); // peerId -> unread message count
const lastNotify = new Map(); // peerId -> ts of last chat notification (throttle)
let activeConvo = null; // peerId the renderer currently has open, or null

// WhatsApp-style receipts (relay peers only):
// - relayOutbox queues messages composed while the relay is down ('pending');
//   they flush + flip to 'sent' on the next 'ready' (re-register).
// - outgoingById indexes our own sent messages by their wire id so an inbound
//   {k:'ack', ack:'delivered', id} can find the right bubble to update.
const relayOutbox = []; // [{ peerId, code, text, ts, id }] awaiting a connected relay
const outgoingById = new Map(); // id -> { peerId } for fast ack -> message lookup

// calls
let callWindow = null;
let activeCall = null; // { callId, peer, role, remoteEnded, answered }
let pendingIncoming = null; // { callId, peer, offerSdp } awaiting accept
let pendingCallInit = null; // payload the call window pulls on load
let pendingIncomingTimer = null; // auto-expire an unanswered incoming ring
let activeCallTimer = null; // caller-side answer timeout
const lastRing = new Map(); // peerId -> ts of last incoming ring (throttle)
let ringWindow = null; // hidden, focus-less window that plays the incoming ring tone
let incomingNotification = null; // the click-to-answer OS notification for the current ring
let soundWindow = null; // ONE persistent hidden window that plays short notification sounds (the custom message ding)

let pushTimer = null;
const startedHidden = process.argv.includes('--hidden');
const SMOKE = process.env.FILEDROP_SMOKE === '1'; // headless self-check, then quit

// ---------------------------------------------------------------------------
// Single instance
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init).catch((err) => {
    dialog.showErrorBox('Filedrop failed to start', String(err && err.stack ? err.stack : err));
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  // On Windows, desktop notifications silently fail to appear unless the app's
  // AppUserModelID is set to match the installed shortcut's AUMID. Without this,
  // `new Notification(...).show()` is a no-op for chat/call/file alerts. Must be
  // set before any Notification is constructed.
  if (process.platform === 'win32') {
    try {
      app.setAppUserModelId('com.kavelashvili.filedrop');
    } catch (_) {}
  }

  const userData = app.getPath('userData');

  settings = new Settings(path.join(userData, 'settings.json'), {
    downloadFolder: defaultDownloadDir(),
  });

  // ensure download folder exists
  try {
    fs.mkdirSync(settings.get('downloadFolder'), { recursive: true });
  } catch (_) {}

  const tls = certs.loadOrCreate(userData, settings.get('deviceName'));

  messages = new MessageStore(path.join(userData, 'messages.json'));
  // recreate code-peer rows for conversations that persisted across a restart,
  // so they show in the Devices list on launch (history is keyed by code)
  rehydrateRelayPeers();

  self = {
    id: settings.get('deviceId'),
    name: settings.get('deviceName'),
    os: platformLabel(),
    version: VERSION,
    fingerprint: tls.fingerprint,
  };

  // --- receive server ---
  server = new ReceiveServer({
    tls,
    getSettings: () => settings.all,
    requestApproval,
    self,
  });
  server.on('transfer', upsertTransfer);
  server.on('message', onIncomingMessage);
  server.on('signal', onIncomingSignal);
  const port = await startServerWithFallback(settings.get('httpsPort'), SMOKE ? '127.0.0.1' : undefined);
  self.port = port;
  if (port !== settings.get('httpsPort')) settings.update({ httpsPort: port });

  // --- discovery ---
  discovery = new Discovery({
    self: {
      id: self.id,
      name: self.name,
      port,
      fingerprint: tls.fingerprint,
      os: self.os,
      version: VERSION,
    },
    multicastAddr: settings.get('multicastAddr'),
    port: settings.get('discoveryPort'),
  });
  discovery.on('peers', () => {
    pushState();
  });
  discovery.on('error', (err) => console.error('[discovery]', err.message));
  discovery.setStealth(settings.get('stealth'));
  if (!SMOKE) discovery.start(); // skip LAN broadcast during the smoke self-check

  // --- internet relay (additive; LAN behavior is untouched) ---
  // One outbound WebSocket to the rendezvous server. Registers our persistent
  // code, auto-reconnects, and carries chat + call signaling to relay-only peers.
  if (!SMOKE) setupRelay(tls);

  // sync autostart with the real OS state on launch
  settings.update({ autoStart: autostart.isEnabled() });

  if (!SMOKE) setupMediaPermissions();

  createTray();
  createWindow();
  if (!SMOKE) createSoundWindow(); // persistent hidden WebAudio window for the message ding
  wireIpc();

  if (SMOKE) {
    runSmokeTest(port);
    return;
  }

  setupUpdater();
  startSavedReconnect();

  if (!startedHidden) {
    // Per the design the app lives in the tray; we still keep the window
    // hidden on a normal launch. Users open it from the tray.
  }
}

/**
 * Headless self-check (FILEDROP_SMOKE=1): confirm the full Electron stack came
 * up — tray, window, preload bridge, renderer DOM — then quit. No network.
 */
function runSmokeTest(port) {
  const results = { port, tray: !!tray, window: !!win };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    const okRenderer = typeof results.renderer === 'string' && results.renderer.startsWith('api|');
    const okCall = results.call === 'callwin-ok';
    const pass = results.tray && results.window && okRenderer && okCall;
    console.log('SMOKE_RESULT ' + JSON.stringify(results));
    console.log(pass ? 'SMOKE_PASS' : 'SMOKE_FAIL');
    setTimeout(() => doQuit(), 50);
  };

  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) console.log('SMOKE panel-console:', msg);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    results.renderer = 'RENDER_GONE:' + d.reason;
    finish();
  });

  win.webContents.once('did-finish-load', async () => {
    try {
      results.renderer = await win.webContents.executeJavaScript(
        '(()=>{try{return (window.filedrop?"api":"noapi")+"|"+document.querySelectorAll(".tab").length+"tabs|"+(document.getElementById("chat-input")?"chat":"nochat")+"|"+(document.querySelector("#my-addresses button")?"addr":"noaddr");}catch(e){return "ERR:"+e.message;}})()'
      );
    } catch (err) {
      results.renderer = 'EXEC_ERR:' + err.message;
    }
    // also verify the call window renderer loads cleanly (WebRTC UI)
    try {
      const cw = new BrowserWindow({
        show: false,
        webPreferences: { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false },
      });
      cw.webContents.on('console-message', (_e, level, msg) => {
        if (level >= 2) console.log('SMOKE call-console:', msg);
      });
      cw.webContents.once('did-finish-load', async () => {
        try {
          results.call = await cw.webContents.executeJavaScript(
            '(()=>{try{return (window.filedrop&&document.getElementById("btn-hangup")&&typeof RTCPeerConnection!=="undefined")?"callwin-ok":"callwin-bad";}catch(e){return "ERR:"+e.message;}})()'
          );
        } catch (err) {
          results.call = 'CALL_ERR:' + err.message;
        }
        finish();
      });
      cw.loadFile(path.join(__dirname, '..', 'renderer', 'call.html'));
    } catch (err) {
      results.call = 'CALL_CREATE_ERR:' + err.message;
      finish();
    }
  });

  setTimeout(finish, 15000);
}

// ---------------------------------------------------------------------------
// Window + Tray
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 440,
    height: 660,
    show: false,
    frame: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    skipTaskbar: true,
    backgroundColor: '#0f1115',
    icon: fileIcon(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Closing the panel only hides it to the tray — the app keeps running and an
  // in-progress call (which lives in its own callWindow) is NOT torn down. Only
  // an explicit Quit (app.isQuitting) actually destroys the window.
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Filedrop');
  rebuildTrayMenu();
  // Left-click toggles the panel (Windows/macOS). Linux usually only opens the
  // context menu, so "Open Filedrop" is in the menu too.
  tray.on('click', (_e, bounds) => toggleWindow(bounds));
}

function rebuildTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open Filedrop', click: () => showWindow() },
    { label: 'Send a file…', click: () => quickSend() },
    { type: 'separator' },
    {
      label: settings && settings.get('stealth') ? '🚫 Stealth: ON' : '👁  Visible on network',
      enabled: false,
    },
    { type: 'separator' },
    { label: 'Quit Filedrop', click: () => doQuit() },
  ]);
  tray.setContextMenu(menu);
}

function toggleWindow(trayBounds) {
  if (!win) return;
  if (win.isVisible() && win.isFocused()) {
    win.hide();
  } else {
    showWindow(trayBounds);
  }
}

function showWindow(trayBounds) {
  if (!win) return;
  positionWindow(trayBounds);
  win.show();
  win.focus();
}

function positionWindow(trayBounds) {
  try {
    const [w, h] = win.getSize();
    const display = trayBounds && trayBounds.width
      ? screen.getDisplayMatching(trayBounds)
      : screen.getPrimaryDisplay();
    const area = display.workArea;
    let x = area.x + area.width - w - 8;
    let y = area.y + area.height - h - 8;
    if (trayBounds && trayBounds.width) {
      x = Math.round(trayBounds.x + trayBounds.width / 2 - w / 2);
      x = Math.min(Math.max(area.x + 4, x), area.x + area.width - w - 4);
    }
    win.setPosition(Math.round(x), Math.round(y), false);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
function wireIpc() {
  ipcMain.handle('get-state', () => buildState());

  ipcMain.handle('update-settings', (_e, partial) => {
    const before = settings.all;
    const next = settings.update(sanitizeSettings(partial));

    if (partial && 'deviceName' in partial && next.deviceName !== before.deviceName) {
      self.name = next.deviceName;
      discovery && discovery.setSelf({ name: next.deviceName });
      relay && relay.setName(next.deviceName);
    }
    if (partial && 'stealth' in partial && next.stealth !== before.stealth) {
      discovery && discovery.setStealth(next.stealth);
      rebuildTrayMenu();
    }
    if (partial && 'autoStart' in partial && next.autoStart !== before.autoStart) {
      const ok = autostart.setEnabled(next.autoStart);
      if (!ok) settings.update({ autoStart: autostart.isEnabled() });
    }
    pushState();
    return settings.all;
  });

  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose files to send',
      properties: ['openFile', 'multiSelections'],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('send-files', (_e, { deviceId, paths }) => startSend(deviceId, paths));

  ipcMain.handle('cancel-transfer', (_e, transferId) => {
    const ctrl = transferToController.get(transferId);
    if (ctrl) ctrl.abort();
    return true;
  });

  ipcMain.handle('respond-request', (_e, { id, accept }) => {
    respondRequest(id, accept);
    return true;
  });

  ipcMain.handle('pick-download-folder', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to save received files',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: settings.get('downloadFolder'),
    });
    if (r.canceled || !r.filePaths[0]) return settings.all;
    settings.update({ downloadFolder: r.filePaths[0] });
    pushState();
    return settings.all;
  });

  ipcMain.handle('open-download-folder', () => shell.openPath(settings.get('downloadFolder')));
  ipcMain.handle('open-path', (_e, p) => {
    if (p) shell.showItemInFolder(p);
  });

  ipcMain.handle('add-device', async (_e, { host, port }) => {
    const p = Number(port) || settings.get('httpsPort');
    try {
      const peer = await probe(host, p);
      if (peer.id === self.id) throw new Error('That is this device');
      const savedKey = `${host}:${p}`;
      manualPeers.set(peer.id, { ...peer, savedKey, lastSeen: Date.now() });
      saveAddress(host, p, peer.name);
      pushState();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('remove-saved', (_e, { host, port }) => {
    removeSavedAddress(host, Number(port));
    pushState();
  });

  // add a peer over the internet by their relay code
  ipcMain.handle('add-by-code', (_e, code) => addByCode(code));

  ipcMain.handle('copy-text', (_e, text) => {
    try {
      clipboard.writeText(String(text || ''));
    } catch (_) {}
  });

  ipcMain.handle('clear-finished', () => {
    for (const [id, t] of transfers) {
      if (['done', 'declined', 'error', 'canceled'].includes(t.status)) transfers.delete(id);
    }
    pushState();
  });

  ipcMain.handle('hide-window', () => win && win.hide());
  ipcMain.handle('quit', () => doQuit());

  // --- chat ---
  ipcMain.handle('get-messages', (_e, peerId) => {
    activeConvo = peerId;
    unread.set(peerId, 0);
    // Opening a chat = "I've read everything". Tell a relay peer so their
    // outgoing ticks turn cyan (matches the phone's read-receipt behaviour).
    const peer = lookupPeer(peerId);
    if (relay && isRelayPeer(peer)) relay.sendTo(peer.relayCode, { k: 'ack', ack: 'read' });
    pushState();
    return messages ? messages.get(peerId) : [];
  });
  ipcMain.handle('close-convo', () => {
    activeConvo = null;
  });
  ipcMain.handle('send-message', (_e, { deviceId, text }) => sendMessage(deviceId, text));
  ipcMain.handle('clear-chat', (_e, peerId) => {
    if (messages) messages.clear(peerId);
    unread.set(peerId, 0);
    pushState();
  });

  // --- calls (panel side) ---
  ipcMain.handle('start-call', (_e, deviceId) => startCall(deviceId));
  ipcMain.handle('call-accept', () => acceptIncoming());
  ipcMain.handle('call-decline', () => declineIncoming());

  // --- calls (call-window side) ---
  ipcMain.handle('call-ready', () => pendingCallInit); // renderer pulls its init
  ipcMain.handle('rtc-out', (_e, payload) => sendSignal(payload));
  ipcMain.handle('call-ended', () => endActiveCall('renderer'));
  ipcMain.handle('desktop-sources', () => getDesktopSources());

  // --- updates ---
  ipcMain.handle('update-check', () => {
    if (updater) updater.check(true);
  });
  ipcMain.handle('update-download', () => {
    if (updater) updater.download(true); // download, then relaunch into it
  });
  ipcMain.handle('update-install', () => {
    if (updater) updater.install();
  });
}

function sanitizeSettings(partial) {
  const allowed = [
    'deviceName', 'hideIps', 'stealth', 'autoStart', 'theme',
    'notifyMessages', 'soundMessages', 'notifyCalls', 'soundCalls',
  ];
  const out = {};
  if (!partial) return out;
  for (const k of allowed) if (k in partial) out[k] = partial[k];
  if ('deviceName' in out) {
    out.deviceName = String(out.deviceName || '').trim().slice(0, 40) || self.name;
  }
  for (const b of ['hideIps', 'stealth', 'autoStart', 'notifyMessages', 'soundMessages', 'notifyCalls', 'soundCalls']) {
    if (b in out) out[b] = !!out[b];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------
async function quickSend() {
  const r = await dialog.showOpenDialog({
    title: 'Choose files to send',
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled || !r.filePaths.length) return;
  showWindow();
  // hand the chosen files to the renderer so the user can pick a device
  if (win) win.webContents.send('files-chosen', r.filePaths);
}

async function startSend(deviceId, paths) {
  const peer = lookupPeer(deviceId);
  if (!peer) return { ok: false, error: 'Device is no longer available' };
  if (!paths || !paths.length) return { ok: false, error: 'No files selected' };

  // batch-level controller (kill-switch for the whole send); each file also
  // carries its own controller via u.controller for per-row cancel.
  const batch = new AbortController();
  try {
    await sendFiles(peer, self, paths, {
      signal: batch.signal,
      onTransfer: (u) => {
        if (u.direction === 'out' && u.controller) {
          transferToController.set(u.id, u.controller);
        }
        // never serialize the AbortController to the renderer
        const { controller, ...clean } = u;
        upsertTransfer(clean);
      },
    });
    return { ok: true };
  } catch (err) {
    if (err && err.canceled) return { ok: false, error: 'Canceled' };
    return { ok: false, error: err.message || 'Transfer failed' };
  }
}

function lookupPeer(deviceId) {
  const fromDiscovery = discovery
    ? discovery.getPeers().find((p) => p.id === deviceId)
    : null;
  return fromDiscovery || manualPeers.get(deviceId) || relayPeers.get(deviceId) || null;
}

/** A peer reachable only over the relay (by code) has no ip/port. */
function isRelayPeer(peer) {
  return !!(peer && (peer.relay || peer.isRelayOnly) && peer.relayCode && !peer.ip && !peer.port);
}

// ---------------------------------------------------------------------------
// Own address + saved (manual / VPN) peers
// ---------------------------------------------------------------------------
/** This machine's reachable IPv4 addresses, labelled, LAN first then VPN. */
function localAddresses() {
  const out = ipv4Interfaces().map((ni) => ({
    address: ni.address,
    label: ni.name,
    vpn: looksVpn(ni.name, ni.address),
  }));
  out.sort((a, b) => rankAddr(a) - rankAddr(b));
  return out;
}

function rankAddr(a) {
  if (a.vpn) return 2;
  const p = a.address.split('.').map(Number);
  if (p[0] === 192 && p[1] === 168) return 0; // home LAN first
  if (p[0] === 10 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)) return 1;
  return 3;
}

function saveAddress(host, port, name) {
  const saved = (settings.get('savedPeers') || []).slice();
  const key = `${host}:${port}`;
  const entry = { host, port: Number(port), name: name || host };
  const idx = saved.findIndex((s) => `${s.host}:${s.port}` === key);
  if (idx >= 0) saved[idx] = entry;
  else saved.push(entry);
  settings.update({ savedPeers: saved });
}

function removeSavedAddress(host, port) {
  const key = `${host}:${port}`;
  const saved = (settings.get('savedPeers') || []).filter((s) => `${s.host}:${s.port}` !== key);
  settings.update({ savedPeers: saved });
  for (const [id, p] of manualPeers) if (p.savedKey === key) manualPeers.delete(id);
}

/** Re-probe every saved address so manual/VPN peers reconnect automatically. */
async function reconnectSaved() {
  if (!self) return;
  const saved = settings.get('savedPeers') || [];
  await Promise.all(
    saved.map(async (s) => {
      const key = `${s.host}:${s.port}`;
      try {
        const peer = await probe(s.host, s.port);
        if (peer.id === self.id) return; // that's us
        manualPeers.set(peer.id, { ...peer, savedKey: key, name: peer.name || s.name, lastSeen: Date.now() });
      } catch (_) {
        for (const [id, p] of manualPeers) if (p.savedKey === key) manualPeers.delete(id);
      }
    })
  );
  pushState();
}

function startSavedReconnect() {
  const first = setTimeout(() => reconnectSaved(), 3000);
  if (first.unref) first.unref();
  const loop = setInterval(() => reconnectSaved(), 20000);
  if (loop.unref) loop.unref();
}

// ---------------------------------------------------------------------------
// Comms: chat
// ---------------------------------------------------------------------------
function selfFrom() {
  return { id: self.id, name: self.name, os: self.os, port: self.port, fingerprint: self.fingerprint };
}

/** Build a reachable peer object for replying, even to a stealth/unlisted peer. */
function resolvePeer(sig) {
  const known = lookupPeer(sig.peerId);
  if (known && known.fingerprint && known.port) return known;
  if (sig.peerIp && sig.peerPort && sig.peerFingerprint) {
    return {
      id: sig.peerId,
      name: sig.peerName,
      ip: normalizeIp(sig.peerIp),
      port: Number(sig.peerPort),
      fingerprint: sig.peerFingerprint,
    };
  }
  return known || null;
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^::ffff:/, '');
}

// ---------------------------------------------------------------------------
// Internet relay (rendezvous over WebSocket) — additive transport
// ---------------------------------------------------------------------------
/**
 * Stand up the RelayClient and route its events into the SAME incoming
 * message/signal paths the LAN HTTPS server already feeds. Relay peers are
 * keyed by their CODE (not device UUID).
 */
function setupRelay(tls) {
  const code = normCode(settings.get('relayCode'));
  relay = new RelayClient({
    deviceId: self.id,
    deviceName: self.name,
    fingerprint: tls && tls.fingerprint,
    code,
  });
  // if the server says our code is taken, mint a fresh one and persist it
  relay.setRegenerate(() => {
    const next = genRelayCode();
    settings.update({ relayCode: next });
    pushState();
    return next;
  });
  relay.on('ready', () => {
    flushRelayOutbox(); // deliver anything queued while we were offline
    pushState();
  });
  relay.on('status', () => pushState());
  relay.on('message', (m) => relayOnIncomingMessage(m));
  relay.on('signal', (m) => relayOnIncomingSignal(m));
  relay.on('ack', (m) => relayOnIncomingAck(m));
  relay.on('offline', () => {});
  relay.connect();
}

/**
 * The relay (re)connected: drain any messages that were composed while it was
 * down. Each queued message is sent with its original id/ts and flips from
 * 'pending' to 'sent'. Anything that still can't be handed off (socket raced
 * closed again) stays queued for the next 'ready'.
 */
function flushRelayOutbox() {
  if (!relay || !relayOutbox.length) return;
  const pending = relayOutbox.splice(0, relayOutbox.length);
  let changed = false;
  for (const item of pending) {
    const sent = relay.sendTo(item.code, { k: 'msg', text: item.text, ts: item.ts, id: item.id });
    if (sent) {
      if (messages.setStatusById(item.peerId, item.id, 'sent', ['pending'])) changed = true;
    } else {
      relayOutbox.push(item); // still down — requeue for the next 'ready'
    }
  }
  if (changed) pushState();
}

/** Find-or-create a relay-only peer for an incoming code. */
function ensureRelayPeer(code, name) {
  const id = normCode(code);
  if (!id) return null;
  let peer = relayPeers.get(id);
  if (!peer) {
    peer = { id, name: name || id, relay: true, isRelayOnly: true, relayCode: id };
    relayPeers.set(id, peer);
    pushState();
  } else if (name && peer.name === peer.relayCode && name !== peer.relayCode) {
    // upgrade a placeholder name (the code) to the real device name once known
    peer.name = name;
    pushState();
  }
  return peer;
}

/** True if a stored peer id looks like an 8-char relay code (not a LAN UUID). */
function looksRelayCode(id) {
  if (typeof id !== 'string' || id.length !== 8) return false;
  for (const ch of id) if (!RELAY_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * On launch, recreate relay-only peers for any code we've previously chatted
 * with. Relay peers are otherwise only created when a friend messages or you
 * add them by code, so without this a saved code-conversation would vanish from
 * the Devices list after a restart (its history persists, but had no peer row).
 */
function rehydrateRelayPeers() {
  if (!messages) return;
  const myCode = normCode(settings.get('relayCode'));
  for (const id of messages.peerIds()) {
    if (!looksRelayCode(id)) continue; // LAN/manual peers reconnect their own way
    if (id === myCode) continue;
    if (!relayPeers.has(id)) {
      relayPeers.set(id, { id, name: id, relay: true, isRelayOnly: true, relayCode: id });
    }
  }
}

/** Incoming relay chat -> the same path the HTTPS server uses. */
function relayOnIncomingMessage(m) {
  const payload = m.payload || {};
  const text = typeof payload.text === 'string' ? payload.text : null;
  if (text == null) return;
  const peer = ensureRelayPeer(m.from, m.fromName);
  if (!peer) return;
  onIncomingMessage({
    peerId: peer.id,
    peerName: peer.name,
    text: text.slice(0, 8000),
    ts: Number(payload.ts) || Date.now(),
  });

  // Receipts (relay only): tell the sender we received it, and — if the user is
  // actively looking at this conversation — that we've read it. Mirrors the
  // phone, which sends the same {k:'ack', ack:'delivered'|'read'} payloads.
  const code = peer.relayCode;
  const id = typeof payload.id === 'string' ? payload.id : null;
  if (relay && code) {
    if (id) relay.sendTo(code, { k: 'ack', ack: 'delivered', id });
    const viewing = activeConvo === peer.id && win && win.isVisible() && win.isFocused();
    if (viewing) relay.sendTo(code, { k: 'ack', ack: 'read' });
  }
}

/**
 * Inbound delivery/read receipt for messages WE sent (relay only).
 *   ack:'delivered' + id -> that one message: 'sent' -> 'delivered'
 *   ack:'read' (no id)   -> every message to this peer that's 'sent'/'delivered'
 *                           becomes 'read'
 * Mutating only forward-going transitions keeps a late/duplicate ack harmless.
 */
function relayOnIncomingAck(m) {
  const payload = m.payload || {};
  const peer = ensureRelayPeer(m.from, m.fromName);
  if (!peer) return;
  let changed = false;
  if (payload.ack === 'delivered' && typeof payload.id === 'string') {
    // resolve the message by its id (the Map is authoritative for which
    // conversation it belongs to); fall back to the ack's sender code.
    const owner = outgoingById.get(payload.id);
    const peerId = owner ? owner.peerId : peer.id;
    changed = messages.setStatusById(peerId, payload.id, 'delivered', ['sent']);
  } else if (payload.ack === 'read') {
    changed = messages.setStatusAll(peer.id, 'read', ['sent', 'delivered']);
    // a "read everything" ack means none of this peer's ids need tracking anymore
    for (const [id, owner] of outgoingById) if (owner.peerId === peer.id) outgoingById.delete(id);
  }
  if (changed) {
    // refresh the open conversation's bubbles, then the list badges/state
    if (win && !win.isDestroyed()) {
      win.webContents.send('messages-updated', { peerId: peer.id, messages: messages.get(peer.id) });
    }
    pushState();
  }
}

/** Incoming relay call signaling -> the same path the HTTPS server uses. */
function relayOnIncomingSignal(m) {
  const payload = m.payload || {};
  const kind = payload.sig; // payload.sig maps directly to the existing "kind"
  const ALLOWED = new Set(['offer', 'answer', 'decline', 'busy', 'hangup']);
  // 'unreachable'/'timeout' are local-only outcomes, never sent on the wire
  if (!ALLOWED.has(kind)) return;
  const peer = ensureRelayPeer(m.from, m.fromName);
  if (!peer) return;
  const sdp = (kind === 'offer' || kind === 'answer') && typeof payload.sdp === 'string' ? payload.sdp : null;
  onIncomingSignal({
    peerId: peer.id,
    peerName: peer.name,
    kind,
    callId: payload.callId ? String(payload.callId).slice(0, 64) : null,
    sdp,
    // no ip/port/fingerprint: a relay peer is reachable only by its code
  });
}

/** Add a peer purely by their relay code (used by the "+ by code" UI). */
async function addByCode(rawCode) {
  if (!relay) return { ok: false, error: 'Relay not available' };
  const code = normCode(rawCode);
  if (code.length !== 8) return { ok: false, error: 'Enter an 8-character code' };
  if (code === normCode(settings.get('relayCode'))) {
    return { ok: false, error: 'That is your own code' };
  }
  let res;
  try {
    res = await relay.lookup(code);
  } catch (_) {
    res = { online: false };
  }
  const peer = ensureRelayPeer(code, res && res.name);
  if (!peer) return { ok: false, error: 'Invalid code' };
  pushState();
  // We add the peer even if it's currently offline (like a saved address) so
  // you can message it; it'll deliver once they come online.
  return { ok: true, online: !!(res && res.online), name: res && res.name };
}

/**
 * One incoming chat message. This is the SINGLE path for both LAN (HTTPS server)
 * and relay/code peers — relayOnIncomingMessage() funnels into here — so the
 * notification behaviour is identical for both transports.
 */
function onIncomingMessage(m) {
  messages.add(m.peerId, { dir: 'in', text: m.text, ts: m.ts });

  // "read" only if the user is actually looking at THIS conversation, focused.
  const viewing = activeConvo === m.peerId && win && win.isVisible() && win.isFocused();
  if (viewing) {
    unread.set(m.peerId, 0);
  } else {
    unread.set(m.peerId, (unread.get(m.peerId) || 0) + 1);
    notifyChat(m.peerId, m.peerName, m.text);
  }

  if (win && !win.isDestroyed()) win.webContents.send('message', { peerId: m.peerId, dir: 'in', text: m.text, ts: m.ts });
  pushState();
}

/**
 * Show an OS notification for a received chat message (title = sender, body =
 * text). Throttled to at most once per 5s per peer so message bursts don't spam.
 * Clicking it shows the window AND opens that conversation in the renderer.
 */
function notifyChat(peerId, peerName, text) {
  // Sound and toast are INDEPENDENT: you can have either, both, or neither.
  const wantSound = settings.get('soundMessages');
  const wantToast = settings.get('notifyMessages');
  if (!wantSound && !wantToast) return;
  // throttle the alert to at most once per 5s per peer so bursts don't spam
  const now = Date.now();
  const prev = lastNotify.get(peerId) || 0;
  if (now - prev <= 5000) return;
  lastNotify.set(peerId, now);
  // custom 2-note chime — gated only by the sound toggle
  if (wantSound) playDing();
  // visual toast — gated only by the notification toggle
  if (!wantToast || !Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: peerName || 'New message',
      body: String(text || '').slice(0, 120),
      icon: fileIcon(),
      // we play our own chime above, so keep Windows' default sound off
      silent: true,
    });
    n.on('click', () => openConvoFromNotification(peerId));
    n.show();
  } catch (_) {
    // notifications are best-effort; never let a failure break message handling
  }
}

/** Focus the panel and ask the renderer to open the given conversation. */
function openConvoFromNotification(peerId) {
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('open-convo', peerId);
}

async function sendMessage(deviceId, text) {
  text = String(text || '').slice(0, 8000).trim();
  if (!text) return { ok: false, error: 'Empty message' };
  const ts = Date.now();
  const id = crypto.randomUUID(); // wire id so the peer can ack THIS message
  const peer = lookupPeer(deviceId);
  // The renderer appends the outgoing bubble optimistically and updates it from
  // this return value, so we DON'T echo an unconditional "delivered" bubble.
  // Start every outgoing message at 'pending' (⏳); we promote it once it's
  // actually handed to a connected relay, and again on each receipt.
  const stored = messages.add(deviceId, { dir: 'out', text, ts, id, status: 'pending' });
  outgoingById.set(id, { peerId: deviceId });
  pushState();
  if (!peer) {
    stored.failed = true;
    return { ok: false, error: 'Device is offline', ts, id, status: 'pending' };
  }

  // relay-only peer (no ip): deliver over the internet relay by code
  if (isRelayPeer(peer)) {
    const relayUp = !!(relay && relay.connected && relay.registered);
    const sent = relayUp && relay.sendTo(peer.relayCode, { k: 'msg', text, ts, id });
    if (!sent) {
      // Relay is down: keep the message 'pending' and queue it; flushRelayOutbox()
      // delivers + flips it to 'sent' on the next 'ready'. Not a failure — it'll
      // go out automatically, just like WhatsApp's clock-tick state.
      relayOutbox.push({ peerId: deviceId, code: peer.relayCode, text, ts, id });
      return { ok: true, ts, id, status: 'pending', queued: true };
    }
    stored.status = 'sent';
    messages._save && messages._save();
    pushState();
    // the relay is fire-and-forget; a delivered frame to the server is our
    // best-effort 'sent'. delivered/read come back later as acks.
    return { ok: true, ts, id, status: 'sent' };
  }

  // LAN/manual peer: no receipt protocol, so a successful POST is 'sent'.
  try {
    const r = await postJson(peer, '/api/message', { from: selfFrom(), text, ts });
    if (!r || r.status !== 200) throw new Error('not delivered');
    stored.status = 'sent';
    messages._save && messages._save();
    pushState();
    return { ok: true, ts, id, status: 'sent' };
  } catch (err) {
    stored.failed = true;
    return { ok: false, error: 'Could not deliver (device offline?)', ts, id, status: 'pending' };
  }
}

// ---------------------------------------------------------------------------
// Comms: calls (WebRTC signaling relay; the media/PC live in the call window)
// ---------------------------------------------------------------------------
async function startCall(deviceId) {
  if (activeCall) return { ok: false, error: 'Already in a call' };
  const peer = lookupPeer(deviceId);
  if (!peer) return { ok: false, error: 'Device is no longer available' };
  const callId = crypto.randomUUID();
  activeCall = { callId, peer, role: 'caller', remoteEnded: false, answered: false };
  // caller-side answer timeout: if the callee never responds, give up cleanly
  activeCallTimer = setTimeout(() => failCall('timeout'), 35000);
  openCallWindow({ role: 'caller', callId, peer: { id: peer.id, name: peer.name } });
  return { ok: true };
}

function acceptIncoming() {
  if (!pendingIncoming) return { ok: false };
  const inc = pendingIncoming;
  clearPendingIncoming(true);
  activeCall = { callId: inc.callId, peer: inc.peer, role: 'callee', remoteEnded: false, answered: true };
  openCallWindow({ role: 'callee', callId: inc.callId, peer: { id: inc.peer.id, name: inc.peer.name }, offerSdp: inc.offerSdp });
  return { ok: true };
}

function declineIncoming() {
  if (!pendingIncoming) return { ok: false };
  const inc = pendingIncoming;
  clearPendingIncoming(true);
  if (inc.peer) sendRtc(inc.peer, { from: selfFrom(), kind: 'decline', callId: inc.callId }).catch(() => {});
  return { ok: true };
}

function clearPendingIncoming(notifyRenderer) {
  if (pendingIncomingTimer) {
    clearTimeout(pendingIncomingTimer);
    pendingIncomingTimer = null;
  }
  pendingIncoming = null;
  stopIncomingRing(); // silence the tone + dismiss the click-to-answer notification
  if (notifyRenderer && win && !win.isDestroyed()) win.webContents.send('call-ring', null);
}

// ---------------------------------------------------------------------------
// Notification sounds (focus-less): ONE persistent hidden window hosts a
// WebAudio synth so we can play our own short "ding" for incoming messages
// instead of letting Windows play its default notification sound (the message
// Notification is created with silent:true). Created once at startup; reused for
// every message rather than spawning a window per message.
// ---------------------------------------------------------------------------
function createSoundWindow() {
  try {
    if (soundWindow && !soundWindow.isDestroyed()) return;
    soundWindow = new BrowserWindow({
      show: false,
      focusable: false,
      skipTaskbar: true,
      width: 1,
      height: 1,
      webPreferences: {
        // self-contained inline WebAudio page; no preload / node access needed
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    soundWindow.on('closed', () => {
      soundWindow = null;
    });
    soundWindow.loadFile(path.join(__dirname, '..', 'renderer', 'sounds.html'));
  } catch (_) {
    // sound is best-effort; never let it break startup or message handling
  }
}

/** Play the custom short message "ding" via the persistent hidden sound window. */
function playDing() {
  try {
    if (!soundWindow || soundWindow.isDestroyed()) createSoundWindow();
    if (!soundWindow || soundWindow.isDestroyed()) return;
    soundWindow.webContents.executeJavaScript('window.__ding && window.__ding()').catch(() => {});
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Incoming ring (focus-less): a hidden window plays a looping tone, and an OS
// notification (click to answer) is shown — we never raise/focus a window for
// an incoming call so a fullscreen game isn't disrupted.
// ---------------------------------------------------------------------------
/**
 * Start the looping ring tone in a hidden (show:false) BrowserWindow. The window
 * is never shown or focused; it exists only to host a WebAudio oscillator. Safe
 * to call repeatedly — it reuses the window and just (re)starts the tone.
 */
function startIncomingRing() {
  try {
    if (!ringWindow || ringWindow.isDestroyed()) {
      ringWindow = new BrowserWindow({
        show: false,
        focusable: false,
        skipTaskbar: true,
        width: 1,
        height: 1,
        webPreferences: {
          // self-contained inline WebAudio page; no preload / node access needed
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      ringWindow.on('closed', () => {
        ringWindow = null;
      });
      ringWindow.webContents.once('did-finish-load', () => {
        // kick off the tone once the page (and its __ringStart) is ready
        if (pendingIncoming) playRingTone();
      });
      ringWindow.loadFile(path.join(__dirname, '..', 'renderer', 'ring.html'));
      return; // playRingTone() fires from did-finish-load above
    }
    playRingTone();
  } catch (_) {
    // ring audio is best-effort; never let it break call handling
  }
}

function playRingTone() {
  if (!ringWindow || ringWindow.isDestroyed()) return;
  ringWindow.webContents.executeJavaScript('window.__ringStart && window.__ringStart()').catch(() => {});
}

/** Stop the ring tone and dismiss the click-to-answer notification, if any. */
function stopIncomingRing() {
  if (ringWindow && !ringWindow.isDestroyed()) {
    ringWindow.webContents.executeJavaScript('window.__ringStop && window.__ringStop()').catch(() => {});
  }
  if (incomingNotification) {
    try {
      incomingNotification.close();
    } catch (_) {}
    incomingNotification = null;
  }
}

function onIncomingSignal(sig) {
  const peer = resolvePeer(sig);

  if (sig.kind === 'offer') {
    // Glare: we're already calling this same peer. Deterministic winner = the
    // lower device id keeps its call; the other side drops its outgoing call
    // and rings the incoming one instead (so the call still connects).
    if (activeCall && activeCall.role === 'caller' && activeCall.peer && activeCall.peer.id === sig.peerId) {
      if (self.id < sig.peerId) return; // we win — ignore their offer, keep ours
      // we lose — tear down our outgoing call, fall through to ring theirs
      clearActiveCallTimer();
      activeCall = null;
      if (callWindow && !callWindow.isDestroyed()) callWindow.destroy();
    }

    // busy if already in / ringing another call
    if (activeCall || pendingIncoming) {
      if (peer) sendRtc(peer, { from: selfFrom(), kind: 'busy', callId: sig.callId }).catch(() => {});
      return;
    }
    if (!peer) return; // can't reply, ignore

    // throttle the ring so offer/cancel cycling can't spam focus/notifications
    const now = Date.now();
    const prevRing = lastRing.get(sig.peerId) || 0;
    const spammy = now - prevRing < 3000;
    lastRing.set(sig.peerId, now);

    pendingIncoming = { callId: sig.callId, peer, offerSdp: sig.sdp };
    pendingIncomingTimer = setTimeout(() => clearPendingIncoming(true), 60000);

    // INCOMING calls must NOT raise or focus any window (a fullscreen game would
    // be disrupted). Instead: (optionally) play a hidden looping ring tone +
    // show a click-to-answer OS notification. The in-app ring banner ALWAYS
    // updates IF the panel happens to already be open (so the call still works
    // even with sound + toast off), but we never force the panel open.
    if (settings.get('soundCalls')) startIncomingRing();
    if (win && !win.isDestroyed()) {
      win.webContents.send('call-ring', { callId: sig.callId, peerId: sig.peerId, peerName: sig.peerName });
    }
    if (settings.get('notifyCalls') && Notification.isSupported() && !spammy) {
      const callerName = sig.peerName || 'Someone';
      // Plain toast — the most reliable form on Windows. (toastXml/scenario
      // "incomingCall" would bypass Focus Assist but hits an Electron bug where
      // it silently never shows.) Requires the INSTALLED build (its Start Menu
      // shortcut carries the AppUserModelID Windows needs) and Focus Assist off.
      const n = new Notification({
        title: `${callerName} is calling`,
        body: 'Click to answer · Filedrop',
        icon: fileIcon(),
        timeoutType: 'never', // ask Windows to keep it up rather than auto-dismiss
      });
      // Clicking the notification ANSWERS the call (same path as the Accept button) —
      // only then does a window appear, because the user chose to take the call.
      n.on('click', () => acceptIncoming());
      n.show();
      incomingNotification = n;
    }
    return;
  }

  // A caller giving up before we accepted: dismiss the ring (was previously dropped).
  if (
    (sig.kind === 'hangup' || sig.kind === 'decline' || sig.kind === 'busy') &&
    pendingIncoming &&
    pendingIncoming.callId === sig.callId
  ) {
    clearPendingIncoming(true);
    return;
  }

  // answer / decline / busy / hangup for the ACTIVE call -> route to the call window
  if (!activeCall || activeCall.callId !== sig.callId) return;
  if (!activeCall.peer || sig.peerId !== activeCall.peer.id) return; // reject forged/foreign signals
  if (sig.kind === 'answer') {
    if (typeof sig.sdp !== 'string' || !sig.sdp) return;
    activeCall.answered = true;
    clearActiveCallTimer();
  }
  if (sig.kind === 'decline' || sig.kind === 'busy' || sig.kind === 'hangup') {
    activeCall.remoteEnded = true;
    clearActiveCallTimer();
  }
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send('call-signal', { kind: sig.kind, sdp: sig.sdp, callId: sig.callId });
  }
}

/**
 * Send one WebRTC signaling message to a peer over whichever transport fits:
 * LAN/manual peers go over the fingerprint-pinned HTTPS POST; relay-only peers
 * go over the rendezvous WebSocket as a {k:'rtc', sig, callId, sdp} payload.
 * Returns a Promise<{status}> shaped like postJson so callers treat both alike.
 */
function sendRtc(peer, body) {
  if (isRelayPeer(peer)) {
    const sent =
      relay &&
      relay.sendTo(peer.relayCode, {
        k: 'rtc',
        sig: body.kind, // existing "kind" maps directly to payload.sig
        callId: body.callId || null,
        sdp: body.sdp || null,
      });
    return Promise.resolve({ status: sent ? 200 : 0 });
  }
  return postJson(peer, '/api/rtc', body);
}

/** Relay a signaling message from the call window out to the peer. */
function sendSignal(payload) {
  if (!activeCall) return { ok: false };
  const peer = activeCall.peer;
  if (!peer) return { ok: false };
  const isOffer = payload && payload.kind === 'offer';
  sendRtc(peer, {
    from: selfFrom(),
    kind: payload.kind,
    callId: activeCall.callId,
    sdp: payload.sdp || null,
  })
    .then((r) => {
      // if our very first offer can't be delivered, the peer is unreachable
      if (isOffer && (!r || r.status !== 200)) failCall('unreachable');
    })
    .catch(() => {
      if (isOffer) failCall('unreachable');
    });
  return { ok: true };
}

function clearActiveCallTimer() {
  if (activeCallTimer) {
    clearTimeout(activeCallTimer);
    activeCallTimer = null;
  }
}

/** End a caller's call that never connected (offline peer / no answer). */
function failCall(reason) {
  if (!activeCall || activeCall.answered) return;
  activeCall.remoteEnded = true; // peer is gone — no hangup to send
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send('call-signal', { kind: reason }); // 'timeout' | 'unreachable'
  }
}

function openCallWindow(init) {
  pendingCallInit = init;
  if (callWindow && !callWindow.isDestroyed()) {
    callWindow.webContents.send('call-init', init);
    callWindow.show();
    callWindow.focus();
    return;
  }
  callWindow = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 560,
    minHeight: 380,
    title: 'Filedrop Call',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: fileIcon(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  callWindow.loadFile(path.join(__dirname, '..', 'renderer', 'call.html'));
  callWindow.on('closed', () => {
    callWindow = null;
    endActiveCall('window-closed');
  });
}

function endActiveCall(reason) {
  clearActiveCallTimer();
  if (!activeCall) return;
  const call = activeCall;
  activeCall = null;
  pendingCallInit = null;
  // tell the peer we hung up, unless they're the one who ended it
  if (!call.remoteEnded && call.peer) {
    sendRtc(call.peer, { from: selfFrom(), kind: 'hangup', callId: call.callId }).catch(() => {});
  }
  if (reason !== 'window-closed' && callWindow && !callWindow.isDestroyed()) {
    callWindow.close();
  }
}

async function getDesktopSources() {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: false,
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      type: s.id.startsWith('screen') ? 'screen' : 'window',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    }));
  } catch (err) {
    return [];
  }
}

function setupMediaPermissions() {
  try {
    const ses = session.defaultSession;
    const allow = new Set(['media', 'display-capture', 'audioCapture', 'videoCapture']);
    // Only the call window may use mic/camera/screen — never the panel or any
    // other (e.g. future/embedded) content.
    const isCallWc = (wc) => {
      try {
        return !!callWindow && !callWindow.isDestroyed() && wc && wc.id === callWindow.webContents.id;
      } catch (_) {
        return false;
      }
    };
    ses.setPermissionRequestHandler((wc, permission, cb) => cb(allow.has(permission) && isCallWc(wc)));
    ses.setPermissionCheckHandler((wc, permission) => allow.has(permission) && isCallWc(wc));
  } catch (err) {
    console.error('[media] permission setup failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Auto-update
// ---------------------------------------------------------------------------
function setupUpdater() {
  updater = new Updater();
  updater.on('status', () => pushState());
  updater.on('available', (info) => {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Update available',
        body: `Filedrop ${info && info.version} is ready to install. Open Filedrop to update.`,
        icon: fileIcon(),
      });
      n.on('click', () => showWindow());
      n.show();
    }
  });
  updater.on('downloaded', (info) => {
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Update ready', body: `Restarting to Filedrop ${info && info.version}…`, icon: fileIcon() });
      n.show();
    }
  });
  updater.start();
}

// ---------------------------------------------------------------------------
// Receiving approval
// ---------------------------------------------------------------------------
function requestApproval(sender, files) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const totalSize = files.reduce((n, f) => n + (f.size || 0), 0);
    const data = { id, sender, files, totalSize, at: Date.now() };
    const timer = setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        pushState();
        resolve(false);
      }
    }, 60000);
    timer.unref && timer.unref();
    pendingRequests.set(id, { resolve, timer, data });
    pushState();
    showWindow();
    notifyIncoming(sender, files);
  });
}

function respondRequest(id, accept) {
  const r = pendingRequests.get(id);
  if (!r) return;
  clearTimeout(r.timer);
  pendingRequests.delete(id);
  pushState();
  r.resolve(!!accept);
}

function notifyIncoming(sender, files) {
  if (!Notification.isSupported()) return;
  const count = files.length;
  const n = new Notification({
    title: 'Incoming files',
    body: `${sender.name} wants to send you ${count} file${count > 1 ? 's' : ''}.`,
    icon: fileIcon(),
    silent: false,
  });
  n.on('click', () => showWindow());
  n.show();
}

// ---------------------------------------------------------------------------
// Transfers / state
// ---------------------------------------------------------------------------
function upsertTransfer(u) {
  const prev = transfers.get(u.id) || {};
  const merged = Object.assign({}, prev, u, { updatedAt: Date.now() });
  transfers.set(u.id, merged);

  if (u.status === 'done' && prev.status !== 'done' && u.direction === 'in') {
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'File received',
        body: `${u.fileName} from ${u.peer}`,
        icon: fileIcon(),
      });
      n.on('click', () => u.finalPath && shell.showItemInFolder(u.finalPath));
      n.show();
    }
  }
  if (u.direction === 'out' && ['done', 'error', 'canceled', 'declined'].includes(u.status)) {
    transferToController.delete(u.id);
  }
  pushState();
}

function buildState() {
  const hideIps = settings.get('hideIps');
  // CODE-FIRST: the Devices list shows ONLY code/relay peers and manually-added
  // peers. LAN multicast-discovered peers are intentionally excluded (the
  // discovery service may still run for send/lookup, but its peers never surface
  // in the UI). Manual + relay peers are keyed by id/code and never collide.
  const seen = new Set();
  const merged = [];
  for (const p of manualPeers.values()) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    merged.push(p);
  }
  // relay-only peers (added by code, or auto-created when a friend messages
  // first). Keyed by code, never collide with LAN device UUIDs.
  for (const p of relayPeers.values()) if (!seen.has(p.id)) merged.push(p);

  const devices = merged.map((p) => ({
    id: p.id,
    name: p.name,
    os: p.os,
    ip: hideIps ? undefined : p.ip,
    manual: !!p.manual,
    relay: !!(p.relay || p.isRelayOnly),
    relayCode: p.relayCode ? formatCode(p.relayCode) : undefined,
  }));

  const list = Array.from(transfers.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 60);

  // per-peer chat metadata for badges + previews (not the full history)
  const lastByPeer = messages ? messages.lastByPeer() : {};
  const chats = {};
  const seenChat = new Set(Object.keys(lastByPeer));
  for (const id of seenChat) {
    const last = lastByPeer[id];
    chats[id] = {
      unread: unread.get(id) || 0,
      last: last
        ? {
            text: last.text,
            ts: last.ts,
            dir: last.dir,
            // surface the receipt state of the last outgoing message (old rows
            // without a status are treated as 'sent' for back-compat)
            status: last.dir === 'out' ? last.status || 'sent' : undefined,
          }
        : null,
    };
  }
  // include peers with unread but no stored last (shouldn't happen, defensive)
  for (const [id, n] of unread) if (!chats[id]) chats[id] = { unread: n, last: null };

  // (Removed the LAN cross-device version nudge: the phone updates ahead of the
  // PC and they share a version line, so it nagged on every phone update. The
  // PC's own GitHub auto-updater — startup + every 6h + manual — handles real
  // desktop updates.)
  const peerNewer = null;

  // saved (manual / VPN) addresses with live status, for Settings management
  const onlineKeys = new Set(Array.from(manualPeers.values()).map((p) => p.savedKey).filter(Boolean));
  const savedAddresses = (settings.get('savedPeers') || []).map((s) => ({
    host: s.host,
    port: s.port,
    name: s.name,
    online: onlineKeys.has(`${s.host}:${s.port}`),
  }));

  return {
    self: {
      id: self.id,
      name: self.name,
      os: self.os,
      version: VERSION,
      port: self.port,
      addresses: localAddresses(), // your own IPs (always shown — you choose to share them)
      relayCode: formatCode(settings.get('relayCode')), // "XXXX-XXXX" for display
      relayConnected: !!(relay && relay.connected && relay.registered),
    },
    settings: settings.all,
    devices,
    transfers: list,
    requests: Array.from(pendingRequests.values()).map((r) => r.data),
    chats,
    savedAddresses,
    inCall: activeCall ? { peerId: activeCall.peer && activeCall.peer.id } : null,
    update: updater ? Object.assign({}, updater.state, { peerNewer }) : { state: 'disabled', peerNewer },
  };
}

function pushState() {
  if (pushTimer) return;
  pushTimer = setTimeout(() => {
    pushTimer = null;
    if (win && !win.isDestroyed()) win.webContents.send('state', buildState());
  }, 90);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function startServerWithFallback(preferred, host) {
  for (let p = preferred; p < preferred + 12; p++) {
    try {
      return await server.start(p, host);
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  throw new Error('No free port for the transfer server');
}

function defaultDownloadDir() {
  try {
    return app.getPath('downloads');
  } catch (_) {
    return path.join(app.getPath('home'), 'Downloads');
  }
}

function platformLabel() {
  return { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[process.platform] || process.platform;
}

let _fileIcon = null;
function fileIcon() {
  if (_fileIcon) return _fileIcon;
  try {
    _fileIcon = nativeImage.createFromPath(ICON_PATH);
  } catch (_) {
    _fileIcon = nativeImage.createEmpty();
  }
  return _fileIcon;
}

function trayIcon() {
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    if (img.isEmpty()) return img;
    return img.resize({ width: 32, height: 32 });
  } catch (_) {
    return nativeImage.createEmpty();
  }
}

function doQuit() {
  app.isQuitting = true;
  try {
    if (activeCall && activeCall.peer && !activeCall.remoteEnded) {
      sendRtc(activeCall.peer, { from: selfFrom(), kind: 'hangup', callId: activeCall.callId }).catch(() => {});
    }
    activeCall = null;
    if (callWindow && !callWindow.isDestroyed()) callWindow.destroy();
    if (ringWindow && !ringWindow.isDestroyed()) ringWindow.destroy();
    if (soundWindow && !soundWindow.isDestroyed()) soundWindow.destroy();
    discovery && discovery.stop();
    server && server.stop();
    relay && relay.stop();
  } catch (_) {}
  app.quit();
}

app.on('before-quit', () => {
  app.isQuitting = true;
});

// keep running in the tray when the window is closed
app.on('window-all-closed', () => {
  /* intentionally empty: Filedrop is a tray app */
});
