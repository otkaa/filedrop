import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'call_service.dart';
import 'models.dart';

/// One voice/video call. Mirrors the desktop's design: 3 transceivers
/// (audio, camera-video, screen-video) negotiated up front + a 'ctrl' data
/// channel for live mute/camera status. Non-trickle ICE (gather then send SDP).
class CallSession extends ChangeNotifier {
  final String callId;
  final Peer peer;
  final bool isCaller;
  final String? offerSdp;
  final Future<bool> Function(String kind, String? sdp) sendSignal;
  final VoidCallback onClosed;

  RTCPeerConnection? _pc;
  RTCRtpTransceiver? _audioTx;
  RTCRtpTransceiver? _cameraTx;
  RTCRtpTransceiver? _screenTx;
  RTCDataChannel? _ctrl;
  MediaStream? _micStream;
  MediaStream? _camStream;
  MediaStream? _screenStream;
  MediaStreamTrack? _remoteAudioTrack;
  // Placeholder local streams associated with the camera/screen senders so the
  // outgoing SDP carries a real msid (stream id). Without it the peer receives
  // the track with an empty streams list and can't render it (renders black).
  MediaStream? _camLocalStream;
  MediaStream? _screenLocalStream;

  // remote media (bound to renderers in the UI)
  MediaStream? remoteCamera;
  MediaStream? remoteScreen;
  MediaStream? localCamera;
  MediaStream? localScreen;
  int _remoteVideoCount = 0;

  String status = 'connecting…';
  bool muted = false;
  bool deafened = false;
  bool camOn = false;
  bool screenOn = false;
  bool ended = false;
  bool connected = false;
  String camFacing = 'user'; // 'user' (front) or 'environment' (back)

  // remote live state (via ctrl channel)
  bool remoteMic = true;
  bool remoteCamOn = false;
  bool remoteScreenOn = false;
  bool remoteCamMirror = false; // peer's camera is mirrored (front) -> flip to correct it

  CallSession({
    required this.callId,
    required this.peer,
    required this.isCaller,
    required this.offerSdp,
    required this.sendSignal,
    required this.onClosed,
  });

  Future<void> start() async {
    try {
      await _createPc();
      if (isCaller) {
        await _makeOffer();
      } else {
        await _makeAnswer(offerSdp!);
      }
    } catch (e) {
      _setStatus('Call failed: $e');
      end(notifyPeer: false);
    }
  }

  Future<void> _createPc() async {
    _pc = await createPeerConnection({
      'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
      ],
    });

    _pc!.onTrack = (RTCTrackEvent e) {
      final track = e.track;
      if (track.kind == 'audio') {
        // remote audio plays automatically; keep a ref so Deafen can mute it
        _remoteAudioTrack = track;
        track.enabled = !deafened;
        return;
      }
      final stream = e.streams.isNotEmpty ? e.streams.first : null;
      if (stream == null) return;
      // Distinguish the two remote video m-lines by their transceiver mid
      // (audio=0, camera=1, screen=2 — the order we add them).
      final mid = e.transceiver?.mid;
      final isScreen = mid == '2' || (mid == null && _remoteVideoCount > 0);
      _remoteVideoCount++;
      if (isScreen) {
        remoteScreen = stream;
      } else {
        remoteCamera = stream;
      }
      notifyListeners();
    };

    _pc!.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _onConnected();
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _setStatus('Connection failed');
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        if (connected) _setStatus('Reconnecting…');
      }
    };

    // ICE state is more reliable than peer-connection state on some devices, so
    // settle the status from whichever fires first.
    _pc!.onIceConnectionState = (state) {
      if (state == RTCIceConnectionState.RTCIceConnectionStateConnected ||
          state == RTCIceConnectionState.RTCIceConnectionStateCompleted) {
        _onConnected();
      }
    };

    if (isCaller) {
      _ctrl = await _pc!.createDataChannel('ctrl', RTCDataChannelInit());
      _bindCtrl(_ctrl!);
    } else {
      _pc!.onDataChannel = (channel) {
        if (channel.label == 'ctrl') {
          _ctrl = channel;
          _bindCtrl(channel);
        }
      };
    }
  }

  Future<void> _makeOffer() async {
    final mic = await _getMic();
    _audioTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeAudio,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendRecv),
    );
    if (mic != null) await _audioTx!.sender.replaceTrack(mic);
    _camLocalStream = await createLocalMediaStream('filedrop-cam');
    _screenLocalStream = await createLocalMediaStream('filedrop-screen');
    _cameraTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendRecv, streams: [_camLocalStream!]),
    );
    _screenTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendRecv, streams: [_screenLocalStream!]),
    );

    final offer = await _pc!.createOffer();
    await _pc!.setLocalDescription(offer);
    _setStatus('Calling…');
    await _gather();
    final desc = await _pc!.getLocalDescription();
    final ok = await sendSignal('offer', desc?.sdp);
    if (!connected) _setStatus(ok ? 'Ringing…' : "Couldn't reach them");
  }

  Future<void> _makeAnswer(String sdp) async {
    _setStatus('Connecting…');
    await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
    await _assignTransceivers();
    // Associate a stream with our outgoing camera/screen senders so the caller
    // receives them with a real msid and can render them (else: black/no video).
    _camLocalStream = await createLocalMediaStream('filedrop-cam');
    _screenLocalStream = await createLocalMediaStream('filedrop-screen');
    await _cameraTx?.sender.setStreams([_camLocalStream!]);
    await _screenTx?.sender.setStreams([_screenLocalStream!]);
    final mic = await _getMic();
    if (mic != null && _audioTx != null) await _audioTx!.sender.replaceTrack(mic);
    await _audioTx?.setDirection(TransceiverDirection.SendRecv);
    await _cameraTx?.setDirection(TransceiverDirection.SendRecv);
    await _screenTx?.setDirection(TransceiverDirection.SendRecv);

    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);
    await _gather();
    final desc = await _pc!.getLocalDescription();
    final ok = await sendSignal('answer', desc?.sdp);
    if (!connected && !ok) _setStatus("Couldn't reach them");
  }

  Future<void> _assignTransceivers() async {
    final txs = await _pc!.getTransceivers();
    final audios = txs.where((t) => t.receiver.track?.kind == 'audio').toList();
    final videos = txs.where((t) => t.receiver.track?.kind == 'video').toList();
    _audioTx = audios.isNotEmpty ? audios.first : null;
    _cameraTx = videos.isNotEmpty ? videos.first : null;
    _screenTx = videos.length > 1 ? videos[1] : null;
  }

  /// Incoming answer/decline/busy/hangup routed from the service.
  Future<void> handleSignal(String kind, String? sdp) async {
    if (ended) return;
    if (kind == 'answer' && sdp != null) {
      await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'answer'));
    } else if (kind == 'decline') {
      end(message: 'Call declined', notifyPeer: false);
    } else if (kind == 'busy') {
      end(message: 'Busy — try later', notifyPeer: false);
    } else if (kind == 'hangup') {
      end(message: 'Call ended', notifyPeer: false);
    }
  }

  Future<MediaStreamTrack?> _getMic() async {
    if (_micStream != null) return _micStream!.getAudioTracks().first;
    try {
      await Permission.microphone.request();
      _micStream = await navigator.mediaDevices.getUserMedia({
        'audio': {
          'echoCancellation': true,
          'noiseSuppression': true, // voice suppression
          'autoGainControl': true,
        },
        'video': false,
      });
      return _micStream!.getAudioTracks().first;
    } catch (_) {
      return null;
    }
  }

  Future<void> toggleMute() async {
    muted = !muted;
    _micStream?.getAudioTracks().forEach((t) => t.enabled = !muted);
    _sendCtrl();
    notifyListeners();
  }

  Future<void> toggleCamera() async {
    if (camOn) {
      _camStream?.getTracks().forEach((t) => t.stop());
      _camStream = null;
      localCamera = null;
      camOn = false;
      if (_cameraTx != null) await _cameraTx!.sender.replaceTrack(null);
    } else {
      try {
        await Permission.camera.request();
        _camStream = await navigator.mediaDevices.getUserMedia({
          'audio': false,
          'video': {
            'facingMode': 'user',
            'width': {'ideal': 1920},
            'height': {'ideal': 1080},
            'frameRate': {'ideal': 30},
          },
        });
        final track = _camStream!.getVideoTracks().first;
        if (_cameraTx != null) {
          await _cameraTx!.sender.replaceTrack(track);
          await _setMaxBitrate(_cameraTx!.sender, 3000000); // ~3 Mbps for crisp video
        }
        localCamera = _camStream;
        camOn = true;
        camFacing = 'user';
      } catch (_) {
        return;
      }
    }
    _sendCtrl();
    notifyListeners();
  }

  /// Flip between the front and back camera mid-call.
  Future<void> switchCamera() async {
    if (!camOn || _camStream == null) return;
    final tracks = _camStream!.getVideoTracks();
    if (tracks.isEmpty) return;
    try {
      await Helper.switchCamera(tracks.first);
      camFacing = camFacing == 'user' ? 'environment' : 'user';
      _sendCtrl(); // tell the peer whether to flip our video (front is mirrored)
      notifyListeners();
    } catch (_) {}
  }

  Future<void> toggleDeafen() async {
    deafened = !deafened;
    _remoteAudioTrack?.enabled = !deafened;
    if (deafened && !muted) {
      await toggleMute(); // deafening also mutes your mic, like the desktop
    }
    notifyListeners();
  }

  Future<void> toggleScreen() async {
    if (screenOn) {
      _screenStream?.getTracks().forEach((t) => t.stop());
      _screenStream = null;
      localScreen = null;
      screenOn = false;
      if (_screenTx != null) await _screenTx!.sender.replaceTrack(null);
    } else {
      try {
        _screenStream = await navigator.mediaDevices.getDisplayMedia({
          'video': {'frameRate': {'ideal': 30}},
          'audio': false,
        });
        final track = _screenStream!.getVideoTracks().first;
        if (_screenTx != null) {
          await _screenTx!.sender.replaceTrack(track);
          await _setMaxBitrate(_screenTx!.sender, 4000000); // ~4 Mbps so screen text stays sharp
        }
        localScreen = _screenStream;
        screenOn = true;
        // stopped from the system "casting" notification
        track.onEnded = () {
          if (screenOn) toggleScreen();
        };
      } catch (_) {
        return;
      }
    }
    _sendCtrl();
    notifyListeners();
  }

  void _bindCtrl(RTCDataChannel ch) {
    ch.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) _sendCtrl();
    };
    ch.onMessage = (msg) {
      try {
        final s = msg.text;
        // simple csv-free JSON
        final m = _decode(s);
        remoteMic = m['mic'] ?? remoteMic;
        remoteCamOn = m['cam'] ?? remoteCamOn;
        remoteScreenOn = m['screen'] ?? remoteScreenOn;
        remoteCamMirror = m['mir'] ?? remoteCamMirror;
        notifyListeners();
      } catch (_) {}
    };
  }

  void _sendCtrl() {
    if (_ctrl == null) return;
    try {
      _ctrl!.send(RTCDataChannelMessage(_encode({
        'mic': !muted && _micStream != null,
        'cam': camOn,
        'screen': screenOn,
        'mir': camOn && camFacing == 'user', // front camera is mirrored
      })));
    } catch (_) {}
  }

  Future<void> _gather() async {
    if (_pc!.iceGatheringState == RTCIceGatheringState.RTCIceGatheringStateComplete) return;
    final c = Completer<void>();
    Timer? timer;
    _pc!.onIceGatheringState = (s) {
      if (s == RTCIceGatheringState.RTCIceGatheringStateComplete && !c.isCompleted) c.complete();
    };
    timer = Timer(const Duration(milliseconds: 2500), () {
      if (!c.isCompleted) c.complete();
    });
    await c.future;
    timer.cancel();
  }

  void _onConnected() {
    if (connected) {
      _sendCtrl();
      return;
    }
    connected = true;
    _setStatus('In call');
    _sendCtrl(); // resync mute/camera/screen state now that we're up
    _startCallService();
  }

  /// Start the ongoing-call foreground service so the call survives the app
  /// being backgrounded/closed (HyperOS/MIUI kill background apps otherwise).
  Future<void> _startCallService() async {
    try {
      await Permission.notification.request();
    } catch (_) {}
    // One-tap "let it run in the background" — the same exemption WhatsApp/Discord
    // ask for, so calls survive backgrounding without locking the app in recents.
    try {
      if (await Permission.ignoreBatteryOptimizations.isDenied) {
        await Permission.ignoreBatteryOptimizations.request();
      }
    } catch (_) {}
    await startCallService(text: 'In call with ${peer.name}');
  }

  void _setStatus(String s) {
    status = s;
    notifyListeners();
  }

  /// Raise the per-sender encoding bitrate so video looks crisp on good links.
  Future<void> _setMaxBitrate(RTCRtpSender sender, int bps) async {
    try {
      final params = sender.parameters;
      if (params.encodings == null || params.encodings!.isEmpty) {
        params.encodings = [RTCRtpEncoding(maxBitrate: bps)];
      } else {
        for (final enc in params.encodings!) {
          enc.maxBitrate = bps;
        }
      }
      await sender.setParameters(params);
    } catch (_) {}
  }

  /// Hang up. notifyPeer=true sends a hangup to the other side.
  Future<void> end({String? message, bool notifyPeer = true}) async {
    if (ended) return;
    ended = true;
    stopCallService(); // tear down the ongoing-call notification + keep-alive
    if (message != null) status = message;
    if (notifyPeer) sendSignal('hangup', null);
    for (final s in [_micStream, _camStream, _screenStream, _camLocalStream, _screenLocalStream]) {
      s?.getTracks().forEach((t) => t.stop());
      await s?.dispose();
    }
    _micStream = null;
    _camStream = null;
    _screenStream = null;
    _camLocalStream = null;
    _screenLocalStream = null;
    try {
      await _ctrl?.close();
    } catch (_) {}
    try {
      await _pc?.close();
    } catch (_) {}
    _pc = null;
    notifyListeners();
    onClosed();
  }

  // tiny JSON helpers for the ctrl channel
  String _encode(Map<String, bool> m) =>
      '{"mic":${m['mic']},"cam":${m['cam']},"screen":${m['screen']},"mir":${m['mir']}}';
  Map<String, bool> _decode(String s) {
    bool g(String k) => RegExp('"$k"\\s*:\\s*true').hasMatch(s);
    return {'mic': g('mic'), 'cam': g('cam'), 'screen': g('screen'), 'mir': g('mir')};
  }
}
