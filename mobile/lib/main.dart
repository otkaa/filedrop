import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
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
