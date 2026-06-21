import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
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

  // remote media (bound to renderers in the UI)
  MediaStream? remoteCamera;
  MediaStream? remoteScreen;
  MediaStream? localCamera;
  int _remoteVideoCount = 0;

  String status = 'connecting…';
  bool muted = false;
  bool camOn = false;
  bool ended = false;

  // remote live state (via ctrl channel)
  bool remoteMic = true;
  bool remoteCamOn = false;
  bool remoteScreenOn = false;

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
      final stream = e.streams.isNotEmpty ? e.streams.first : null;
      if (track.kind == 'audio') {
        // remote audio is rendered/played by the platform automatically
      } else {
        final idx = _remoteVideoCount++;
        if (idx == 0) {
          remoteCamera = stream;
        } else {
          remoteScreen = stream;
        }
        notifyListeners();
      }
    };

    _pc!.onConnectionState = (state) {
      if (state == RTCPeerConnectionState.RTCPeerConnectionStateConnected) {
        _setStatus('connected');
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateFailed) {
        _setStatus('connection failed');
      } else if (state == RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _setStatus('reconnecting…');
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
    _cameraTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendRecv),
    );
    _screenTx = await _pc!.addTransceiver(
      kind: RTCRtpMediaType.RTCRtpMediaTypeVideo,
      init: RTCRtpTransceiverInit(direction: TransceiverDirection.SendRecv),
    );

    final offer = await _pc!.createOffer();
    await _pc!.setLocalDescription(offer);
    _setStatus('finding network…');
    await _gather();
    final desc = await _pc!.getLocalDescription();
    final sdpLen = desc?.sdp?.length ?? 0;
    _setStatus('calling… (sdp $sdpLen)');
    final ok = await sendSignal('offer', desc?.sdp);
    _setStatus(ok ? 'ringing…' : "couldn't reach device");
  }

  Future<void> _makeAnswer(String sdp) async {
    _setStatus('answering…');
    await _pc!.setRemoteDescription(RTCSessionDescription(sdp, 'offer'));
    await _assignTransceivers();
    final mic = await _getMic();
    if (mic != null && _audioTx != null) await _audioTx!.sender.replaceTrack(mic);
    await _audioTx?.setDirection(TransceiverDirection.SendRecv);
    await _cameraTx?.setDirection(TransceiverDirection.SendRecv);
    await _screenTx?.setDirection(TransceiverDirection.SendRecv);

    final answer = await _pc!.createAnswer();
    await _pc!.setLocalDescription(answer);
    _setStatus('finding network…');
    await _gather();
    final desc = await _pc!.getLocalDescription();
    final sdpLen = desc?.sdp?.length ?? 0;
    _setStatus('sending answer… (sdp $sdpLen)');
    final ok = await sendSignal('answer', desc?.sdp);
    _setStatus(ok ? 'waiting for PC…' : "couldn't reach PC ❌");
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
      _micStream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': false});
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
          'video': {'facingMode': 'user', 'width': 1280, 'height': 720},
        });
        final track = _camStream!.getVideoTracks().first;
        if (_cameraTx != null) await _cameraTx!.sender.replaceTrack(track);
        localCamera = _camStream;
        camOn = true;
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
        'screen': false,
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

  void _setStatus(String s) {
    status = s;
    notifyListeners();
  }

  /// Hang up. notifyPeer=true sends a hangup to the other side.
  Future<void> end({String? message, bool notifyPeer = true}) async {
    if (ended) return;
    ended = true;
    if (message != null) status = message;
    if (notifyPeer) sendSignal('hangup', null);
    for (final s in [_micStream, _camStream]) {
      s?.getTracks().forEach((t) => t.stop());
      await s?.dispose();
    }
    _micStream = null;
    _camStream = null;
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
  String _encode(Map<String, bool> m) => '{"mic":${m['mic']},"cam":${m['cam']},"screen":${m['screen']}}';
  Map<String, bool> _decode(String s) {
    bool g(String k) => RegExp('"$k"\\s*:\\s*true').hasMatch(s);
    return {'mic': g('mic'), 'cam': g('cam'), 'screen': g('screen')};
  }
}
