import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:permission_handler/permission_handler.dart';
import 'fcm.dart';
import 'package:uuid/uuid.dart';
import 'call.dart';
import 'call_service.dart';
import 'certs.dart';
import 'discovery.dart';
import 'models.dart';
import 'relay_client.dart';
import 'sender.dart' as net;
import 'server.dart';
import 'updater.dart' show kAppVersion;

const _peerTimeout = 12000;

// Code alphabet per the shared wire spec — no I/L/O/0/1.
const _codeAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

String _generateRelayCode() {
  final rng = Random.secure();
  final sb = StringBuffer();
  for (var i = 0; i < 8; i++) {
    sb.write(_codeAlphabet[rng.nextInt(_codeAlphabet.length)]);
  }
  return sb.toString();
}

/// Group an 8-char code as "XXXX-XXXX" for display. Matching ignores the dash.
String formatRelayCode(String code) {
  final c = RelayClient.norm(code);
  if (c.length <= 4) return c;
  if (c.length <= 8) return '${c.substring(0, 4)}-${c.substring(4)}';
  return '${c.substring(0, 4)}-${c.substring(4, 8)}';
}

/// Single app-wide service: identity, discovery, server, peers, transfers, chat.
class FiledropService extends ChangeNotifier {
  static final FiledropService instance = FiledropService._();
  FiledropService._();

  late SharedPreferences _prefs;
  late SelfInfo self;
  late TlsCert tls;
  late String downloadDir;
  Discovery? _discovery;
  ReceiveServer? _server;
  RelayClient? _relay;
  final _uuid = Uuid();
  String? _fcmToken; // FCM push token registered with the relay (for offline wake)

  /// Our persistent relay code (raw 8 chars, uppercase). Null until init().
  String? relayCode;

  final peers = <String, Peer>{};
  final transfers = <String, Transfer>{};
  final messages = <String, List<ChatMessage>>{}; // peerId -> messages
  final unread = <String, int>{};
  String? activeConvo; // peerId currently open

  IncomingRequest? pendingRequest;
  Completer<bool>? _approvalCompleter;

  // calls
  CallSession? activeCall;
  Map<String, dynamic>? pendingIncomingCall; // {callId, peer, offerSdp, peerName}
  // Set when the user taps Answer on an FCM-woken call BEFORE the offer SDP has
  // arrived over the socket (the relay replays it on connect). The offer handler
  // auto-accepts when it sees a matching callId. '*' = accept the next offer.
  String? _answeredCallId;

  bool started = false;
  String? startError;

  Future<void> init() async {
    try {
      _prefs = await SharedPreferences.getInstance();

      final id = _prefs.getString('deviceId') ?? (_uuid.v4()..toString());
      await _prefs.setString('deviceId', id);
      final name = _prefs.getString('deviceName') ?? 'My Phone';

      // cert (persisted so the fingerprint stays stable)
      var certPem = _prefs.getString('certPem');
      var keyPem = _prefs.getString('keyPem');
      String fingerprint;
      if (certPem == null || keyPem == null) {
        final c = generateCert(name);
        certPem = c.certPem;
        keyPem = c.keyPem;
        fingerprint = c.fingerprint;
        await _prefs.setString('certPem', certPem);
        await _prefs.setString('keyPem', keyPem);
        await _prefs.setString('certFp', fingerprint);
      } else {
        fingerprint = _prefs.getString('certFp') ?? fingerprintOfPem(certPem);
      }
      tls = TlsCert(certPem, keyPem, fingerprint);

      final ext = await getExternalStorageDirectory();
      final base = ext?.path ?? (await getApplicationDocumentsDirectory()).path;
      downloadDir = p.join(base, 'Filedrop');
      await Directory(downloadDir).create(recursive: true);

      self = SelfInfo(id: id, name: name, port: 53319, fingerprint: fingerprint, os: 'Android', version: kAppVersion);

      _server = ReceiveServer(
        tls: tls,
        self: self,
        requestApproval: _approval,
        onMessage: _onIncomingMessage,
        onSignal: _onSignal,
        downloadDir: () => downloadDir,
        onTransfer: _onTransfer,
      );
      final port = await _server!.start(53319);
      self.port = port;

      // Relay code: generate once with a secure RNG, then persist forever.
      var code = _prefs.getString('relayCode');
      if (code == null || RelayClient.norm(code).length != 8) {
        code = _generateRelayCode();
        await _prefs.setString('relayCode', code);
      }
      relayCode = RelayClient.norm(code);

      _fcmToken = await getFcmToken(); // push token so a closed app still gets calls/messages

      _relay = RelayClient(
        code: relayCode!,
        deviceId: self.id,
        name: () => self.name,
        fingerprint: () => self.fingerprint,
        fcmToken: () => _fcmToken,
        onMessage: _onRelayMessage,
        onSignal: _onRelaySignal,
        onAck: _onRelayAck,
        onReady: (_) {
          _flushOutbox(); // send any messages queued while we were offline
          notifyListeners();
        },
        onCodeTaken: _regenerateRelayCode,
      );
      // fire-and-forget; the client auto-reconnects with backoff on its own
      _relay!.connect();

      // re-register if FCM rotates our push token
      fcmTokenRefresh.listen((t) {
        _fcmToken = t;
        _relay?.reregister();
      });

      // Native CallKit-style ringing screen handles incoming calls: it wakes /
      // lights up the (locked) screen, rings, and vibrates per the ringer mode,
      // and surfaces Answer/Decline. The user's choice comes back as an event.
      FlutterCallkitIncoming.onEvent.listen((event) {
        if (event == null) return;
        switch (event.event) {
          case Event.actionCallAccept:
            _onCallkitAccept(event.body);
            break;
          case Event.actionCallDecline:
          case Event.actionCallTimeout:
          case Event.actionCallEnded:
            declineCall();
            break;
          default:
            break;
        }
      });

      _discovery = Discovery(self: self, onMessage: _onDiscovery);
      await _discovery!.start();

      _loadRelayPeers(); // restore code contacts before their chats load
      _loadMessages();
      _rebuildOutbox(); // index outgoing msgs + re-queue any unsent ones
      Permission.notification.request().ignore(); // so chat notifications can show
      Timer.periodic(const Duration(seconds: 5), (_) => _prune());

      started = true;
      notifyListeners();
    } catch (e) {
      startError = '$e';
      notifyListeners();
    }
  }

  // --- discovery ---
  void _onDiscovery(Map<String, dynamic> msg, String ip) {
    final id = '${msg['id']}';
    if (msg['type'] == 'bye') {
      if (peers.remove(id) != null) notifyListeners();
      return;
    }
    final port = (msg['port'] is num) ? (msg['port'] as num).toInt() : 0;
    if (port < 1 || port > 65535) return;
    peers[id] = Peer(
      id: id,
      name: '${msg['name'] ?? 'Unknown device'}',
      ip: ip,
      port: port,
      fingerprint: msg['fingerprint']?.toString(),
      os: msg['os']?.toString(),
      version: msg['version']?.toString(),
      manual: peers[id]?.manual ?? false,
    );
    notifyListeners();
  }

  void _prune() {
    final now = DateTime.now().millisecondsSinceEpoch;
    var changed = false;
    peers.removeWhere((k, v) {
      final stale = !v.manual && now - v.lastSeen > _peerTimeout;
      if (stale) changed = true;
      return stale;
    });
    if (changed) notifyListeners();
  }

  // --- incoming approval ---
  Future<bool> _approval(IncomingRequest req) {
    final c = Completer<bool>();
    pendingRequest = req;
    _approvalCompleter = c;
    notifyListeners();
    return c.future;
  }

  void respondToRequest(bool accept) {
    pendingRequest = null;
    final c = _approvalCompleter;
    _approvalCompleter = null;
    notifyListeners();
    c?.complete(accept);
  }

  // --- transfers ---
  void _onTransfer(Transfer t) {
    transfers[t.id] = t;
    notifyListeners();
  }

  // --- chat ---
  bool inForeground = true; // set by the UI's lifecycle observer

  void _onIncomingMessage(String fromId, String fromName, String text, int ts) {
    (messages[fromId] ??= []).add(ChatMessage(mine: false, text: text, ts: ts));
    if (activeConvo != fromId) unread[fromId] = (unread[fromId] ?? 0) + 1;
    _saveMessages();
    // Notify unless you're already looking at this conversation in the foreground.
    if (!inForeground || activeConvo != fromId) {
      final name = peers[fromId]?.name ?? fromName;
      showMessageNotification(name, text, fromId.hashCode & 0x7fffffff);
    }
    notifyListeners();
  }

  // --- relay: identify a peer by their CODE (auto-create relay peers) ---
  /// Find or create a relay-only peer keyed by their normalized 8-char code.
  /// Called when a friend messages/calls us first so we can see+reply.
  Peer _ensureRelayPeer(String code, String? fromName) {
    final c = RelayClient.norm(code);
    final existing = peers[c];
    if (existing != null) {
      if (fromName != null && fromName.isNotEmpty && fromName != c) {
        existing.name = fromName;
        _saveRelayPeers();
      }
      return existing;
    }
    final peer = Peer(
      id: c,
      name: (fromName != null && fromName.isNotEmpty) ? fromName : formatRelayCode(c),
      ip: '',
      port: 0,
      isRelayOnly: true,
      relayCode: c,
      manual: true,
    );
    peers[c] = peer;
    _saveRelayPeers();
    notifyListeners();
    return peer;
  }

  // Incoming relay chat: feed the SAME path the HTTPS server uses.
  void _onRelayMessage(String from, String fromName, Map<String, dynamic> payload) {
    final peer = _ensureRelayPeer(from, fromName);
    final text = payload['text'];
    if (text is! String) return;
    final ts = (payload['ts'] is num) ? (payload['ts'] as num).toInt() : DateTime.now().millisecondsSinceEpoch;
    _onIncomingMessage(peer.id, peer.name, text, ts);
    final code = peer.relayCode;
    if (code == null) return;
    final id = payload['id'];
    if (id is String) _relay?.sendTo(code, {'k': 'ack', 'ack': 'delivered', 'id': id}); // ✓✓ for them
    // if you're already looking at this chat, it's read immediately (✓✓ blue)
    if (inForeground && activeConvo == peer.id) {
      _relay?.sendTo(code, {'k': 'ack', 'ack': 'read'});
    }
  }

  // Server says our code is taken by a different live device: mint a new one.
  String _regenerateRelayCode() {
    final fresh = _generateRelayCode();
    relayCode = fresh;
    _prefs.setString('relayCode', fresh);
    notifyListeners();
    return fresh;
  }

  // Incoming relay call signaling: map payload.sig -> kind, peerId = senderCode,
  // then dispatch into the SAME _onSignal path the HTTPS server uses.
  void _onRelaySignal(String from, String fromName, Map<String, dynamic> payload) {
    final peer = _ensureRelayPeer(from, fromName);
    final sig = payload['sig'];
    if (sig is! String) return;
    // mirror the desktop allow-list: ignore any signal kind we don't handle.
    const allowed = {'offer', 'answer', 'decline', 'busy', 'hangup'};
    if (!allowed.contains(sig)) return;
    final sdp = payload['sdp'] is String ? payload['sdp'] as String : null;
    _onSignal({
      'peerId': peer.id,
      'peerName': peer.name,
      'kind': sig,
      'callId': payload['callId']?.toString(),
      'sdp': sdp,
      // no peerIp/peerPort/peerFingerprint — _resolvePeer falls back to the
      // relay peer we just ensured is in the peers map.
    });
  }

  // Receipt tracking for outgoing messages: id -> the message (so delivery/read
  // acks can flip its status), and an outbox of relay sends queued while offline.
  final Map<String, ChatMessage> _outById = {};
  final List<Map<String, dynamic>> _outbox = []; // {code, payload, msg}

  Future<void> sendMessageTo(String peerId, String text) async {
    text = text.trim();
    if (text.isEmpty) return;
    final ts = DateTime.now().millisecondsSinceEpoch;
    final id = _uuid.v4();
    // status: pending (⏳) → sent (✓) → delivered (✓✓) → read (✓✓ blue)
    final msg = ChatMessage(mine: true, text: text, ts: ts, id: id, status: 'pending');
    (messages[peerId] ??= []).add(msg);
    _outById[id] = msg;
    notifyListeners();
    final peer = peers[peerId];
    if (peer == null) {
      msg.failed = true;
      notifyListeners();
      return;
    }
    if (peer.isRelayOnly) {
      final relay = _relay;
      final payload = {'k': 'msg', 'text': text, 'ts': ts, 'id': id};
      if (relay != null && relay.connected && peer.relayCode != null) {
        relay.sendTo(peer.relayCode!, payload);
        msg.status = 'sent';
      } else if (peer.relayCode != null) {
        // You're offline / relay down — keep the hourglass and send on reconnect.
        _outbox.add({'code': peer.relayCode!, 'payload': payload, 'msg': msg});
      } else {
        msg.failed = true;
      }
      _saveMessages();
      notifyListeners();
      return;
    }
    try {
      final r = await net.postJson(peer, '/api/message', {
        'from': {'id': self.id, 'name': self.name, 'os': self.os, 'port': self.port, 'fingerprint': self.fingerprint},
        'text': text,
        'ts': ts,
        'id': id,
      });
      msg.status = (r['status'] == 200) ? 'sent' : 'pending';
      if (r['status'] != 200) msg.failed = true;
    } catch (_) {
      msg.failed = true;
    }
    _saveMessages();
    notifyListeners();
  }

  // Send messages that were queued while the relay was down, once it reconnects.
  void _flushOutbox() {
    final relay = _relay;
    if (_outbox.isEmpty || relay == null || !relay.connected) return;
    final queued = List<Map<String, dynamic>>.from(_outbox);
    _outbox.clear();
    for (final q in queued) {
      relay.sendTo(q['code'] as String, q['payload'] as Map<String, dynamic>);
      (q['msg'] as ChatMessage).status = 'sent';
    }
    _saveMessages();
    notifyListeners();
  }

  // A delivery/read receipt came back from a peer.
  void _onRelayAck(String from, Map<String, dynamic> payload) {
    final ack = payload['ack'];
    if (ack == 'delivered') {
      final id = payload['id'];
      final m = (id is String) ? _outById[id] : null;
      if (m != null && m.status == 'sent') {
        m.status = 'delivered';
        _saveMessages();
        notifyListeners();
      }
    } else if (ack == 'read') {
      // they opened our chat — everything we've sent them is read
      final list = messages[from];
      var changed = false;
      for (final m in list ?? const <ChatMessage>[]) {
        if (m.mine && (m.status == 'sent' || m.status == 'delivered')) {
          m.status = 'read';
          changed = true;
        }
      }
      if (changed) {
        _saveMessages();
        notifyListeners();
      }
    }
  }

  void openConvo(String peerId) {
    activeConvo = peerId;
    unread.remove(peerId);
    // tell the sender we've read their messages (their ticks turn blue)
    final peer = peers[peerId];
    if (peer != null && peer.isRelayOnly && peer.relayCode != null) {
      _relay?.sendTo(peer.relayCode!, {'k': 'ack', 'ack': 'read'});
    }
    notifyListeners();
  }

  // After loading saved chats, index our outgoing messages by id (so late acks
  // still update them) and re-queue any that never sent (status 'pending').
  void _rebuildOutbox() {
    messages.forEach((peerId, list) {
      final peer = peers[peerId];
      for (final m in list) {
        if (!m.mine || m.id == null) continue;
        _outById[m.id!] = m;
        if (m.status == 'pending' && peer != null && peer.isRelayOnly && peer.relayCode != null) {
          _outbox.add({
            'code': peer.relayCode!,
            'payload': {'k': 'msg', 'text': m.text, 'ts': m.ts, 'id': m.id},
            'msg': m,
          });
        }
      }
    });
  }

  void closeConvo() {
    activeConvo = null;
  }

  // --- calls (signaling relay; media lives in CallSession) ---
  void _onSignal(Map<String, dynamic> sig) {
    final kind = sig['kind'] as String;
    final callId = sig['callId'] as String?;
    final peer = _resolvePeer(sig);

    if (kind == 'offer') {
      if (activeCall != null || pendingIncomingCall != null) {
        if (peer != null) _postSignal(peer, 'busy', callId, null);
        return;
      }
      if (peer == null) return;
      pendingIncomingCall = {'callId': callId, 'peer': peer, 'offerSdp': sig['sdp'], 'peerName': sig['peerName']};
      // If the user already tapped Answer on an FCM-woken ring (the offer is only
      // now arriving over the socket), accept straight away instead of re-ringing.
      if (_answeredCallId != null && (_answeredCallId == '*' || _answeredCallId == callId)) {
        _answeredCallId = null;
        acceptCall();
      } else {
        _showIncomingCallUi(callId ?? _uuid.v4(), '${sig['peerName'] ?? peer.name}');
      }
      notifyListeners();
      return;
    }

    // caller gave up before we accepted
    if ((kind == 'hangup' || kind == 'decline' || kind == 'busy') &&
        pendingIncomingCall != null &&
        pendingIncomingCall!['callId'] == callId) {
      pendingIncomingCall = null;
      FlutterCallkitIncoming.endAllCalls();
      notifyListeners();
      return;
    }

    if (activeCall == null || activeCall!.callId != callId) return;
    if (activeCall!.peer.id != sig['peerId']) return;
    activeCall!.handleSignal(kind, sig['sdp'] as String?);
  }

  // The user tapped Answer on the native ring screen.
  Future<void> _onCallkitAccept(dynamic body) async {
    if (pendingIncomingCall != null) {
      acceptCall(); // the offer already arrived over the live socket
      return;
    }
    // App was woken from a fully-closed state by FCM. The push is only a wake
    // signal — the offer SDP is far too big for FCM (4K cap), so the relay is
    // holding it and replays it over the socket the moment we register. Mark the
    // call answered, make sure the relay is connecting, and wait for the offer to
    // land (the offer handler auto-accepts on a matching callId).
    final extra = (body is Map) ? body['extra'] : null;
    final fromCode = RelayClient.norm('${(extra is Map) ? extra['fromCode'] ?? '' : ''}');
    final callId = '${(extra is Map) ? extra['callId'] ?? '' : ''}';
    _answeredCallId = callId.isNotEmpty ? callId : '*';
    if (fromCode.length == 8) _ensureRelayPeer(fromCode, null);
    _relay?.connect(); // idempotent; ensures the socket is coming up
    for (var i = 0; i < 75; i++) {
      // ~15s
      if (activeCall != null) return; // offer arrived and auto-accepted
      if (pendingIncomingCall != null) {
        acceptCall();
        return;
      }
      await Future.delayed(const Duration(milliseconds: 200));
    }
    // The held offer never reached us — give up cleanly so the ring stops.
    _answeredCallId = null;
    try {
      await FlutterCallkitIncoming.endAllCalls();
    } catch (_) {}
  }

  // Show the native ringing call screen (lock-screen wake + ringtone + vibration
  // handled by the OS). Answer/Decline come back via FlutterCallkitIncoming.onEvent.
  Future<void> _showIncomingCallUi(String callId, String name) async {
    try {
      await FlutterCallkitIncoming.showCallkitIncoming(CallKitParams(
        id: callId,
        nameCaller: name,
        appName: 'Filedrop',
        handle: name,
        type: 0, // audio call
        textAccept: 'Answer',
        textDecline: 'Decline',
        android: const AndroidParams(
          isCustomNotification: true,
          isShowLogo: false,
          isShowCallID: false,
          isShowFullLockedScreen: true, // ring screen over the lock screen
          ringtonePath: 'system_ringtone_default',
          backgroundColor: '#171A21',
          actionColor: '#4F7CFF',
        ),
        ios: const IOSParams(handleType: 'generic', supportsVideo: false),
      ));
    } catch (_) {}
  }

  Peer? _resolvePeer(Map<String, dynamic> sig) {
    final known = peers[sig['peerId']];
    if (known != null && known.fingerprint != null) return known;
    if (sig['peerIp'] != null && sig['peerPort'] != null && sig['peerFingerprint'] != null) {
      return Peer(
        id: '${sig['peerId']}',
        name: '${sig['peerName']}',
        ip: _normIp('${sig['peerIp']}'),
        port: (sig['peerPort'] as num).toInt(),
        fingerprint: '${sig['peerFingerprint']}',
        manual: true,
      );
    }
    return known;
  }

  String _normIp(String ip) => ip.replaceFirst(RegExp(r'^::ffff:'), '');

  Future<bool> _postSignal(Peer peer, String kind, String? callId, String? sdp) async {
    // Relay-only peers: route signaling over the relay WebSocket. The
    // CallSession is transport-agnostic; only the carrier changes.
    if (peer.isRelayOnly) {
      final relay = _relay;
      if (relay == null || !relay.connected || peer.relayCode == null) return false;
      relay.sendTo(peer.relayCode!, {'k': 'rtc', 'sig': kind, 'callId': callId, 'sdp': sdp});
      return true;
    }
    try {
      final r = await net.postJson(peer, '/api/rtc', {
        'from': {'id': self.id, 'name': self.name, 'os': self.os, 'port': self.port, 'fingerprint': self.fingerprint},
        'kind': kind,
        'callId': callId,
        'sdp': sdp,
      });
      return r['status'] == 200;
    } catch (_) {
      return false;
    }
  }

  String? startCall(String peerId) {
    if (activeCall != null) return 'Already in a call';
    final peer = peers[peerId];
    if (peer == null) return 'Device unavailable';
    _beginCall(_uuid.v4(), peer, isCaller: true, offerSdp: null);
    return null;
  }

  void acceptCall() {
    final inc = pendingIncomingCall;
    if (inc == null) return;
    pendingIncomingCall = null;
    FlutterCallkitIncoming.endAllCalls();
    _beginCall(inc['callId'] as String, inc['peer'] as Peer, isCaller: false, offerSdp: inc['offerSdp'] as String?);
  }

  void declineCall() {
    _answeredCallId = null; // cancel any FCM-woken accept still waiting for the offer
    final inc = pendingIncomingCall;
    if (inc == null) return;
    pendingIncomingCall = null;
    FlutterCallkitIncoming.endAllCalls();
    _postSignal(inc['peer'] as Peer, 'decline', inc['callId'] as String?, null);
    notifyListeners();
  }

  void _beginCall(String callId, Peer peer, {required bool isCaller, String? offerSdp}) {
    late CallSession call;
    call = CallSession(
      callId: callId,
      peer: peer,
      isCaller: isCaller,
      offerSdp: offerSdp,
      sendSignal: (kind, sdp) => _postSignal(peer, kind, callId, sdp),
      onClosed: () {
        call.removeListener(notifyListeners);
        activeCall = null;
        notifyListeners();
      },
    );
    // Bridge the call's own notifications into the service. The call UI listens
    // to `service`, so without this its mute/camera/screen buttons and status
    // would never repaint when the CallSession changes.
    call.addListener(notifyListeners);
    activeCall = call;
    notifyListeners();
    call.start();
    if (isCaller) {
      Timer(const Duration(seconds: 40), () {
        if (activeCall == call && !call.ended && !call.connected) {
          call.end(message: 'No answer', notifyPeer: false);
        }
      });
    }
  }

  // --- sending files ---
  Future<net.SendOutcome> sendFilesTo(String peerId, List<File> files) async {
    final peer = peers[peerId];
    if (peer == null) return net.SendOutcome(false, error: 'Device unavailable');
    if (peer.isRelayOnly) {
      // File transfer over the relay is a later phase; only chat + calls work
      // for internet (code) peers right now.
      return net.SendOutcome(false, error: 'File transfer over the internet is coming soon. For now, code peers support chat and calls only.');
    }
    return net.sendFiles(peer, self, files, onTransfer: _onTransfer);
  }

  // --- add a friend by their relay code (internet) ---
  Future<String?> addByRelayCode(String rawCode) async {
    final code = RelayClient.norm(rawCode);
    if (code.length != 8) return 'Enter the full 8-character code.';
    if (code == relayCode) return 'That is your own code.';
    final relay = _relay;
    if (relay == null) return 'Relay not ready yet — try again in a moment.';
    final res = await relay.lookup(code);
    final name = res['name'] is String ? res['name'] as String : null;
    // Add the peer even if they're offline right now (mirrors desktop): you add a
    // friend's code once and can reach them whenever you're both online.
    final existing = peers[code];
    if (existing != null) {
      if (name != null && name.isNotEmpty) existing.name = name;
      existing.isRelayOnly = true;
      existing.relayCode = code;
      _saveRelayPeers();
      notifyListeners();
      return null;
    }
    peers[code] = Peer(
      id: code,
      name: (name != null && name.isNotEmpty) ? name : formatRelayCode(code),
      ip: '',
      port: 0,
      isRelayOnly: true,
      relayCode: code,
      manual: true,
    );
    _saveRelayPeers();
    notifyListeners();
    return null;
  }

  // --- manual add ---
  Future<String?> addByAddress(String host, int port) async {
    try {
      final peer = await net.probe(host, port);
      if (peer.id == self.id) return 'That is this device';
      peer.manual = true;
      peers[peer.id] = peer;
      notifyListeners();
      return null;
    } catch (e) {
      return "Timed out — make sure that device has Filedrop open and is on the same Wi-Fi or VPN as you ($host:$port).";
    }
  }

  Future<void> setName(String name) async {
    name = name.trim();
    if (name.isEmpty) return;
    self.name = name;
    await _prefs.setString('deviceName', name);
    _discovery?.announceNow();
    notifyListeners();
  }

  // --- own addresses ---
  Future<List<Map<String, String>>> localAddresses() async {
    final out = <Map<String, String>>[];
    try {
      final ifaces = await NetworkInterface.list(type: InternetAddressType.IPv4, includeLoopback: false);
      for (final ni in ifaces) {
        for (final a in ni.addresses) {
          out.add({'address': a.address, 'label': ni.name});
        }
      }
    } catch (_) {}
    return out;
  }

  // --- persistence of code (relay) peers, so contacts + their chat history
  // survive an app restart (LAN peers are transient and re-discovered). ---
  void _saveRelayPeers() {
    final list = peers.values
        .where((p) => p.isRelayOnly && p.relayCode != null)
        .map((p) => {'code': p.relayCode, 'name': p.name})
        .toList();
    _prefs.setString('relayPeers', jsonEncode(list));
  }

  void _loadRelayPeers() {
    final raw = _prefs.getString('relayPeers');
    if (raw == null) return;
    try {
      for (final e in (jsonDecode(raw) as List)) {
        final code = RelayClient.norm('${(e as Map)['code']}');
        if (code.length != 8 || peers.containsKey(code)) continue;
        final nm = e['name'];
        peers[code] = Peer(
          id: code,
          name: (nm is String && nm.isNotEmpty) ? nm : formatRelayCode(code),
          ip: '',
          port: 0,
          isRelayOnly: true,
          relayCode: code,
          manual: true,
        );
      }
    } catch (_) {}
  }

  // --- persistence of chat ---
  void _loadMessages() {
    final raw = _prefs.getString('messages');
    if (raw == null) return;
    try {
      final j = jsonDecode(raw) as Map<String, dynamic>;
      j.forEach((k, v) {
        messages[k] = (v as List).map((e) => ChatMessage.fromJson(e as Map<String, dynamic>)).toList();
      });
    } catch (_) {}
  }

  Timer? _saveTimer;
  void _saveMessages() {
    _saveTimer?.cancel();
    _saveTimer = Timer(const Duration(milliseconds: 500), () {
      final j = messages.map((k, v) => MapEntry(k, v.map((m) => m.toJson()).toList()));
      _prefs.setString('messages', jsonEncode(j));
    });
  }

  // Only code (relay) contacts are shown — we connect by code now, so
  // same-network LAN-discovered devices are no longer auto-listed.
  List<Peer> get sortedPeers => peers.values.where((p) => p.isRelayOnly).toList()
    ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  List<Transfer> get sortedTransfers => transfers.values.toList().reversed.toList();
}
