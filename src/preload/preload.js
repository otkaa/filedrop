'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

let dropCb = null;

// Resolve absolute paths for dropped files here in the preload, where the real
// File objects and webUtils are available, then hand plain strings to the page.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (!dropCb || !e.dataTransfer) return;
  const paths = [];
  for (const f of e.dataTransfer.files) {
    try {
      const p = webUtils.getPathForFile(f);
      if (p) paths.push(p);
    } catch (_) {}
  }
  if (paths.length) dropCb(paths);
});

contextBridge.exposeInMainWorld('filedrop', {
  getState: () => ipcRenderer.invoke('get-state'),
  updateSettings: (partial) => ipcRenderer.invoke('update-settings', partial),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  sendFiles: (deviceId, paths) => ipcRenderer.invoke('send-files', { deviceId, paths }),
  cancelTransfer: (transferId) => ipcRenderer.invoke('cancel-transfer', transferId),
  respondRequest: (id, accept) => ipcRenderer.invoke('respond-request', { id, accept }),
  pickDownloadFolder: () => ipcRenderer.invoke('pick-download-folder'),
  openDownloadFolder: () => ipcRenderer.invoke('open-download-folder'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  addDevice: (host, port) => ipcRenderer.invoke('add-device', { host, port }),
  addByCode: (code) => ipcRenderer.invoke('add-by-code', code),
  removeSaved: (host, port) => ipcRenderer.invoke('remove-saved', { host, port }),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),
  clearFinished: () => ipcRenderer.invoke('clear-finished'),
  hideWindow: () => ipcRenderer.invoke('hide-window'),
  quit: () => ipcRenderer.invoke('quit'),

  // chat
  getMessages: (peerId) => ipcRenderer.invoke('get-messages', peerId),
  closeConvo: () => ipcRenderer.invoke('close-convo'),
  sendMessage: (deviceId, text) => ipcRenderer.invoke('send-message', { deviceId, text }),
  clearChat: (peerId) => ipcRenderer.invoke('clear-chat', peerId),

  // calls (panel side)
  startCall: (deviceId) => ipcRenderer.invoke('start-call', deviceId),
  callAccept: () => ipcRenderer.invoke('call-accept'),
  callDecline: () => ipcRenderer.invoke('call-decline'),

  // calls (call window side)
  callReady: () => ipcRenderer.invoke('call-ready'),
  rtcOut: (payload) => ipcRenderer.invoke('rtc-out', payload),
  callEnded: () => ipcRenderer.invoke('call-ended'),
  desktopSources: () => ipcRenderer.invoke('desktop-sources'),

  // updates
  updateCheck: () => ipcRenderer.invoke('update-check'),
  updateDownload: () => ipcRenderer.invoke('update-download'),
  updateInstall: () => ipcRenderer.invoke('update-install'),

  // events main -> renderer
  onState: (cb) => {
    const fn = (_e, state) => cb(state);
    ipcRenderer.on('state', fn);
    return () => ipcRenderer.removeListener('state', fn);
  },
  onFilesChosen: (cb) => {
    const fn = (_e, paths) => cb(paths);
    ipcRenderer.on('files-chosen', fn);
    return () => ipcRenderer.removeListener('files-chosen', fn);
  },
  onFilesDropped: (cb) => {
    dropCb = cb;
  },

  // chat / call events (main -> renderer)
  onMessage: (cb) => {
    const fn = (_e, m) => cb(m);
    ipcRenderer.on('message', fn);
    return () => ipcRenderer.removeListener('message', fn);
  },
  onCallRing: (cb) => {
    const fn = (_e, r) => cb(r);
    ipcRenderer.on('call-ring', fn);
    return () => ipcRenderer.removeListener('call-ring', fn);
  },
  onCallInit: (cb) => {
    const fn = (_e, init) => cb(init);
    ipcRenderer.on('call-init', fn);
    return () => ipcRenderer.removeListener('call-init', fn);
  },
  onCallSignal: (cb) => {
    const fn = (_e, sig) => cb(sig);
    ipcRenderer.on('call-signal', fn);
    return () => ipcRenderer.removeListener('call-signal', fn);
  },
});
