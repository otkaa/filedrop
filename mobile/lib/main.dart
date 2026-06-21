import 'dart:io';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:permission_handler/permission_handler.dart';
import 'call.dart';
import 'fcm.dart';
import 'models.dart';
import 'service.dart';
import 'updater.dart';

final service = FiledropService.instance;

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Firebase + background push handler so calls/messages wake a fully-closed app.
  await setupFcmBackground();
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

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  int _tab = 0;
  bool _inCall = false;

  @override
  void initState() {
    super.initState();
    service.addListener(_onChange);
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    service.removeListener(_onChange);
    super.dispose();
  }

  // Track foreground state so we only notify for messages you're not watching.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    service.inForeground = state == AppLifecycleState.resumed;
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
              NavigationDestination(icon: Icon(Icons.devices_rounded), label: 'Devices'),
              NavigationDestination(icon: Icon(Icons.settings_rounded), label: 'Settings'),
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
        const _ConnectByCode(),
        const SizedBox(height: 16),
        const Text('Contacts', style: TextStyle(color: Colors.white60, fontSize: 12, fontWeight: FontWeight.bold)),
        if (peers.isEmpty)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text('No contacts yet.\nAdd a friend by their code above.',
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

}

class _ConnectByCode extends StatefulWidget {
  const _ConnectByCode();
  @override
  State<_ConnectByCode> createState() => _ConnectByCodeState();
}

class _ConnectByCodeState extends State<_ConnectByCode> {
  final _code = TextEditingController();
  bool _busy = false;

  @override
  void dispose() {
    _code.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    if (_busy) return;
    setState(() => _busy = true);
    final err = await service.addByRelayCode(_code.text);
    if (!mounted) return;
    setState(() => _busy = false);
    if (err != null) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
    } else {
      _code.clear();
      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Connected — say hi!')));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Connect via code (over the internet)',
            style: TextStyle(color: Colors.white60, fontSize: 12, fontWeight: FontWeight.bold)),
        const SizedBox(height: 6),
        Row(children: [
          Expanded(
            child: TextField(
              controller: _code,
              textCapitalization: TextCapitalization.characters,
              autocorrect: false,
              enabled: !_busy,
              onSubmitted: (_) => _connect(),
              decoration: const InputDecoration(
                hintText: 'XXXX-XXXX',
                border: OutlineInputBorder(),
                isDense: true,
                prefixIcon: Icon(Icons.public_rounded),
              ),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(
            onPressed: _busy ? null : _connect,
            child: _busy
                ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                : const Text('Connect'),
          ),
        ]),
      ],
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
        leading: Text(peer.isRelayOnly ? '🌐' : _osEmoji(peer.os), style: const TextStyle(fontSize: 22)),
        title: Text(peer.name),
        subtitle: Text(
          peer.isRelayOnly
              ? 'via code · ${formatRelayCode(peer.relayCode ?? peer.id)}'
              : (peer.manual ? 'Added manually' : (peer.os ?? 'On your network')),
          style: const TextStyle(fontSize: 12),
        ),
        trailing: Row(mainAxisSize: MainAxisSize.min, children: [
          if (unread > 0)
            Container(
              padding: const EdgeInsets.all(6),
              decoration: const BoxDecoration(color: Color(0xFF4F7CFF), shape: BoxShape.circle),
              child: Text('$unread', style: const TextStyle(fontSize: 11)),
            ),
          IconButton(
            icon: const Icon(Icons.call_rounded),
            tooltip: 'Call',
            onPressed: () {
              final err = service.startCall(peer.id);
              if (err != null) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(err)));
            },
          ),
          IconButton(
            icon: const Icon(Icons.send_rounded),
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
        leading: Icon(t.dir == TransferDir.incoming ? Icons.download_rounded : Icons.upload_rounded, size: 20),
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
                icon: const Icon(Icons.attach_file_rounded),
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
                    IconButton(icon: const Icon(Icons.send_rounded), onPressed: _send),
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

  // ⏳ pending → ✓ sent → ✓✓ delivered → ✓✓ (cyan) read
  IconData get _tickIcon => switch (msg.status) {
        'pending' => Icons.access_time_rounded,
        'delivered' || 'read' => Icons.done_all_rounded,
        _ => Icons.check_rounded,
      };
  Color get _tickColor => switch (msg.status) {
        'read' => const Color(0xFF34E0FF),
        'pending' => Colors.white54,
        _ => Colors.white70,
      };

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
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.end,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(msg.text, style: const TextStyle(color: Colors.white, fontSize: 15)),
            if (msg.mine)
              Padding(
                padding: const EdgeInsets.only(top: 2),
                child: Icon(_tickIcon, size: 14, color: _tickColor),
              ),
          ],
        ),
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
        const Text('Your code (share to connect over the internet)', style: TextStyle(color: Colors.white60, fontSize: 12)),
        const SizedBox(height: 6),
        Card(
          color: const Color(0xFF171A21),
          child: ListTile(
            leading: const Icon(Icons.public_rounded, color: Color(0xFF4F7CFF)),
            title: Text(
              service.relayCode != null ? formatRelayCode(service.relayCode!) : '— — — —',
              style: const TextStyle(fontFamily: 'monospace', fontSize: 20, letterSpacing: 2),
            ),
            subtitle: const Text('Friends add this to reach you anywhere', style: TextStyle(fontSize: 11)),
            trailing: IconButton(
              icon: const Icon(Icons.copy_rounded),
              tooltip: 'Copy code',
              onPressed: service.relayCode == null
                  ? null
                  : () {
                      Clipboard.setData(ClipboardData(text: formatRelayCode(service.relayCode!)));
                      ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Code copied')));
                    },
            ),
          ),
        ),
        const SizedBox(height: 20),
        const Text('Received files', style: TextStyle(color: Colors.white60, fontSize: 12)),
        Text(service.downloadDir, style: const TextStyle(fontSize: 12, color: Colors.white70)),
        const SizedBox(height: 20),
        const Text('Updates', style: TextStyle(color: Colors.white60, fontSize: 12)),
        const SizedBox(height: 6),
        ListenableBuilder(
          listenable: updater,
          builder: (context, _) {
            final u = updater;
            String status;
            switch (u.state) {
              case 'checking':
                status = 'Checking…';
                break;
              case 'available':
                status = 'Update available: v${u.latestVersion}';
                break;
              case 'downloading':
                status = 'Downloading… ${u.percent}%';
                break;
              case 'none':
                status = 'Up to date · v$kAppVersion';
                break;
              case 'error':
                status = '${u.error ?? 'Update check failed'} · v$kAppVersion';
                break;
              default:
                status = 'Filedrop v$kAppVersion';
            }
            final busy = u.state == 'checking' || u.state == 'downloading';
            return Card(
              color: const Color(0xFF171A21),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Row(children: [
                    Expanded(child: Text(status)),
                    if (!busy)
                      u.state == 'available'
                          ? FilledButton(onPressed: () => u.downloadAndInstall(), child: const Text('Update now'))
                          : OutlinedButton(onPressed: () => u.check(), child: const Text('Check')),
                  ]),
                  if (u.state == 'downloading')
                    Padding(padding: const EdgeInsets.only(top: 8), child: LinearProgressIndicator(value: u.percent / 100)),
                ]),
              ),
            );
          },
        ),
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
          FilledButton.icon(onPressed: () => service.acceptCall(), icon: const Icon(Icons.call_rounded), label: const Text('Accept')),
          const SizedBox(width: 8),
          OutlinedButton.icon(onPressed: () => service.declineCall(), icon: const Icon(Icons.call_end_rounded), label: const Text('Decline')),
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
  final _localScreen = RTCVideoRenderer();
  bool _ready = false;
  String? _focus; // which view is enlarged; null = auto

  @override
  void initState() {
    super.initState();
    _init();
  }

  Future<void> _init() async {
    await _remoteCam.initialize();
    await _remoteScreen.initialize();
    await _localCam.initialize();
    await _localScreen.initialize();
    // Repaint whenever a renderer starts/stops actually showing video, so a
    // tile appears the moment real frames arrive (and hides when they stop).
    for (final r in [_remoteCam, _remoteScreen, _localCam, _localScreen]) {
      r.addListener(_onRender);
    }
    if (mounted) setState(() => _ready = true);
  }

  void _onRender() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    for (final r in [_remoteCam, _remoteScreen, _localCam, _localScreen]) {
      r.removeListener(_onRender);
    }
    _remoteCam.dispose();
    _remoteScreen.dispose();
    _localCam.dispose();
    _localScreen.dispose();
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
          _localScreen.srcObject = call.localScreen;
        }

        // Show a tile only when its renderer is ACTUALLY producing video frames
        // (robust: works even if the peer's ctrl status flag never arrived —
        // this is what was hiding the PC's screen share on the phone).
        final views = <String, RTCVideoRenderer>{};
        if (_remoteScreen.renderVideo) views['remoteScreen'] = _remoteScreen;
        if (_remoteCam.renderVideo) views['remoteCamera'] = _remoteCam;
        if (_localScreen.renderVideo) views['localScreen'] = _localScreen;
        if (_localCam.renderVideo) views['localCamera'] = _localCam;

        final mainKey = (_focus != null && views.containsKey(_focus)) ? _focus : (views.isNotEmpty ? views.keys.first : null);
        final pipKeys = views.keys.where((k) => k != mainKey).toList();

        return Scaffold(
          backgroundColor: Colors.black,
          body: Stack(children: [
            Positioned.fill(
              child: (mainKey != null && _ready)
                  ? GestureDetector(onTap: () => setState(() => _focus = null), child: _video(views[mainKey]!, mainKey, cover: false, mirror: _mirrorFor(mainKey, call)))
                  : _avatar(call),
            ),
            // top status bar
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Container(
                padding: const EdgeInsets.only(top: 44, left: 18, right: 18, bottom: 14),
                decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color(0x99000000), Color(0x00000000)])),
                child: Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text(call.peer.name, style: const TextStyle(color: Colors.white, fontSize: 19, fontWeight: FontWeight.w600)),
                      Text(call.status, style: const TextStyle(color: Colors.white70, fontSize: 12.5)),
                    ]),
                  ),
                  if (!call.remoteMic) const Icon(Icons.mic_off_rounded, color: Colors.white54, size: 20),
                  if (call.remoteScreenOn) const Padding(padding: EdgeInsets.only(left: 8), child: Icon(Icons.screen_share_rounded, color: Colors.white54, size: 20)),
                ]),
              ),
            ),
            // picture-in-picture tiles (tap to enlarge)
            if (pipKeys.isNotEmpty && _ready)
              Positioned(
                right: 12,
                top: 92,
                child: Column(
                  children: [
                    for (final k in pipKeys)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 10),
                        child: GestureDetector(
                          onTap: () => setState(() => _focus = k),
                          child: Container(
                            decoration: BoxDecoration(borderRadius: BorderRadius.circular(14), border: Border.all(color: const Color(0x33FFFFFF)), boxShadow: const [BoxShadow(color: Color(0x66000000), blurRadius: 12)]),
                            child: ClipRRect(borderRadius: BorderRadius.circular(14), child: SizedBox(width: 104, height: 150, child: _video(views[k]!, k, cover: true, mirror: _mirrorFor(k, call)))),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            // controls
            Positioned(
              bottom: 0,
              left: 0,
              right: 0,
              child: Container(
                padding: const EdgeInsets.only(top: 36, bottom: 38, left: 6, right: 6),
                decoration: const BoxDecoration(gradient: LinearGradient(begin: Alignment.bottomCenter, end: Alignment.topCenter, colors: [Color(0xDD000000), Color(0x00000000)])),
                child: Row(mainAxisAlignment: MainAxisAlignment.spaceEvenly, children: [
                  _CallBtn(icon: call.muted ? Icons.mic_off_rounded : Icons.mic_rounded, label: 'Mute', danger: call.muted, onTap: () => call.toggleMute()),
                  _CallBtn(icon: call.deafened ? Icons.headset_off_rounded : Icons.headset_mic_rounded, label: 'Deafen', danger: call.deafened, onTap: () => call.toggleDeafen()),
                  _CallBtn(icon: call.camOn ? Icons.videocam_rounded : Icons.videocam_off_rounded, label: 'Camera', active: call.camOn, onTap: () => call.toggleCamera()),
                  if (call.camOn) _CallBtn(icon: Icons.cameraswitch_rounded, label: 'Flip', onTap: () => call.switchCamera()),
                  _CallBtn(icon: call.screenOn ? Icons.stop_screen_share_rounded : Icons.screen_share_rounded, label: 'Share', active: call.screenOn, onTap: () => call.toggleScreen()),
                  _CallBtn(icon: Icons.call_end_rounded, label: 'End', end: true, onTap: () => call.end()),
                ]),
              ),
            ),
          ]),
        );
      },
    );
  }

  Widget _video(RTCVideoRenderer r, String key, {required bool cover, bool mirror = false}) {
    final isScreen = key.toLowerCase().contains('screen');
    final fit = cover
        ? RTCVideoViewObjectFit.RTCVideoViewObjectFitCover
        : (isScreen ? RTCVideoViewObjectFit.RTCVideoViewObjectFitContain : RTCVideoViewObjectFit.RTCVideoViewObjectFitCover);
    return Container(color: Colors.black, child: RTCVideoView(r, mirror: mirror, objectFit: fit));
  }

  // Mirror your own front camera (natural selfie view) and flip the peer's camera
  // when they report it's mirrored (their front camera). Never mirror screens.
  bool _mirrorFor(String key, CallSession call) {
    if (key == 'localCamera') return call.camFacing == 'user';
    if (key == 'remoteCamera') return call.remoteCamMirror;
    return false;
  }

  Widget _avatar(CallSession call) {
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 104,
          height: 104,
          decoration: const BoxDecoration(shape: BoxShape.circle, gradient: LinearGradient(colors: [Color(0xFF4F7CFF), Color(0xFF7C5CFF)])),
          child: const Icon(Icons.person_rounded, size: 54, color: Colors.white),
        ),
        const SizedBox(height: 18),
        Text(call.peer.name, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w600)),
        const SizedBox(height: 6),
        Text(call.status, style: const TextStyle(color: Colors.white60, fontSize: 13)),
      ]),
    );
  }
}

class _CallBtn extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool active;
  final bool danger;
  final bool end;
  final VoidCallback onTap;
  const _CallBtn({required this.icon, required this.label, this.active = false, this.danger = false, this.end = false, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final Gradient? grad = end
        ? const LinearGradient(colors: [Color(0xFFFF5D6C), Color(0xFFE0344A)])
        : active
            ? const LinearGradient(colors: [Color(0xFF4F7CFF), Color(0xFF7C5CFF)])
            : null;
    final Color? bg = grad == null ? (danger ? const Color(0x33FF5D6C) : const Color(0x1FFFFFFF)) : null;
    final List<BoxShadow>? glow = (active || end)
        ? [BoxShadow(color: end ? const Color(0x80FF5D6C) : const Color(0x804F7CFF), blurRadius: 18, spreadRadius: 1)]
        : null;
    final iconColor = (danger && !end) ? const Color(0xFFFF8088) : Colors.white;
    return GestureDetector(
      onTap: onTap,
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 52,
          height: 52,
          decoration: BoxDecoration(shape: BoxShape.circle, gradient: grad, color: bg, boxShadow: glow),
          child: Icon(icon, color: iconColor, size: 23),
        ),
        const SizedBox(height: 7),
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
