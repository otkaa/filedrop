import 'dart:async';
import 'dart:convert';
import 'dart:io';

const protocol = 'filedrop/1';
const multicastAddr = '224.0.0.168';
const discoveryPort = 53318;
const _announceInterval = Duration(seconds: 3);

class SelfInfo {
  final String id;
  String name;
  int port;
  String fingerprint;
  String os;
  String version;
  SelfInfo({
    required this.id,
    required this.name,
    required this.port,
    required this.fingerprint,
    this.os = 'Android',
    this.version = '1.0.0',
  });
}

/// LAN discovery over UDP multicast. Mirrors the desktop announce/discover/bye
/// protocol so the phone and PC see each other automatically.
class Discovery {
  final SelfInfo self;
  final void Function(Map<String, dynamic> msg, String fromIp) onMessage;
  RawDatagramSocket? _socket;
  Timer? _timer;
  bool stealth = false;

  Discovery({required this.self, required this.onMessage});

  Future<void> start() async {
    final socket = await RawDatagramSocket.bind(
      InternetAddress.anyIPv4,
      discoveryPort,
      reuseAddress: true,
    );
    _socket = socket;
    socket.multicastLoopback = false;
    try {
      socket.joinMulticast(InternetAddress(multicastAddr));
    } catch (_) {}
    socket.listen(_onEvent);
    _send('discover');
    _send('announce');
    _timer = Timer.periodic(_announceInterval, (_) {
      if (!stealth) _send('announce');
    });
  }

  void stop() {
    _timer?.cancel();
    try {
      if (!stealth) _send('bye');
    } catch (_) {}
    _socket?.close();
    _socket = null;
  }

  void announceNow() => _send('announce');

  void _onEvent(RawSocketEvent event) {
    if (event != RawSocketEvent.read) return;
    final dg = _socket?.receive();
    if (dg == null) return;
    try {
      final msg = jsonDecode(utf8.decode(dg.data)) as Map<String, dynamic>;
      if (msg['proto'] != protocol || msg['id'] == null) return;
      if (msg['id'] == self.id) return;
      onMessage(msg, dg.address.address);
      if (msg['type'] == 'discover' && !stealth) _sendTo('announce', dg.address);
    } catch (_) {}
  }

  Map<String, dynamic> _packet(String type) => {
        'proto': protocol,
        'type': type,
        'id': self.id,
        'name': self.name,
        'port': self.port,
        'fingerprint': self.fingerprint,
        'os': self.os,
        'version': self.version,
      };

  void _send(String type) {
    final s = _socket;
    if (s == null) return;
    if (stealth && type != 'bye') return;
    final data = utf8.encode(jsonEncode(_packet(type)));
    s.send(data, InternetAddress(multicastAddr), discoveryPort);
  }

  void _sendTo(String type, InternetAddress addr) {
    final s = _socket;
    if (s == null) return;
    final data = utf8.encode(jsonEncode(_packet(type)));
    s.send(data, addr, discoveryPort);
  }
}
