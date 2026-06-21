'use strict';

const api = window.filedrop;

// quality presets for screen share
const QUALITY = { '720': { w: 1280, h: 720 }, '1080': { w: 1920, h: 1080 }, source: null };
const BITRATE = { '720': 4000000, '1080': 6000000, source: 8000000 };

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
let connected = false;

let remoteVideoCount = 0;
const remote = { mic: true, cam: false, screen: false, deaf: false, camMirror: false };

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
  connected = false;
  remoteVideoCount = 0;
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
      return;
    }
    // Distinguish the two remote video m-lines by their transceiver mid
    // (audio=0, camera=1, screen=2 — the order they're added) rather than by
    // arrival order, which is unreliable and swapped camera/screen.
    const mid = e.transceiver && e.transceiver.mid;
    const isScreen = mid === '2' || (mid == null && remoteVideoCount > 0);
    remoteVideoCount++;
    const target = isScreen ? remoteScreen : remoteCamera;
    target.srcObject = new MediaStream([track]);
    // reveal as a fallback if ctrl state hasn't arrived
    track.onunmute = () => {
      if (isScreen) remote.screen = true;
      else remote.cam = true;
      layoutRemote();
    };
    track.onmute = () => {
      if (isScreen) remote.screen = false;
      else remote.cam = false;
      layoutRemote();
    };
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (s === 'connected') onConnected();
    else if (s === 'failed') setStatus('Connection failed', 'failed');
    else if (s === 'disconnected') { if (connected) setStatus('Reconnecting…'); }
    else if (s === 'closed') {/* handled by end() */}
  };

  // ICE state is more reliable than peer-connection state on some networks, so
  // settle the status from whichever fires first (connected/completed).
  pc.oniceconnectionstatechange = () => {
    const s = pc.iceConnectionState;
    if (s === 'connected' || s === 'completed') onConnected();
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
  // Attach a real MediaStream (so SDP carries a=msid:<id>) to each video sender.
  // Without a stream id, flutter_webrtc on Android gets an empty streams array
  // and renders nothing. Audio doesn't need this.
  const camOutStream = new MediaStream();
  const screenOutStream = new MediaStream();
  tx.camera = pc.addTransceiver('video', { direction: 'sendrecv', streams: [camOutStream] });
  tx.screen = pc.addTransceiver('video', { direction: 'sendrecv', streams: [screenOutStream] });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await gather(pc);
  api.rtcOut({ kind: 'offer', sdp: pc.localDescription.sdp });
  setStatus('ringing…');
}

async function makeAnswer(offerSdp) {
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  assignTransceivers();
  // The answerer's transceivers come from the remote offer and have no
  // associated stream, so their outgoing SDP would carry a=msid:- and the phone
  // would render nothing. Give the video senders real streams (a=msid:<id>).
  const camOutStream = new MediaStream();
  const screenOutStream = new MediaStream();
  if (tx.camera && tx.camera.sender.setStreams) tx.camera.sender.setStreams(camOutStream);
  if (tx.screen && tx.screen.sender.setStreams) tx.screen.sender.setStreams(screenOutStream);
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
      remote.camMirror = !!s.mir; // sender's outgoing camera is horizontally mirrored
      layoutRemote();
      renderBadges();
    } catch (_) {}
  };
}

function sendCtrl() {
  if (!ctrl || ctrl.readyState !== 'open') return;
  try {
    ctrl.send(JSON.stringify({ mic: !muted && !!micStream, cam: camOn, screen: screenOn, deaf: deafened, mir: false }));
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

/** Raise a sender's encoding max bitrate (and optionally framerate). */
async function setMaxBitrate(sender, bps, fps) {
  if (!sender) return;
  try {
    const p = sender.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    for (const enc of p.encodings) {
      enc.maxBitrate = bps;
      if (fps != null) enc.maxFramerate = fps;
    }
    await sender.setParameters(p);
  } catch (_) {}
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
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
      });
      const track = camStream.getVideoTracks()[0];
      if (tx.camera) {
        await tx.camera.sender.replaceTrack(track);
        // raise the camera encoder so 1080p looks crisp (~3 Mbps)
        await setMaxBitrate(tx.camera.sender, 3000000, 30);
      }
      localCamera.srcObject = camStream;
      localCamera.classList.remove('hidden');
      camOn = true;
    } catch (err) {
      toast('Camera unavailable: ' + err.message);
      return;
    }
  }
  renderControls();
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
    el('live-quality').classList.remove('hidden');
    renderControls();
    sendCtrl();
  } catch (err) {
    toast('Screen share failed: ' + err.message);
  }
}

async function applyScreenParams(fps, quality) {
  if (!tx.screen || !tx.screen.sender) return;
  // give the screen-share a high bitrate (>= ~4 Mbps) so shared screens stay sharp
  const bps = Math.max(BITRATE[quality] || 0, 4000000);
  await setMaxBitrate(tx.screen.sender, bps, Number(fps));
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
  el('live-quality').classList.add('hidden');
  renderControls();
  sendCtrl();
}

function toggleMute() {
  muted = !muted;
  if (micStream) micStream.getAudioTracks().forEach((t) => (t.enabled = !muted));
  renderControls();
  sendCtrl();
}

function toggleDeafen() {
  deafened = !deafened;
  remoteAudio.muted = deafened;
  // deafening also mutes your mic (like Discord)
  if (deafened && !muted) {
    toggleMute(); // also re-renders + sends ctrl
    return;
  }
  renderControls();
  sendCtrl();
}

/**
 * Re-render every control button's visual (active/toggled) state from the
 * ACTUAL current state, so the UI can never drift out of sync with reality.
 */
function renderControls() {
  const mic = el('btn-mic');
  mic.classList.toggle('danger-on', muted);
  mic.querySelector('.lbl').textContent = muted ? 'Unmute' : 'Mute';

  const deafen = el('btn-deafen');
  deafen.classList.toggle('danger-on', deafened);
  deafen.querySelector('.lbl').textContent = deafened ? 'Undeafen' : 'Deafen';

  el('btn-camera').classList.toggle('active', camOn);

  const screen = el('btn-screen');
  screen.classList.toggle('active', screenOn);
  screen.querySelector('.lbl').textContent = screenOn ? 'Stop' : 'Share';
}

// ---------------------------------------------------------------------------
// remote layout + badges
// ---------------------------------------------------------------------------
function layoutRemote() {
  const showScreen = remote.screen && remoteScreen.srcObject;
  const showCam = remote.cam && remoteCamera.srcObject;
  remoteScreen.classList.toggle('hidden', !showScreen);
  remoteCamera.classList.toggle('hidden', !showCam);
  // flip the remote camera back if the sender declared it mirrored (e.g. phone
  // front camera) — screen share is never flipped
  remoteCamera.classList.toggle('mirrored', !!remote.camMirror);
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
  renderControls(); // paint initial (all-off) button states

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

/** Called once the peer connection actually connects (PC or ICE state). */
function onConnected() {
  if (connected) {
    sendCtrl();
    return;
  }
  connected = true;
  setStatus('In call', 'connected');
  sendCtrl(); // resync mute/camera/screen state now that we're up
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
