import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';

/// Rendezvous + relay client. Opens ONE outbound WebSocket to the relay server
/// (works through NAT, no port-forwarding). Registers our code on every (re)open,
/// auto-reconnects with backoff, and pings every ~25s as an app-level keepalive.
///
/// The server forwards opaque app payloads addressed by CODE, so chat + call
/// signaling ride over the relay exactly like they ride over LAN HTTPS.
class RelayClient {
  static const String relayUrl = 'wss://filedrop-relay.onrender.com';

  String code; // our 8-char code (uppercase); regenerated on a code-taken clash
  final String deviceId;
  final String Function() name; // late-bound so a rename is picked up on re-register
  final String? Function() fingerprint;

  /// Called when the server rejects our code as code-taken; the host should
  /// regenerate + persist a fresh code and return it (we then re-register).
  final String Function()? onCodeTaken;

  /// Incoming chat message from a peer (payload.k == 'msg').
  final void Function(String from, String fromName, Map<String, dynamic> payload) onMessage;

  /// Incoming call signaling from a peer (payload.k == 'rtc').
  final void Function(String from, String fromName, Map<String, dynamic> payload) onSignal;

  /// Delivery/read receipt from a peer (payload.k == 'ack').
  final void Function(String from, Map<String, dynamic> payload)? onAck;

  /// Fired once we're registered (and on every successful re-register).
  final void Function(String code)? onReady;

  WebSocket? _ws;
  bool _closed = false;
  bool _connecting = false;
  int _backoffIndex = 0;
  Timer? _reconnectTimer;
  Timer? _pingTimer;

  static const _backoffsMs = [1000, 2000, 5000, 10000];

  // pending lookups keyed by normalized code
  final _pendingLookups = <String, List<Completer<Map<String, dynamic>>>>{};

  RelayClient({
    required this.code,
    required this.deviceId,
    required this.name,
    required this.fingerprint,
    required this.onMessage,
    required this.onSignal,
    this.onAck,
    this.onReady,
    this.onCodeTaken,
  });

  bool get connected => _ws != null;

  /// Normalize a code the way the server does: uppercase, strip non-alphanumerics.
  static String norm(String code) =>
      code.toUpperCase().replaceAll(RegExp(r'[^A-Z0-9]'), '');

  Future<void> connect() async {
    _closed = false;
    await _open();
  }

  Future<void> _open() async {
    if (_closed || _connecting || _ws != null) return;
    _connecting = true;
    try {
      final ws = await WebSocket.connect(relayUrl);
      _ws = ws;
      _connecting = false;
      _backoffIndex = 0;
      _register();
      _startPing();
      ws.listen(
        _onData,
        onDone: _onClosed,
        onError: (_) => _onClosed(),
        cancelOnError: true,
      );
    } catch (e) {
      _connecting = false;
      if (kDebugMode) debugPrint('relay connect failed: $e');
      _scheduleReconnect();
    }
  }

  void _register() {
    _send({
      'type': 'register',
      'code': code,
      'deviceId': deviceId,
      'name': name(),
      'fingerprint': fingerprint(),
    });
  }

  void _startPing() {
    _pingTimer?.cancel();
    _pingTimer = Timer.periodic(const Duration(seconds: 25), (_) {
      _send({'type': 'ping'});
    });
  }

  void _onData(dynamic data) {
    Map<String, dynamic> msg;
    try {
      msg = jsonDecode(data as String) as Map<String, dynamic>;
    } catch (_) {
      return;
    }
    switch (msg['type']) {
      case 'registered':
        onReady?.call('${msg['code'] ?? code}');
        break;

      case 'register-failed':
        // A different live device owns this code. Regenerate + persist a fresh
        // one (via the host) and re-register immediately.
        if (kDebugMode) debugPrint('relay register-failed: ${msg['reason']}');
        final fresh = onCodeTaken?.call();
        if (fresh != null && fresh.isNotEmpty) {
          code = norm(fresh);
          _register();
        }
        break;

      case 'from':
        {
          final from = norm('${msg['from'] ?? ''}');
          final fromName = msg['fromName'] is String ? msg['fromName'] as String : from;
          final payload = msg['payload'];
          if (from.isEmpty || payload is! Map) return;
          final p = payload.cast<String, dynamic>();
          final k = p['k'];
          if (k == 'msg') {
            onMessage(from, fromName, p);
          } else if (k == 'rtc') {
            onSignal(from, fromName, p);
          } else if (k == 'ack') {
            onAck?.call(from, p);
          }
          break;
        }

      case 'lookup-result':
        {
          final c = norm('${msg['code'] ?? ''}');
          final waiters = _pendingLookups.remove(c);
          if (waiters != null) {
            for (final w in waiters) {
              if (!w.isCompleted) w.complete(msg);
            }
          }
          break;
        }

      case 'peer-offline':
        // Best-effort transport; the app surfaces failures via the chat
        // message's 'failed' flag / call timeout. Nothing to do here.
        break;

      case 'pong':
        break;
    }
  }

  void _onClosed() {
    _ws = null;
    _pingTimer?.cancel();
    _pingTimer = null;
    if (!_closed) _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed) return;
    _reconnectTimer?.cancel();
    final ms = _backoffsMs[_backoffIndex.clamp(0, _backoffsMs.length - 1)];
    if (_backoffIndex < _backoffsMs.length - 1) _backoffIndex++;
    _reconnectTimer = Timer(Duration(milliseconds: ms), _open);
  }

  void _send(Map<String, dynamic> obj) {
    final ws = _ws;
    if (ws == null) return;
    try {
      ws.add(jsonEncode(obj));
    } catch (_) {}
  }

  /// Send an app payload to a peer addressed by their code.
  void sendTo(String peerCode, Map<String, dynamic> payload, {String? ref}) {
    final m = <String, dynamic>{
      'type': 'to',
      'to': norm(peerCode),
      'payload': payload,
    };
    if (ref != null) m['ref'] = ref;
    _send(m);
  }

  /// Ask the server whether a code is online. Resolves with the raw
  /// 'lookup-result' map, or {'online': false} if the relay is unreachable / times out.
  Future<Map<String, dynamic>> lookup(String peerCode) {
    final c = norm(peerCode);
    final completer = Completer<Map<String, dynamic>>();
    if (_ws == null) {
      // Not connected: can't look up. Try to (re)connect for next time.
      if (!_closed) _open();
      return Future.value({'type': 'lookup-result', 'code': c, 'online': false});
    }
    (_pendingLookups[c] ??= []).add(completer);
    _send({'type': 'lookup', 'code': c});
    return completer.future.timeout(const Duration(seconds: 8), onTimeout: () {
      _pendingLookups[c]?.remove(completer);
      if (_pendingLookups[c]?.isEmpty ?? false) _pendingLookups.remove(c);
      return {'type': 'lookup-result', 'code': c, 'online': false};
    });
  }

  void dispose() {
    _closed = true;
    _reconnectTimer?.cancel();
    _pingTimer?.cancel();
    try {
      _ws?.close();
    } catch (_) {}
    _ws = null;
  }
}
