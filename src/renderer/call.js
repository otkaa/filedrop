'use strict';

const api = window.filedrop;

// quality presets for screen share
const QUALITY = { '720': { w: 1280, h: 720 }, '1080': { w: 1920, h: 1080 }, source: null };
const BITRATE = { '720': 2500000, '1080': 5000000, source: 8000000 };

let pc = null;
let init = null; // { role, callId, peer, offerSdp }
const tx = { audio: null, camera: null, screen: null };
let ctrl = null;

let micStream = null;
let camStream = null;
let screenStream = null;
let currentSourceId = null;

let muted = false;
let deafened = false;
let camOn = false;
let screenOn = false;
let ended = false;

let remoteVideoCount = 0;
const remote = { mic: true, cam: false, screen: false, deaf: false };

// elements
const el = (id) => document.getElementById(id);
const remoteAudio = el('remote-audio');
const remoteCamera = el('remote-camera');
const remoteScreen = el('remote-screen');
const localCamera = el('local-camera');
const localScreen = el('local-screen');

// ---------------------------------------------------------------------------
boot();

async function boot() {
  wireControls();
  api.onCallSignal(handleSignal);
  api.onCallInit((i) => start(i)); // window reuse
  const pulled = await api.callReady();
  if (pulled) start(pulled);
}

async function start(i) {
  if (pc) cleanupPc();
  ended = false;
  init = i;
  el('peer-name').textContent = (i.peer && i.peer.name) || 'Call';
  setStatus(i.role === 'caller' ? 'calling…' : 'connecting…');
  createPc();
  try {
    if (i.role === 'caller') await makeOffer();
    else await makeAnswer(i.offerSdp);
  } catch (err) {
    toast('Could not start call: ' + err.message);
    end('failed', 'failed');
  }
}

// ---------------------------------------------------------------------------
// peer connection
// ---------------------------------------------------------------------------
function createPc() {
  pc = new RTCPeerConnection({ iceServers: [] }); // LAN only — host candidates

  pc.ontrack = (e) => {
    const track = e.track;
    if (track.kind === 'audio') {
      remoteAudio.srcObject = new MediaStream([track]);
      remoteAudio.muted = deafened;
    } else {
      const idx = remoteVideoCount++;
      const target = idx === 0 ? remoteCamera : remoteScreen;
      target.srcObject = new MediaStream([track]);
      // reveal as a fallback if ctrl state hasn't arrived
      track.onunmute = () => {
        if (idx === 0) remote.cam = true;
        else remote.screen = true;
        layoutRemote();
      };
      track.onmute = () => {
        if (idx === 0) remote.cam = false;
        else remote.screen = false;
        layoutRemote();
      };
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') setStatus('connected', 'connected');
    else if (s === 'failed') setStatus('connection failed', 'failed');
    else if (s === 'disconnected') setStatus('reconnecting…');
    else if (s === 'closed') {/* handled by end() */}
  };

  if (init.role === 'caller') {
    ctrl = pc.createDataChannel('ctrl');
    bindCtrl(ctrl);
  } else {
    pc.ondatachannel = (e) => {
      if (e.channel.label === 'ctrl') {
        ctrl = e.channel;
        bindCtrl(ctrl);
      }
    };
  }
}

async function makeOffer() {
  const mic = await getMic();
  tx.audio = pc.addTransceiver(mic || 'audio', { direction: 'sendrecv' });
  tx.camera = pc.addTransceiver('video', { direction: 'sendrecv' });
  tx.screen = pc.addTransceiver('video', { direction: 'sendrecv' });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await gather(pc);
  api.rtcOut({ kind: 'offer', sdp: pc.localDescription.sdp });
  setStatus('ringing…');
}

async function makeAnswer(offerSdp) {
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  assignTransceivers();
  const mic = await getMic();
  if (mic && tx.audio) await tx.audio.sender.replaceTrack(mic);
  // make every line bidirectional so we can enable cam/screen later w/o reneg
  for (const t of [tx.audio, tx.camera, tx.screen]) if (t) t.direction = 'sendrecv';

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await gather(pc);
  api.rtcOut({ kind: 'answer', sdp: pc.localDescription.sdp });
}

function assignTransceivers() {
  const txs = pc.getTransceivers();
  tx.audio = txs.find((t) => t.receiver.track && t.receiver.track.kind === 'audio') || null;
  const vids = txs.filter((t) => t.receiver.track && t.receiver.track.kind === 'video');
  tx.camera = vids[0] || null;
  tx.screen = vids[1] || null;
}

function handleSignal(sig) {
  if (!sig || ended) return;
  if (sig.kind === 'answer') {
    pc.setRemoteDescription({ type: 'answer', sdp: sig.sdp }).catch((e) => toast('answer error: ' + e.message));
  } else if (sig.kind === 'decline') {
    end('Call declined', 'ended');
  } else if (sig.kind === 'busy') {
    end('Busy — try again later', 'ended');
  } else if (sig.kind === 'hangup') {
    end('Call ended', 'ended');
  } else if (sig.kind === 'timeout') {
    end('No answer', 'ended');
  } else if (sig.kind === 'unreachable') {
    end('Device unreachable', 'ended');
  }
}

/** Wait until ICE gathering is complete (or a short timeout). */
function gather(peer) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      peer.removeEventListener('icegatheringstatechange', check);
      clearTimeout(t);
      resolve();
    };
    const check = () => {
      if (peer.iceGatheringState === 'complete') done();
    };
    peer.addEventListener('icegatheringstatechange', check);
    const t = setTimeout(done, 2500); // LAN gathers fast; cap the wait
  });
}

// ---------------------------------------------------------------------------
// control channel (live mute/cam/screen status)
// ---------------------------------------------------------------------------
function bindCtrl(ch) {
  ch.onopen = () => sendCtrl();
  ch.onmessage = (e) => {
    try {
      const s = JSON.parse(e.data);
      Object.assign(remote, s);
      layoutRemote();
      renderBadges();
    } catch (_) {}
  };
}

function sendCtrl() {
  if (!ctrl || ctrl.readyState !== 'open') return;
  try {
    ctrl.send(JSON.stringify({ mic: !muted && !!micStream, cam: camOn, screen: screenOn, deaf: deafened }));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// media helpers
// ---------------------------------------------------------------------------
async function getMic() {
  if (micStream) return micStream.getAudioTracks()[0];
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    return micStream.getAudioTracks()[0];
  } catch (err) {
    toast('Microphone unavailable — you can still hear the call');
    return null;
  }
}

async function toggleCamera() {
  if (camOn) {
    if (camStream) camStream.getTracks().forEach((t) => t.stop());
    camStream = null;
    camOn = false;
    if (tx.camera) await tx.camera.sender.replaceTrack(null);
    localCamera.classList.add('hidden');
    localCamera.srcObject = null;
  } else {
    try {
      camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      });
      const track = camStream.getVideoTracks()[0];
      if (tx.camera) {
        await tx.camera.sender.replaceTrack(track);
        // cap the camera encoder so it can't hog the link (screen has its own cap)
        try {
          const p = tx.camera.sender.getParameters();
          if (!p.encodings || !p.encodings.length) p.encodings = [{}];
          p.encodings[0].maxBitrate = 1500000; // ~1.5 Mbps for 720p
          p.encodings[0].maxFramerate = 30;
          await tx.camera.sender.setParameters(p);
        } catch (_) {}
      }
      localCamera.srcObject = camStream;
      localCamera.classList.remove('hidden');
      camOn = true;
    } catch (err) {
      toast('Camera unavailable: ' + err.message);
      return;
    }
  }
  el('btn-camera').classList.toggle('active', camOn);
  sendCtrl();
}

async function startScreen(sourceId, fps, quality) {
  try {
    const q = QUALITY[quality];
    const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: Number(fps) };
    if (q) {
      mandatory.maxWidth = q.w;
      mandatory.maxHeight = q.h;
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory } });
    if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
    screenStream = stream;
    currentSourceId = sourceId;
    const track = stream.getVideoTracks()[0];
    track.onended = () => stopScreen(); // user stopped via OS overlay
    if (tx.screen) {
      await tx.screen.sender.replaceTrack(track);
      await applyScreenParams(fps, quality);
    }
    localScreen.srcObject = stream;
    localScreen.classList.remove('hidden');
    screenOn = true;
    el('btn-screen').classList.add('active');
    el('live-quality').classList.remove('hidden');
    sendCtrl();
  } catch (err) {
    toast('Screen share failed: ' + err.message);
  }
}

async function applyScreenParams(fps, quality) {
  if (!tx.screen || !tx.screen.sender) return;
  try {
    const p = tx.screen.sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    p.encodings[0].maxBitrate = BITRATE[quality] || 5000000;
    p.encodings[0].maxFramerate = Number(fps);
    await tx.screen.sender.setParameters(p);
  } catch (_) {}
}

async function stopScreen() {
  if (!screenOn) return;
  if (screenStream) screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;
  currentSourceId = null;
  if (tx.screen) await tx.screen.sender.replaceTrack(null);
  localScreen.classList.add('hidden');
  localScreen.srcObject = null;
  screenOn = false;
  el('btn-screen').classList.remove('active');
  el('live-quality').classList.add('hidden');
  sendCtrl();
}

function toggleMute() {
  muted = !muted;
  if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  el('btn-mic').classList.toggle('danger-on', muted);
  el('btn-mic').querySelector('.lbl').textContent = muted ? 'Unmute' : 'Mute';
  sendCtrl();
}

function toggleDeafen() {
  deafened = !deafened;
  remoteAudio.muted = deafened;
  // deafening also mutes your mic (like Discord)
  if (deafened && !muted) toggleMute();
  el('btn-deafen').classList.toggle('danger-on', deafened);
  el('btn-deafen').querySelector('.lbl').textContent = deafened ? 'Undeafen' : 'Deafen';
  sendCtrl();
}

// ---------------------------------------------------------------------------
// remote layout + badges
// ---------------------------------------------------------------------------
function layoutRemote() {
  const showScreen = remote.screen && remoteScreen.srcObject;
  const showCam = remote.cam && remoteCamera.srcObject;
  remoteScreen.classList.toggle('hidden', !showScreen);
  remoteCamera.classList.toggle('hidden', !showCam);
  // if both, camera goes to a corner; if only camera, it fills
  remoteCamera.classList.toggle('cornered', showScreen && showCam);
  el('placeholder').classList.toggle('hidden', showScreen || showCam);
  renderBadges();
}

function renderBadges() {
  const b = [];
  if (!remote.mic || remote.deaf) b.push('<span class="on">🔇</span>');
  if (remote.cam) b.push('<span class="on">📷</span>');
  if (remote.screen) b.push('<span class="on">🖥️</span>');
  el('remote-badges').innerHTML = b.join(' ');
}

// ---------------------------------------------------------------------------
// screen-share picker
// ---------------------------------------------------------------------------
async function openSharePicker() {
  el('share-modal').classList.remove('hidden');
  const box = el('share-sources');
  box.textContent = 'Loading sources…';
  const sources = await api.desktopSources();
  if (!sources.length) {
    box.textContent = 'No screens/windows available.';
    return;
  }
  box.innerHTML = '';
  for (const s of sources) {
    const node = document.createElement('div');
    node.className = 'source';
    node.innerHTML =
      `<img src="${s.thumbnail || ''}" alt="">` +
      `<div class="src-name">${escapeHtml(s.name)}</div>`;
    node.onclick = () => {
      el('share-modal').classList.add('hidden');
      startScreen(s.id, el('pick-fps').value, el('pick-q').value);
      // sync live selectors with the picked values
      el('live-fps').value = el('pick-fps').value;
      el('live-q').value = el('pick-q').value;
    };
    box.appendChild(node);
  }
}

// ---------------------------------------------------------------------------
// wiring
// ---------------------------------------------------------------------------
function wireControls() {
  el('btn-mic').onclick = toggleMute;
  el('btn-deafen').onclick = toggleDeafen;
  el('btn-camera').onclick = toggleCamera;
  el('btn-screen').onclick = () => (screenOn ? stopScreen() : openSharePicker());
  el('btn-hangup').onclick = () => end('Call ended', 'ended', true);
  el('share-cancel').onclick = () => el('share-modal').classList.add('hidden');

  const liveChange = () => {
    if (screenOn && currentSourceId) startScreen(currentSourceId, el('live-fps').value, el('live-q').value);
  };
  el('live-fps').onchange = liveChange;
  el('live-q').onchange = liveChange;

  window.addEventListener('beforeunload', () => {
    if (!ended) {
      try { api.callEnded(); } catch (_) {}
    }
  });
}

// ---------------------------------------------------------------------------
function end(message, statusClass, userHangup) {
  if (ended) {
    if (userHangup) window.close();
    return;
  }
  ended = true;
  setStatus(message, statusClass);
  cleanupPc();
  if (userHangup) {
    window.close(); // main posts hangup on window 'closed'
  } else {
    toast(message);
    setTimeout(() => window.close(), 1200);
  }
}

function cleanupPc() {
  for (const s of [micStream, camStream, screenStream]) {
    if (s) s.getTracks().forEach((t) => t.stop());
  }
  micStream = camStream = screenStream = null;
  try {
    if (ctrl) ctrl.close();
  } catch (_) {}
  try {
    if (pc) pc.close();
  } catch (_) {}
  pc = null;
}

function setStatus(text, cls) {
  const s = el('status');
  s.textContent = text;
  s.className = 'status' + (cls ? ' ' + cls : '');
}

let toastTimer = null;
function toast(msg) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
