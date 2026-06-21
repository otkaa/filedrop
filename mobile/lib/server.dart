import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:uuid/uuid.dart';
import 'certs.dart';
import 'discovery.dart';
import 'models.dart';

class _FileEntry {
  final String id;
  final String name;
  final int size;
  final String token;
  final String partPath;
  String? finalPath;
  int received = 0;
  String status = 'pending';
  _FileEntry(this.id, this.name, this.size, this.token, this.partPath);
}

class _Session {
  final String id;
  final String senderName;
  final String dir;
  final files = <String, _FileEntry>{};
  _Session(this.id, this.senderName, this.dir);
}

/// HTTPS server that receives files + chat from peers. Same endpoints as the
/// desktop app, so a PC can send straight to the phone.
class ReceiveServer {
  final TlsCert tls;
  final SelfInfo self;
  final Future<bool> Function(IncomingRequest req) requestApproval;
  final void Function(String fromId, String fromName, String text, int ts) onMessage;
  final String Function() downloadDir;
  final void Function(Transfer t) onTransfer;

  HttpServer? _server;
  final _sessions = <String, _Session>{};
  final _uuid = const Uuid();

  ReceiveServer({
    required this.tls,
    required this.self,
    required this.requestApproval,
    required this.onMessage,
    required this.downloadDir,
    required this.onTransfer,
  });

  Future<int> start(int preferred) async {
    final ctx = SecurityContext()
      ..useCertificateChainBytes(utf8.encode(tls.certPem))
      ..usePrivateKeyBytes(utf8.encode(tls.keyPem));
    for (var p = preferred; p < preferred + 12; p++) {
      try {
        final server = await HttpServer.bindSecure(InternetAddress.anyIPv4, p, ctx);
        _server = server;
        server.listen(_handle, onError: (_) {});
        return p;
      } on SocketException {
        continue;
      }
    }
    throw Exception('no free port for the transfer server');
  }

  void stop() {
    _server?.close(force: true);
    _server = null;
  }

  Future<void> _handle(HttpRequest req) async {
    try {
      final path = req.uri.path;
      final m = req.method;
      if (m == 'GET' && path == '/api/info') {
        return _json(req, 200, {'id': self.id, 'name': self.name, 'os': self.os, 'version': self.version});
      }
      if (m == 'POST' && path == '/api/prepare-upload') return _prepare(req);
      if (m == 'GET' && path == '/api/status') return _statusReq(req);
      if (m == 'POST' && path == '/api/upload') return _upload(req);
      if (m == 'POST' && path == '/api/cancel') return _cancel(req);
      if (m == 'POST' && path == '/api/message') return _message(req);
      return _json(req, 404, {'error': 'not found'});
    } catch (e) {
      try {
        await _json(req, 500, {'error': '$e'});
      } catch (_) {}
    }
  }

  Future<void> _prepare(HttpRequest req) async {
    final j = jsonDecode(await utf8.decoder.bind(req).join());
    final sender = j['sender'];
    final files = (j['files'] as List?) ?? const [];
    if (sender == null || sender['id'] == null || files.isEmpty) {
      return _json(req, 400, {'error': 'missing sender or files'});
    }
    final senderName = '${sender['name'] ?? 'Unknown'}';
    final total = files.fold<int>(0, (a, f) => a + ((f['size'] ?? 0) as num).toInt());
    final accepted = await requestApproval(IncomingRequest(
      fromName: senderName,
      files: files.map((f) => {'name': '${f['name'] ?? 'file'}', 'size': (f['size'] ?? 0)}).toList().cast<Map<String, dynamic>>(),
      totalSize: total,
    ));
    if (!accepted) return _json(req, 403, {'error': 'declined'});

    final dir = downloadDir();
    await Directory(dir).create(recursive: true);
    final session = _Session(_uuid.v4(), senderName, dir);
    final out = [];
    for (final f in files) {
      final id = _uuid.v4();
      final safe = _safeName('${f['name'] ?? 'file'}');
      final token = _uuid.v4().replaceAll('-', '');
      final entry = _FileEntry(id, safe, ((f['size'] ?? 0) as num).toInt(), token, '$dir/$safe.part');
      final pf = File(entry.partPath);
      if (await pf.exists()) entry.received = await pf.length();
      session.files[id] = entry;
      out.add({'id': id, 'name': safe, 'token': token, 'received': entry.received});
      _emit(session, entry, 'pending');
    }
    _sessions[session.id] = session;
    return _json(req, 200, {'sessionId': session.id, 'files': out});
  }

  Future<void> _statusReq(HttpRequest req) async {
    final q = req.uri.queryParameters;
    final session = _sessions[q['session']];
    final entry = session?.files[q['file']];
    if (entry == null) return _json(req, 404, {'error': 'unknown file'});
    var received = entry.received;
    final pf = File(entry.partPath);
    if (await pf.exists()) received = await pf.length();
    entry.received = received;
    return _json(req, 200, {'received': received});
  }

  Future<void> _upload(HttpRequest req) async {
    final q = req.uri.queryParameters;
    final session = _sessions[q['session']];
    final entry = session?.files[q['file']];
    if (session == null || entry == null) return _json(req, 404, {'error': 'unknown file'});
    if (q['token'] != entry.token) return _json(req, 403, {'error': 'bad token'});

    final offset = int.tryParse(q['offset'] ?? '0') ?? 0;
    final part = File(entry.partPath);
    final onDisk = await part.exists() ? await part.length() : 0;
    if (offset > onDisk) return _json(req, 409, {'error': 'offset gap', 'received': onDisk});

    final raf = await part.open(mode: offset > 0 ? FileMode.writeOnlyAppend : FileMode.writeOnly);
    entry.received = offset;
    var lastEmit = 0;
    try {
      await for (final chunk in req) {
        await raf.writeFrom(chunk);
        entry.received += chunk.length;
        final now = DateTime.now().millisecondsSinceEpoch;
        if (now - lastEmit > 150) {
          lastEmit = now;
          _emit(session, entry, 'active');
        }
      }
      await raf.close();
      final finalSize = await part.length();
      if (entry.size > 0 && finalSize < entry.size) {
        entry.received = finalSize;
        _emit(session, entry, 'error');
        return _json(req, 200, {'received': finalSize, 'complete': false});
      }
      final finalPath = await _uniquePath('${session.dir}/${entry.name}');
      await part.rename(finalPath);
      entry.finalPath = finalPath;
      entry.received = finalSize;
      _emit(session, entry, 'done');
      return _json(req, 200, {'received': finalSize, 'complete': true});
    } catch (e) {
      try {
        await raf.close();
      } catch (_) {}
      _emit(session, entry, 'error');
      return _json(req, 500, {'error': '$e'});
    }
  }

  Future<void> _cancel(HttpRequest req) async {
    final q = req.uri.queryParameters;
    final session = _sessions[q['session']];
    if (session != null) {
      final fileId = q['file'];
      for (final e in session.files.values) {
        if (fileId != null && e.id != fileId) continue;
        try {
          final f = File(e.partPath);
          if (await f.exists()) await f.delete();
        } catch (_) {}
        _emit(session, e, 'canceled');
      }
      if (fileId == null) _sessions.remove(session.id);
    }
    return _json(req, 200, {'ok': true});
  }

  Future<void> _message(HttpRequest req) async {
    final j = jsonDecode(await utf8.decoder.bind(req).join());
    final from = j['from'];
    final text = j['text'];
    if (from == null || from['id'] == null || text is! String) {
      return _json(req, 400, {'error': 'missing fields'});
    }
    final ts = (j['ts'] is num) ? (j['ts'] as num).toInt() : DateTime.now().millisecondsSinceEpoch;
    onMessage('${from['id']}', '${from['name'] ?? 'Unknown'}', text, ts);
    return _json(req, 200, {'ok': true});
  }

  void _emit(_Session s, _FileEntry e, String status) {
    e.status = status;
    onTransfer(Transfer(
      id: 'in-${e.id}',
      dir: TransferDir.incoming,
      peerName: s.senderName,
      fileName: e.name,
      total: e.size,
      transferred: e.received,
      status: status,
      savedPath: e.finalPath,
    ));
  }

  Future<void> _json(HttpRequest req, int status, Map<String, dynamic> obj) async {
    final res = req.response;
    res.statusCode = status;
    res.headers.contentType = ContentType.json;
    res.write(jsonEncode(obj));
    await res.close();
  }

  String _safeName(String name) {
    var n = name.split(RegExp(r'[\\/]')).last;
    n = n.replaceAll(RegExp(r'[<>:"/\\|?*\x00-\x1f]'), '_').replaceAll(RegExp(r'^\.+'), '').trim();
    return n.isEmpty ? 'file' : n;
  }

  Future<String> _uniquePath(String p) async {
    if (!await File(p).exists()) return p;
    final dot = p.lastIndexOf('.');
    final base = dot > p.lastIndexOf('/') ? p.substring(0, dot) : p;
    final ext = dot > p.lastIndexOf('/') ? p.substring(dot) : '';
    for (var i = 1; i < 10000; i++) {
      final c = '$base ($i)$ext';
      if (!await File(c).exists()) return c;
    }
    return '$base-${DateTime.now().millisecondsSinceEpoch}$ext';
  }
}
