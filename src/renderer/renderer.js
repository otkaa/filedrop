'use strict';

const api = window.filedrop;

let state = { self: {}, settings: {}, devices: [], transfers: [], requests: [], chats: {} };
let staged = []; // file paths queued to send
let editingName = false; // don't clobber the name field while the user types
let currentConvo = null; // peerId of the open conversation, or null
let convoMessages = []; // messages for the open conversation
let currentRing = null; // incoming call { callId, peerId, peerName } or null
let addrRevealed = false; // "Your address" is hidden until you click Show

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
init();

async function init() {
  wireStaticUi();
  api.onState((s) => {
    state = s;
    render();
  });
  api.onFilesChosen((paths) => stageFiles(paths));
  api.onFilesDropped((paths) => stageFiles(paths));
  api.onMessage(handleIncomingMessage);
  api.onCallRing((r) => {
    currentRing = r;
    renderRing();
  });
  state = await api.getState();
  render();
}

function wireStaticUi() {
  // tabs
  document.querySelectorAll('.tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
      document.querySelectorAll('.tabpane').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      document.getElementById('tab-' + t.dataset.tab).classList.add('active');
      // never strand the user inside a conversation under another tab
      if (currentConvo) closeConversation();
      // re-hide the address whenever you navigate, so it's private by default
      addrRevealed = false;
    });
  });

  document.getElementById('btn-min').onclick = () => api.hideWindow();
  document.getElementById('btn-pick').onclick = chooseFiles;
  document.getElementById('staging-clear').onclick = clearStaging;
  document.getElementById('btn-clear').onclick = () => api.clearFinished();
  document.getElementById('btn-add').onclick = openModal;
  document.getElementById('btn-add-link').onclick = openModal;

  // conversation / chat
  document.getElementById('convo-back').onclick = closeConversation;
  document.getElementById('convo-call').onclick = () => {
    if (currentConvo) api.startCall(currentConvo);
  };
  document.getElementById('convo-send').onclick = async () => {
    if (!currentConvo) return;
    const paths = await api.pickFiles();
    if (paths && paths.length) {
      const res = await api.sendFiles(currentConvo, paths);
      if (res && !res.ok && res.error !== 'Canceled') toast(res.error);
    }
  };
  document.getElementById('chat-send').onclick = sendChat;
  document.getElementById('chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendChat();
    }
  });

  // settings inputs
  document.getElementById('set-name').addEventListener('focus', () => (editingName = true));
  document.getElementById('set-name').addEventListener('blur', (e) => {
    editingName = false;
    const v = e.target.value.trim();
    if (v && v !== state.settings.deviceName) api.updateSettings({ deviceName: v });
  });
  document.getElementById('set-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.target.blur();
  });

  document.getElementById('set-autostart').onchange = (e) =>
    api.updateSettings({ autoStart: e.target.checked });
  document.getElementById('set-hideips').onchange = (e) =>
    api.updateSettings({ hideIps: e.target.checked });
  document.getElementById('set-stealth').onchange = (e) =>
    api.updateSettings({ stealth: e.target.checked });

  document.getElementById('btn-folder').onclick = () => api.pickDownloadFolder();
  document.getElementById('btn-openfolder').onclick = () => api.openDownloadFolder();
  document.getElementById('btn-update-check').onclick = () => api.updateCheck();
  document.getElementById('btn-quit').onclick = () => api.quit();

  // modal
  document.getElementById('add-cancel').onclick = closeModal;
  document.getElementById('add-ok').onclick = submitAddDevice;
  ['add-host', 'add-port'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAddDevice();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeModal();
      }
    });
  });

  // drag overlay visuals (path extraction happens in preload).
  // A depth counter alone can get stuck visible if Chromium drops the terminal
  // dragleave when a drag exits the frameless window, so we also use a watchdog
  // (dragover stops firing the instant the drag ends) and a window-exit reset.
  let dragDepth = 0;
  let dragWatchdog = null;
  const resetDrag = () => {
    dragDepth = 0;
    clearTimeout(dragWatchdog);
    dragWatchdog = null;
    showDropOverlay(false);
  };
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    showDropOverlay(true);
  });
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    clearTimeout(dragWatchdog);
    dragWatchdog = setTimeout(resetDrag, 200);
  });
  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) return resetDrag(); // cursor left the window
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) showDropOverlay(false);
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    resetDrag();
  });
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------
function render() {
  const s = state.settings || {};

  // self bar
  text('self-name', state.self.name || '…');
  text('self-os', state.self.os ? '· ' + state.self.os : '');
  document.getElementById('stealth-pill').classList.toggle('hidden', !s.stealth);

  // settings fields
  if (!editingName) val('set-name', s.deviceName || '');
  val('set-folder', s.downloadFolder || '');
  check('set-autostart', s.autoStart);
  check('set-hideips', s.hideIps);
  check('set-stealth', s.stealth);
  renderUpdate();
  renderAddresses();
  renderSaved();

  renderRequests();
  renderStaging();
  renderDevices();
  renderTransfers();
  renderRing();
  // keep conversation header in sync (name/online) if open
  if (currentConvo) updateConvoHeader();
}

function renderRequests() {
  const box = document.getElementById('requests');
  box.innerHTML = '';
  for (const r of state.requests || []) {
    const node = div('request');
    const fileList = r.files
      .map((f) => `${escapeHtml(f.name)} — ${formatBytes(f.size)}`)
      .join('<br>');
    node.innerHTML = `
      <div class="r-title">📥 ${escapeHtml(r.sender.name)} wants to send ${r.files.length} file${
      r.files.length > 1 ? 's' : ''
    } (${formatBytes(r.totalSize)})</div>
      <div class="r-files">${fileList}</div>
      <div class="r-actions">
        <button class="btn" data-accept="${r.id}">Accept</button>
        <button class="btn ghost" data-decline="${r.id}">Decline</button>
      </div>`;
    node.querySelector('[data-accept]').onclick = () => api.respondRequest(r.id, true);
    node.querySelector('[data-decline]').onclick = () => api.respondRequest(r.id, false);
    box.appendChild(node);
  }
}

function renderStaging() {
  const box = document.getElementById('staging');
  if (!staged.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const totalName =
    staged.length === 1 ? baseName(staged[0]) : `${staged.length} files`;
  text('staging-summary', `Ready to send: ${totalName}`);
}

function renderDevices() {
  const box = document.getElementById('devices');
  const empty = document.getElementById('devices-empty');
  box.innerHTML = '';
  const devices = state.devices || [];
  empty.classList.toggle('hidden', devices.length > 0);

  for (const d of devices) {
    const node = div('device');
    const chat = (state.chats && state.chats[d.id]) || {};
    const unread = chat.unread || 0;
    const lastPreview = chat.last ? (chat.last.dir === 'out' ? 'You: ' : '') + chat.last.text : null;
    const sub = staged.length
      ? 'Tap to send files'
      : lastPreview ||
        (d.manual ? 'Added manually' + (d.ip ? ' · ' + d.ip : '') : d.ip || d.os || 'On your network');

    node.innerHTML = `
      <div class="dev-avatar">${osEmoji(d.os)}</div>
      <div class="dev-meta">
        <div class="dev-name">${escapeHtml(d.name)}</div>
        <div class="dev-sub">${escapeHtml(truncate(sub, 44))}</div>
      </div>
      <div class="dev-actions">
        ${unread ? `<span class="dev-badge">${unread > 99 ? '99+' : unread}</span>` : ''}
        ${
          staged.length
            ? '<div class="dev-send">Send →</div>'
            : '<button class="dev-iconbtn" data-call title="Voice/video call">📞</button>'
        }
      </div>`;

    if (staged.length) {
      node.classList.add('armed');
      node.onclick = () => sendTo(d.id);
    } else {
      node.onclick = () => openConversation(d.id);
      const callBtn = node.querySelector('[data-call]');
      if (callBtn) callBtn.onclick = (e) => { e.stopPropagation(); api.startCall(d.id); };
    }
    box.appendChild(node);
  }
}

function renderTransfers() {
  const box = document.getElementById('transfers');
  const empty = document.getElementById('transfers-empty');
  box.innerHTML = '';
  const list = state.transfers || [];
  empty.classList.toggle('hidden', list.length > 0);

  for (const t of list) {
    const pct = t.total > 0 ? Math.min(100, Math.round((t.transferred / t.total) * 100)) : 0;
    const node = div('transfer ' + t.status);
    const active = ['pending', 'active', 'paused'].includes(t.status);
    const statusLabel = labelFor(t, pct);
    node.innerHTML = `
      <div class="t-top">
        <span class="t-name">${t.direction === 'in' ? '↓' : '↑'} ${escapeHtml(t.fileName)}</span>
        <span class="t-dir">${escapeHtml(t.peer || '')}</span>
      </div>
      <div class="bar"><span style="width:${pct}%"></span></div>
      <div class="t-bottom">
        <span class="t-status ${t.status}">${statusLabel}</span>
        <span class="t-meta"></span>
      </div>`;
    const meta = node.querySelector('.t-meta');
    if (active && t.total > 0) {
      meta.textContent = `${formatBytes(t.transferred)} / ${formatBytes(t.total)}`;
    } else if (t.status === 'done' && t.direction === 'in' && t.finalPath) {
      const a = document.createElement('span');
      a.className = 't-cancel';
      a.style.color = 'var(--accent)';
      a.textContent = 'Show in folder';
      a.onclick = () => api.openPath(t.finalPath);
      meta.appendChild(a);
    } else if (t.direction === 'out' && active) {
      const c = document.createElement('span');
      c.className = 't-cancel';
      c.textContent = 'cancel';
      c.onclick = () => api.cancelTransfer(t.id);
      meta.appendChild(c);
    }
    box.appendChild(node);
  }
}

function labelFor(t, pct) {
  switch (t.status) {
    case 'pending':
      return t.direction === 'out' ? 'Waiting for accept…' : 'Incoming…';
    case 'active':
      return pct + '%';
    case 'paused':
      return 'Paused — resuming…';
    case 'done':
      return 'Done';
    case 'declined':
      return 'Declined';
    case 'canceled':
      return 'Canceled';
    case 'error':
      return 'Failed';
    default:
      return t.status;
  }
}

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------
async function chooseFiles() {
  const paths = await api.pickFiles();
  if (paths && paths.length) stageFiles(paths);
}

function stageFiles(paths) {
  if (!paths || !paths.length) return;
  staged = paths.slice();
  // make sure we're on the Devices tab so they can pick a target
  document.querySelector('.tab[data-tab="devices"]').click();
  render();
}

function clearStaging() {
  staged = [];
  render();
}

async function sendTo(deviceId) {
  let paths = staged;
  if (!paths.length) {
    paths = await api.pickFiles();
    if (!paths || !paths.length) return;
  }
  clearStaging();
  const res = await api.sendFiles(deviceId, paths);
  if (res && !res.ok && res.error && res.error !== 'Canceled') {
    toast(res.error);
  }
}

// ---------------------------------------------------------------------------
// conversation + chat
// ---------------------------------------------------------------------------
async function openConversation(peerId) {
  currentConvo = peerId;
  convoMessages = (await api.getMessages(peerId)) || []; // also clears unread
  document.getElementById('view-list').classList.add('hidden');
  document.getElementById('view-convo').classList.remove('hidden');
  updateConvoHeader();
  renderChat();
  const inp = document.getElementById('chat-input');
  inp.value = '';
  inp.focus();
}

function closeConversation() {
  currentConvo = null;
  convoMessages = [];
  api.closeConvo();
  document.getElementById('view-convo').classList.add('hidden');
  document.getElementById('view-list').classList.remove('hidden');
}

function deviceById(id) {
  return (state.devices || []).find((d) => d.id === id);
}

function updateConvoHeader() {
  const d = deviceById(currentConvo);
  text('convo-name', d ? d.name : 'Device');
  text('convo-sub', d ? '· online' : '· offline');
  const callBtn = document.getElementById('convo-call');
  if (callBtn) callBtn.disabled = !d;
}

function renderChat() {
  const box = document.getElementById('chat-messages');
  box.innerHTML = '';
  if (!convoMessages.length) {
    const e = div('chat-empty');
    e.textContent = 'No messages yet. Say hello 👋';
    box.appendChild(e);
    return;
  }
  for (const m of convoMessages) box.appendChild(bubble(m));
  box.scrollTop = box.scrollHeight;
}

function bubble(m) {
  const node = div('bubble ' + (m.dir === 'out' ? 'out' : 'in') + (m.failed ? ' failed' : ''));
  node.innerHTML =
    escapeHtml(m.text) + `<span class="b-time">${m.failed ? 'not delivered · ' : ''}${timeStr(m.ts)}</span>`;
  return node;
}

async function sendChat() {
  const inp = document.getElementById('chat-input');
  const text = inp.value.trim();
  if (!text || !currentConvo) return;
  inp.value = '';
  const peerId = currentConvo;
  const msg = { dir: 'out', text, ts: Date.now() };

  // optimistic append; we mark it failed if delivery doesn't go through
  const node = appendBubble(msg);
  convoMessages.push(msg);

  const res = await api.sendMessage(peerId, text);
  if (res && !res.ok && node) {
    msg.failed = true;
    node.classList.add('failed');
    const t = node.querySelector('.b-time');
    if (t) t.textContent = 'not delivered · ' + timeStr(msg.ts);
  }
}

function handleIncomingMessage(m) {
  // only incoming messages are pushed here now (outgoing are appended locally)
  if (m.peerId === currentConvo) appendBubble({ dir: m.dir, text: m.text, ts: m.ts });
  // device list badges update via the pushed state
}

/** Append a message bubble to the open chat (clearing the empty placeholder). */
function appendBubble(m) {
  const box = document.getElementById('chat-messages');
  const empty = box.querySelector('.chat-empty');
  if (empty) box.innerHTML = '';
  const node = bubble(m);
  box.appendChild(node);
  box.scrollTop = box.scrollHeight;
  return node;
}

// ---------------------------------------------------------------------------
// your address + saved addresses
// ---------------------------------------------------------------------------
function renderAddresses() {
  const box = document.getElementById('my-addresses');
  if (!box) return;
  const addrs = (state.self && state.self.addresses) || [];
  const port = (state.self && state.self.port) || '';
  box.innerHTML = '';
  if (!addrs.length) {
    const e = div('addr-empty');
    e.textContent = 'No network address found (not connected to a network?).';
    box.appendChild(e);
    return;
  }

  // Hidden by default — only revealed when you click Show.
  if (!addrRevealed) {
    const reveal = document.createElement('button');
    reveal.className = 'btn small ghost addr-reveal';
    reveal.textContent = '👁  Show address';
    reveal.onclick = () => {
      addrRevealed = true;
      renderAddresses();
    };
    box.appendChild(reveal);
    return;
  }

  for (const a of addrs) {
    const full = a.address + ':' + port;
    const row = div('addr-row');
    row.innerHTML = `
      <div class="addr-main">
        <div class="addr-ip">${escapeHtml(full)}${a.vpn ? '<span class="addr-tag">VPN</span>' : ''}</div>
        <div class="addr-sub">${escapeHtml(a.label)}</div>
      </div>
      <button class="addr-btn">Copy</button>`;
    const btn = row.querySelector('.addr-btn');
    btn.onclick = () => {
      api.copyText(full);
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    };
    box.appendChild(row);
  }

  const hide = document.createElement('button');
  hide.className = 'link addr-hide';
  hide.textContent = 'Hide address';
  hide.onclick = () => {
    addrRevealed = false;
    renderAddresses();
  };
  box.appendChild(hide);
}

function renderSaved() {
  const field = document.getElementById('saved-field');
  const box = document.getElementById('saved-list');
  if (!field || !box) return;
  const saved = state.savedAddresses || [];
  field.style.display = saved.length ? '' : 'none';
  box.innerHTML = '';
  for (const s of saved) {
    const row = div('addr-row');
    row.innerHTML = `
      <span class="addr-dot ${s.online ? 'online' : ''}"></span>
      <div class="addr-main">
        <div class="addr-ip">${escapeHtml(s.name || s.host)}</div>
        <div class="addr-sub">${escapeHtml(s.host + ':' + s.port)} · ${s.online ? 'online' : 'offline'}</div>
      </div>
      <button class="addr-btn">Remove</button>`;
    row.querySelector('.addr-btn').onclick = () => api.removeSaved(s.host, s.port);
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// updates
// ---------------------------------------------------------------------------
function renderUpdate() {
  const u = state.update || { state: 'idle' };
  const ver = 'v' + (state.self.version || '');
  const banner = document.getElementById('update-banner');
  const statusEl = document.getElementById('update-status');
  const checkBtn = document.getElementById('btn-update-check');

  let show = false;
  let html = '';
  let status = 'Filedrop ' + ver;

  switch (u.state) {
    case 'available':
      show = true;
      html = `<div class="u-text"><strong>Update available</strong> — v${escapeHtml(u.version || '')}</div><button class="btn small" id="u-update">Update now</button>`;
      status = 'Update available — v' + (u.version || '');
      break;
    case 'downloading':
      show = true;
      html = `<div class="u-text"><strong>Downloading update…</strong> ${u.percent || 0}%<div class="bar"><span style="width:${u.percent || 0}%"></span></div></div>`;
      status = `Downloading… ${u.percent || 0}%`;
      break;
    case 'downloaded':
      show = true;
      html = `<div class="u-text"><strong>Update ready</strong> — v${escapeHtml(u.version || '')}</div><button class="btn small" id="u-install">Restart &amp; install</button>`;
      status = 'Ready to install — v' + (u.version || '');
      break;
    case 'checking':
      status = 'Checking for updates…';
      break;
    case 'none':
      status = 'Up to date · ' + ver;
      break;
    case 'error':
      status = (u.error || 'Update check failed') + ' · ' + ver;
      break;
    case 'disabled':
      status = ver + ' · auto-update works in the installed build';
      break;
    default:
      status = 'Filedrop ' + ver;
  }

  // LAN nudge: a peer is on a newer version but the feed hasn't confirmed yet
  if (!show && u.peerNewer && ['idle', 'none', 'disabled', 'error'].includes(u.state)) {
    show = true;
    html = `<div class="u-text"><strong>A device on your network is on v${escapeHtml(u.peerNewer)}</strong> — you have ${ver}</div><button class="btn small" id="u-check">Check</button>`;
  }

  banner.classList.toggle('hidden', !show);
  banner.innerHTML = show ? html : '';
  if (statusEl) statusEl.textContent = status;
  if (checkBtn) checkBtn.disabled = u.state === 'checking' || u.state === 'downloading';

  const upd = document.getElementById('u-update');
  if (upd) upd.onclick = () => api.updateDownload();
  const ins = document.getElementById('u-install');
  if (ins) ins.onclick = () => api.updateInstall();
  const chk = document.getElementById('u-check');
  if (chk) chk.onclick = () => api.updateCheck();
}

// ---------------------------------------------------------------------------
// incoming call ring
// ---------------------------------------------------------------------------
function renderRing() {
  const box = document.getElementById('call-ring');
  if (!currentRing) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `
    <span class="r-emoji">📞</span>
    <div class="r-text"><strong>${escapeHtml(currentRing.peerName || 'Someone')}</strong>is calling…</div>
    <div class="r-actions">
      <button class="btn" id="ring-accept">Accept</button>
      <button class="btn ghost" id="ring-decline">Decline</button>
    </div>`;
  document.getElementById('ring-accept').onclick = () => {
    currentRing = null;
    renderRing();
    api.callAccept();
  };
  document.getElementById('ring-decline').onclick = () => {
    currentRing = null;
    renderRing();
    api.callDecline();
  };
}

// ---------------------------------------------------------------------------
// add-device modal
// ---------------------------------------------------------------------------
function openModal() {
  document.getElementById('modal').classList.remove('hidden');
  document.getElementById('add-error').textContent = '';
  document.getElementById('add-host').value = '';
  document.getElementById('add-port').value = '';
  document.getElementById('add-host').focus();
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}
async function submitAddDevice() {
  const host = document.getElementById('add-host').value.trim();
  const port = document.getElementById('add-port').value.trim();
  const err = document.getElementById('add-error');
  if (!host) {
    err.textContent = 'Enter an IP address.';
    return;
  }
  err.textContent = 'Connecting…';
  const res = await api.addDevice(host, port);
  if (res.ok) {
    closeModal();
  } else {
    err.textContent = res.error || 'Could not reach that device.';
  }
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
function showDropOverlay(on) {
  let ov = document.getElementById('drop-overlay');
  if (on && !ov) {
    ov = document.createElement('div');
    ov.id = 'drop-overlay';
    ov.className = 'drop-overlay';
    ov.textContent = 'Drop files to queue them for sending';
    document.body.appendChild(ov);
  } else if (!on && ov) {
    ov.remove();
  }
}

let toastTimer = null;
function toast(msg) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText =
      'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);background:#2a2f3a;color:#fff;padding:9px 14px;border-radius:9px;font-size:12.5px;z-index:90;border:1px solid var(--red);max-width:90%;text-align:center';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
  }, 3500);
}

function osEmoji(os) {
  if (!os) return '💻';
  const o = String(os).toLowerCase();
  if (o.includes('win')) return '🪟';
  if (o.includes('linux')) return '🐧';
  if (o.includes('mac') || o.includes('darwin')) return '🍎';
  if (o.includes('android')) return '🤖';
  return '💻';
}

function formatBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do {
    n /= 1024;
    i++;
  } while (n >= 1024 && i < units.length - 1);
  return n.toFixed(n < 10 ? 1 : 0) + ' ' + units[i];
}

function baseName(p) {
  return String(p).split(/[\\/]/).pop();
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function timeStr(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return '';
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// tiny DOM utils
function div(cls) {
  const d = document.createElement('div');
  d.className = cls;
  return d;
}
function text(id, v) {
  const el = document.getElementById(id);
  if (el) el.textContent = v;
}
function val(id, v) {
  const el = document.getElementById(id);
  if (el && el.value !== v) el.value = v;
}
function check(id, v) {
  const el = document.getElementById(id);
  if (el) el.checked = !!v;
}
