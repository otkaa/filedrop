import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';
import 'package:flutter/foundation.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';
import 'call.dart';
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

      _relay = RelayClient(
        code: relayCode!,
        deviceId: self.id,
        name: () => self.name,
        fingerprint: () => self.fingerprint,
        onMessage: _onRelayMessage,
        onSignal: _onRelaySignal,
        onReady: (_) => notifyListeners(),
        onCodeTaken: _regenerateRelayCode,
      );
      // fire-and-forget; the client auto-reconnects with backoff on its own
      _relay!.connect();

      _discovery = Discovery(self: self, onMessage: _onDiscovery);
      await _discovery!.start();

      _loadMessages();
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
  void _onIncomingMessage(String fromId, String fromName, String text, int ts) {
    (messages[fromId] ??= []).add(ChatMessage(mine: false, text: text, ts: ts));
    if (activeConvo != fromId) unread[fromId] = (unread[fromId] ?? 0) + 1;
    // make sure the peer shows up even if discovery hasn't seen them
    _saveMessages();
    notifyListeners();
  }

  // --- relay: identify a peer by their CODE (auto-create relay peers) ---
  /// Find or create a relay-only peer keyed by their normalized 8-char code.
  /// Called when a friend messages/calls us first so we can see+reply.
  Peer _ensureRelayPeer(String code, String? fromName) {
    final c = RelayClient.norm(code);
    final existing = peers[c];
    if (existing != null) {
      if (fromName != null && fromName.isNotEmpty && fromName != c) existing.name = fromName;
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

  Future<void> sendMessageTo(String peerId, String text) async {
    text = text.trim();
    if (text.isEmpty) return;
    final ts = DateTime.now().millisecondsSinceEpoch;
    final msg = ChatMessage(mine: true, text: text, ts: ts);
    (messages[peerId] ??= []).add(msg);
    notifyListeners();
    final peer = peers[peerId];
    if (peer == null) {
      msg.failed = true;
      notifyListeners();
      return;
    }
    if (peer.isRelayOnly) {
      // Internet path: fire over the relay WebSocket. The server forwards it;
      // there's no synchronous ack, so we treat a connected relay as delivered.
      final relay = _relay;
      if (relay == null || !relay.connected || peer.relayCode == null) {
        msg.failed = true;
      } else {
        relay.sendTo(peer.relayCode!, {'k': 'msg', 'text': text, 'ts': ts});
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
      });
      if (r['status'] != 200) msg.failed = true;
    } catch (_) {
      msg.failed = true;
    }
    _saveMessages();
    notifyListeners();
  }

  void openConvo(String peerId) {
    activeConvo = peerId;
    unread.remove(peerId);
    notifyListeners();
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
      notifyListeners();
      return;
    }

    // caller gave up before we accepted
    if ((kind == 'hangup' || kind == 'decline' || kind == 'busy') &&
        pendingIncomingCall != null &&
        pendingIncomingCall!['callId'] == callId) {
      pendingIncomingCall = null;
      notifyListeners();
      return;
    }

    if (activeCall == null || activeCall!.callId != callId) return;
    if (activeCall!.peer.id != sig['peerId']) return;
    activeCall!.handleSignal(kind, sig['sdp'] as String?);
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
    _beginCall(inc['callId'] as String, inc['peer'] as Peer, isCaller: false, offerSdp: inc['offerSdp'] as String?);
  }

  void declineCall() {
    final inc = pendingIncomingCall;
    if (inc == null) return;
    pendingIncomingCall = null;
    _postSignal(inc['peer'] as Peer, 'decline', inc['callId'] as String?, null);
    notifyListeners();
  }

  void _beginCall(String callId, Peer peer, {required bool isCaller, String? offerSdp}) {
    final call = CallSession(
      callId: callId,
      peer: peer,
      isCaller: isCaller,
      offerSdp: offerSdp,
      sendSignal: (kind, sdp) => _postSignal(peer, kind, callId, sdp),
      onClosed: () {
        activeCall = null;
        notifyListeners();
      },
    );
    activeCall = call;
    notifyListeners();
    call.start();
    if (isCaller) {
      Timer(const Duration(seconds: 40), () {
        if (activeCall == call && !call.ended && call.status != 'connected') {
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

  List<Peer> get sortedPeers => peers.values.toList()..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  List<Transfer> get sortedTransfers => transfers.values.toList().reversed.toList();
}
