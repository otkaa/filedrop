import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'models.dart';
import 'service.dart';

final service = FiledropService.instance;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    await Permission.notification.request();
  } catch (_) {}
  await service.init();
  runApp(const FiledropApp());
}

class FiledropApp extends StatelessWidget {
  const FiledropApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Filedrop',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF4F7CFF), brightness: Brightness.dark),
        scaffoldBackgroundColor: const Color(0xFF0F1115),
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;
  bool _inCall = false;

  @override
  void initState() {
    super.initState();
    service.addListener(_onChange);
  }

  @override
  void dispose() {
    service.removeListener(_onChange);
    super.dispose();
  }

  // open the call screen whenever a call becomes active (incoming or outgoing)
  void _onChange() {
    if (!mounted) return;
    if (service.activeCall != null && !_inCall) {
      _inCall = true;
      Navigator.of(context)
          .push(MaterialPageRoute(builder: (_) => const CallScreen()))
          .then((_) => _inCall = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: service,
      builder: (context, _) {
        if (!service.started) {
          return Scaffold(
            body: Center(
              child: service.startError != null
                  ? Padding(padding: const EdgeInsets.all(24), child: Text('Failed to start:\n${service.startError}', textAlign: TextAlign.center))
                  : const CircularProgressIndicator(),
            ),
          );
        }
        return Scaffold(
          appBar: AppBar(title: const Text('Filedrop'), backgroundColor: const Color(0xFF171A21)),
          body: Column(
            children: [
              if (service.pendingIncomingCall != null) const _CallRingBanner(),
              if (service.pendingRequest != null) _IncomingBanner(req: service.pendingRequest!),
              Expanded(child: _tab == 0 ? const _DevicesTab() : const _SettingsTab()),
            ],
          ),
          bottomNavigationBar: NavigationBar(
            selectedIndex: _tab,
            onDestinationSelected: (i) => setState(() => _tab = i),
            destinations: const [
              NavigationDestination(icon: Icon(Icons.devices), label: 'Devices'),
              NavigationDestination(icon: Icon(Icons.settings), label: 'Settings'),
            ],
          ),
        );
      },
    );
  }
}

class _IncomingBanner extends StatelessWidget {
  final IncomingRequest req;
  const _IncomingBanner({required this.req});
  @override
  Widget build(BuildContext context) {
    return Container(
      width: double.infinity,
      color: const Color(0xFF1F3A2A),
      padding: const EdgeInsets.all(12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('📥 ${req.fromName} wants to send ${req.files.length} file(s)', style: const TextStyle(fontWeight: FontWeight.bold)),
          Text('${_fmtBytes(req.totalSize)}', style: const TextStyle(color: Colors.white70, fontSize: 12)),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton(onPressed: () => service.respondToRequest(true), child: const Text('Accept')),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: () => service.respondToRequest(false), child: const Text('Decline')),
          ]),
        ],
      ),
    );
  }
}

class _DevicesTab extends StatelessWidget {
  const _DevicesTab();
  @override
  Widget build(BuildContext context) {
    final peers = service.sortedPeers;
    final transfers = service.sortedTransfers;
    return ListView(
      padding: const EdgeInsets.all(12),
      children: [
        Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          const Text('Nearby devices', style: TextStyle(color: Colors.white60, fontSize: 12, fontWeight: FontWeight.bold)),
          TextButton(onPressed: () => _addByAddress(context), child: const Text('+ by address')),
        ]),
        if (peers.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('Looking for devices on your Wi-Fi…\nMake sure your PC has Filedrop open on the same network.',
                style: TextStyle(color: Colors.white54), textAlign: TextAlign.center),
          ),
        for (final peer in peers) _DeviceTile(peer: peer),
        const SizedBox(height: 16),
        const Text('Transfers', style: TextStyle(color: Colors.white60, fontSize: 12, fontWeight: FontWeight.bold)),
        if (transfers.isEmpty) const Padding(padding: EdgeInsets.all(8), child: Text('No transfers yet.', style: TextStyle(color: Colors.white38))),
        for (final t in transfers.take(40)) _TransferTile(t: t),
      ],
    );
  }

  void _addByAddress(BuildContext context) {
    final host = TextEditingController();
    final port = TextEditingController(text: '53319');
    showDialog(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Add device by address'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          TextField(controller: host, decoration: const InputDecoration(hintText: 'PC IP, e.g. 192.168.1.42')),
          TextField(controller: port, decoration: const InputDecoration(hintText: 'Port'), keyboardType: TextInputType.number),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('Cancel')),
          FilledButton(
            onPressed: () async {
              final err = await service.addByAddress(host.text.trim(), int.tryParse(port.text.trim()) ?? 53319);
              if (ctx.mounted) Navigator.pop(ctx);
              if (err != null && context.mounted) {
                ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
              }
            },
            child: const Text('Add'),
          ),
        ],
      ),
    );
  }
}

class _DeviceTile extends StatelessWidget {
  final Peer peer;
  const _DeviceTile({required this.peer});
  @override
  Widget build(BuildContext context) {
    final unread = service.unread[peer.id] ?? 0;
    return Card(
      color: const Color(0xFF171A21),
      child: ListTile(
        leading: Text(_osEmoji(peer.os), style: const TextStyle(fontSize: 22)),
        title: Text(peer.name),
        subtitle: Text(peer.manual ? 'Added manually' : (peer.os ?? 'On your network'), style: const TextStyle(fontSize: 12)),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          if (unread > 0)
            Container(
              padding: const EdgeInsets.all(6),
              decoration: const BoxDecoration(color: Color(0xFF4F7CFF), shape: BoxShape.circle),
              child: Text('$unread', style: const TextStyle(fontSize: 11)),
            ),
          IconButton(
            icon: const Icon(Icons.call),
            tooltip: 'Call',
            onPressed: () {
              final err = service.startCall(peer.id);
              if (err != null) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
            },
          ),
          IconButton(
            icon: const Icon(Icons.send),
            tooltip: 'Send files',
            onPressed: () => _sendFiles(context, peer),
          ),
        ]),
        onTap: () {
          service.openConvo(peer.id);
          Navigator.push(context, MaterialPageRoute(builder: (_) => ChatScreen(peerId: peer.id)));
        },
      ),
    );
  }

  Future<void> _sendFiles(BuildContext context, Peer peer) async {
    final res = await FilePicker.platform.pickFiles(allowMultiple: true);
    if (res == null || res.files.isEmpty) return;
    final files = res.paths.whereType<String>().map((p) => File(p)).toList();
    final out = await service.sendFilesTo(peer.id, files);
    if (!out.ok && context.mounted) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(out.error ?? 'Send failed')));
    }
  }
}

class _TransferTile extends StatelessWidget {
  final Transfer t;
  const _TransferTile({required this.t});
  @override
  Widget build(BuildContext context) {
    final active = t.status == 'active' || t.status == 'pending';
    return Card(
      color: const Color(0xFF171A21),
      child: ListTile(
        dense: true,
        leading: Icon(t.dir == TransferDir.incoming ? Icons.download : Icons.upload, size: 20),
        title: Text(t.fileName, maxLines: 1, overflow: TextOverflow.ellipsis),
        subtitle: active && t.total > 0
            ? LinearProgressIndicator(value: t.progress)
            : Text(_statusLabel(t), style: const TextStyle(fontSize: 11)),
        trailing: Text('${t.peerName}', style: const TextStyle(fontSize: 11, color: Colors.white54)),
      ),
    );
  }
}

class ChatScreen extends StatefulWidget {
  final String peerId;
  const ChatScreen({super.key, required this.peerId});
  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _input = TextEditingController();

  @override
  void dispose() {
    service.closeConvo();
    _input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: service,
      builder: (context, _) {
        final peer = service.peers[widget.peerId];
        final msgs = service.messages[widget.peerId] ?? const <ChatMessage>[];
        return Scaffold(
          appBar: AppBar(
            title: Text(peer?.name ?? 'Chat'),
            backgroundColor: const Color(0xFF171A21),
            actions: [
              IconButton(
                icon: const Icon(Icons.attach_file),
                onPressed: peer == null ? null : () async {
                  final res = await FilePicker.platform.pickFiles(allowMultiple: true);
                  if (res == null) return;
                  final files = res.paths.whereType<String>().map((p) => File(p)).toList();
                  final out = await service.sendFilesTo(widget.peerId, files);
                  if (!out.ok && context.mounted) {
                    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(out.error ?? 'Send failed')));
                  }
                },
              ),
            ],
          ),
          body: Column(
            children: [
              Expanded(
                child: msgs.isEmpty
                    ? const Center(child: Text('No messages yet. Say hello 👋', style: TextStyle(color: Colors.white38)))
                    : ListView.builder(
                        reverse: true,
                        padding: const EdgeInsets.all(12),
                        itemCount: msgs.length,
                        itemBuilder: (c, i) => _Bubble(msg: msgs[msgs.length - 1 - i]),
                      ),
              ),
              SafeArea(
                child: Padding(
                  padding: const EdgeInsets.all(8),
                  child: Row(children: [
                    Expanded(
                      child: TextField(
                        controller: _input,
                        decoration: const InputDecoration(hintText: 'Message…', border: OutlineInputBorder()),
                        onSubmitted: (_) => _send(),
                      ),
                    ),
                    IconButton(icon: const Icon(Icons.send), onPressed: _send),
                  ]),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _send() {
    final t = _input.text.trim();
    if (t.isEmpty) return;
    _input.clear();
    service.sendMessageTo(widget.peerId, t);
  }
}

class _Bubble extends StatelessWidget {
  final ChatMessage msg;
  const _Bubble({required this.msg});
  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: msg.mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        constraints: const BoxConstraints(maxWidth: 280),
        decoration: BoxDecoration(
          color: msg.mine ? const Color(0xFF4F7CFF) : const Color(0xFF1F232C),
          borderRadius: BorderRadius.circular(12),
          border: msg.failed ? Border.all(color: Colors.redAccent) : null,
        ),
        child: Text(msg.text + (msg.failed ? '  (not delivered)' : '')),
      ),
    );
  }
}

class _SettingsTab extends StatefulWidget {
  const _SettingsTab();
  @override
  State<_SettingsTab> createState() => _SettingsTabState();
}

class _SettingsTabState extends State<_SettingsTab> {
  bool _showAddr = false;
  List<Map<String, String>> _addrs = const [];

  @override
  void initState() {
    super.initState();
    service.localAddresses().then((a) => mounted ? setState(() => _addrs = a) : null);
  }

  @override
  Widget build(BuildContext context) {
    final nameCtrl = TextEditingController(text: service.self.name);
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        const Text('Device name', style: TextStyle(color: Colors.white60, fontSize: 12)),
        TextField(
          controller: nameCtrl,
          onSubmitted: (v) => service.setName(v),
          decoration: const InputDecoration(border: OutlineInputBorder()),
        ),
        const SizedBox(height: 20),
        const Text('Your address (share so a PC can add you)', style: TextStyle(color: Colors.white60, fontSize: 12)),
        const SizedBox(height: 6),
        if (!_showAddr)
          OutlinedButton.icon(
            icon: const Icon(Icons.visibility),
            label: const Text('Show address'),
            onPressed: () => setState(() => _showAddr = true),
          )
        else ...[
          for (final a in _addrs)
            Card(
              color: const Color(0xFF171A21),
              child: ListTile(
                dense: true,
                title: Text('${a['address']}:${service.self.port}', style: const TextStyle(fontFamily: 'monospace')),
                subtitle: Text(a['label'] ?? ''),
              ),
            ),
          if (_addrs.isEmpty) const Text('No network address found.', style: TextStyle(color: Colors.white38)),
          TextButton(onPressed: () => setState(() => _showAddr = false), child: const Text('Hide address')),
        ],
        const SizedBox(height: 20),
        const Text('Received files', style: TextStyle(color: Colors.white60, fontSize: 12)),
        Text(service.downloadDir, style: const TextStyle(fontSize: 12, color: Colors.white70)),
        const SizedBox(height: 20),
        Text('Filedrop v$kAppVersion', style: const TextStyle(color: Colors.white38, fontSize: 12)),
      ],
    );
  }
}

class _CallRingBanner extends StatelessWidget {
  const _CallRingBanner();
  @override
  Widget build(BuildContext context) {
    final inc = service.pendingIncomingCall!;
    return Container(
      width: double.infinity,
      color: const Color(0xFF1F2A3A),
      padding: const EdgeInsets.all(12),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text('📞 ${inc['peerName']} is calling…', style: const TextStyle(fontWeight: FontWeight.bold)),
        const SizedBox(height: 8),
        Row(children: [
          FilledButton.icon(onPressed: () => service.acceptCall(), icon: const Icon(Icons.call), label: const Text('Accept')),
          const SizedBox(width: 8),
          OutlinedButton.icon(onPressed: () => service.declineCall(), icon: const Icon(Icons.call_end), label: const Text('Decline')),
        ]),
      ]),
    );
  }
}

class CallScreen extends StatefulWidget {
  const CallScreen({super.key});
  @override
  State<CallScreen> createState() => _CallScreenState();
}

class _CallScreenState extends State<CallScreen> {
  final _remoteCam = RTCVideoRenderer();
  final _remoteScreen = RTCVideoRenderer();
  final _localCam = RTCVideoRenderer();
  bool _ready = false;

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    await _remoteCam.initialize();
    await _remoteScreen.initialize();
    await _localCam.initialize();
    if (mounted) setState(() => _ready = true);
  }

  @override
  void dispose() {
    _remoteCam.dispose();
    _remoteScreen.dispose();
    _localCam.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: service,
      builder: (context, _) {
        final call = service.activeCall;
        if (call == null) {
          WidgetsBinding.instance.addPostFrameCallback((_) {
            if (Navigator.canPop(context)) Navigator.pop(context);
          });
          return const Scaffold(backgroundColor: Colors.black, body: Center(child: Text('Call ended', style: TextStyle(color: Colors.white))));
        }
        if (_ready) {
          _remoteCam.srcObject = call.remoteCamera;
          _remoteScreen.srcObject = call.remoteScreen;
          _localCam.srcObject = call.localCamera;
        }
        final showScreen = call.remoteScreenOn && call.remoteScreen != null;
        final showCam = call.remoteCamOn && call.remoteCamera != null;
        return Scaffold(
          backgroundColor: Colors.black,
          body: SafeArea(
            child: Stack(children: [
              Positioned.fill(
                child: _ready && (showScreen || showCam)
                    ? RTCVideoView(showScreen ? _remoteScreen : _remoteCam, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain)
                    : Center(
                        child: Column(mainAxisSize: MainAxisSize.min, children: [
                          const CircleAvatar(radius: 44, child: Icon(Icons.person, size: 44)),
                          const SizedBox(height: 12),
                          Text(call.peer.name, style: const TextStyle(color: Colors.white, fontSize: 20)),
                          const SizedBox(height: 4),
                          Text(call.status, style: const TextStyle(color: Colors.white70)),
                        ]),
                      ),
              ),
              if (_ready && call.camOn)
                Positioned(
                  right: 12,
                  top: 12,
                  width: 110,
                  height: 150,
                  child: ClipRRect(borderRadius: BorderRadius.circular(8), child: RTCVideoView(_localCam, mirror: true, objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitCover)),
                ),
              Positioned(
                top: 10,
                left: 14,
                child: Text('${call.peer.name} · ${call.status}', style: const TextStyle(color: Colors.white, fontWeight: FontWeight.bold)),
              ),
              Positioned(
                bottom: 28,
                left: 0,
                right: 0,
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _CallBtn(icon: call.muted ? Icons.mic_off : Icons.mic, label: 'Mute', active: !call.muted, onTap: () => call.toggleMute()),
                  _CallBtn(icon: call.camOn ? Icons.videocam : Icons.videocam_off, label: 'Camera', active: call.camOn, onTap: () => call.toggleCamera()),
                  _CallBtn(icon: Icons.call_end, label: 'End', danger: true, onTap: () => call.end()),
                ]),
              ),
            ]),
          ),
        );
      },
    );
  }
}

class _CallBtn extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;
  final bool danger;
  final VoidCallback onTap;
  const _CallBtn({required this.icon, required this.label, this.active = false, this.danger = false, required this.onTap});
  @override
  Widget build(BuildContext context) {
    return GestureDetector(
      onTap: onTap,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        CircleAvatar(radius: 28, backgroundColor: danger ? Colors.red : (active ? const Color(0xFF4F7CFF) : Colors.white24), child: Icon(icon, color: Colors.white)),
        const SizedBox(height: 4),
        Text(label, style: const TextStyle(color: Colors.white70, fontSize: 11)),
      ]),
    );
  }
}

String _statusLabel(Transfer t) {
  switch (t.status) {
    case 'done':
      return 'Done${t.savedPath != null ? ' · saved' : ''}';
    case 'error':
      return 'Failed';
    case 'declined':
      return 'Declined';
    case 'canceled':
      return 'Canceled';
    case 'pending':
      return 'Waiting…';
    default:
      return t.status;
  }
}

String _osEmoji(String? os) {
  final o = (os ?? '').toLowerCase();
  if (o.contains('win')) return '🪟';
  if (o.contains('linux')) return '🐧';
  if (o.contains('mac') || o.contains('darwin')) return '🍎';
  if (o.contains('android')) return '🤖';
  return '💻';
}

String _fmtBytes(int n) {
  if (n < 1024) return '$n B';
  const u = ['KB', 'MB', 'GB', 'TB'];
  double v = n.toDouble();
  int i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < u.length - 1);
  return '${v.toStringAsFixed(v < 10 ? 1 : 0)} ${u[i]}';
}
