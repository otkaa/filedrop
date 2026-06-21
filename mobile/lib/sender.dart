import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:path/path.dart' as p;
import 'package:uuid/uuid.dart';
import 'certs.dart';
import 'discovery.dart';
import 'models.dart';

const _uuid = Uuid();

HttpClient _clientFor(Peer peer) {
  final client = HttpClient();
  client.connectionTimeout = const Duration(seconds: 8);
  client.badCertificateCallback = (X509Certificate cert, String host, int port) {
    // self-signed: accept any cert but PIN the announced fingerprint
    if (peer.fingerprint == null) return true; // trust-on-first-use (manual add)
    return fingerprintOfDer(cert.der) == peer.fingerprint!.toLowerCase();
  };
  return client;
}

Future<Map<String, dynamic>> postJson(Peer peer, String path, Map<String, dynamic> body) async {
  final client = _clientFor(peer);
  try {
    final req = await client.postUrl(Uri.parse('https://${peer.ip}:${peer.port}$path'));
    req.headers.contentType = ContentType.json;
    final data = utf8.encode(jsonEncode(body));
    req.contentLength = data.length;
    req.add(data);
    final res = await req.close();
    final text = await utf8.decoder.bind(res).join();
    dynamic parsed;
    try {
      parsed = jsonDecode(text);
    } catch (_) {}
    return {'status': res.statusCode, 'body': parsed};
  } finally {
    client.close(force: true);
  }
}

/// Probe a host:port (manual add / VPN). Trust-on-first-use: capture the cert
/// fingerprint and pin it thereafter.
Future<Peer> probe(String host, int port) async {
  String? fingerprint;
  final client = HttpClient();
  client.connectionTimeout = const Duration(seconds: 5);
  client.badCertificateCallback = (cert, h, pt) {
    fingerprint = fingerprintOfDer(cert.der);
    return true;
  };
  try {
    final req = await client.getUrl(Uri.parse('https://$host:$port/api/info'));
    final res = await req.close();
    final body = jsonDecode(await utf8.decoder.bind(res).join());
    if (body['id'] == null) throw Exception('not a Filedrop device');
    return Peer(
      id: '${body['id']}',
      name: '${body['name'] ?? host}',
      ip: host,
      port: port,
      fingerprint: fingerprint,
      os: body['os'],
      version: body['version'],
      manual: true,
    );
  } finally {
    client.close(force: true);
  }
}

class SendOutcome {
  final bool ok;
  final String? error;
  final bool declined;
  SendOutcome(this.ok, {this.error, this.declined = false});
}

Future<SendOutcome> sendFiles(
  Peer peer,
  SelfInfo self,
  List<File> files, {
  required void Function(Transfer) onTransfer,
}) async {
  final metas = <Map<String, dynamic>>[];
  for (final f in files) {
    metas.add({'id': _uuid.v4(), 'name': p.basename(f.path), 'size': await f.length(), 'file': f});
  }
  for (final m in metas) {
    onTransfer(Transfer(
      id: 'out-${m['id']}',
      dir: TransferDir.outgoing,
      peerName: peer.name,
      fileName: m['name'],
      total: m['size'],
      status: 'pending',
    ));
  }

  void emit(Map<String, dynamic> m, String status, int sent) => onTransfer(Transfer(
        id: 'out-${m['id']}',
        dir: TransferDir.outgoing,
        peerName: peer.name,
        fileName: m['name'],
        total: m['size'],
        transferred: sent,
        status: status,
      ));

  Map<String, dynamic> prep;
  try {
    prep = await postJson(peer, '/api/prepare-upload', {
      'sender': {'id': self.id, 'name': self.name, 'os': self.os, 'port': self.port, 'fingerprint': self.fingerprint},
      'files': [for (final m in metas) {'id': m['id'], 'name': m['name'], 'size': m['size']}],
    });
  } catch (e) {
    for (final m in metas) emit(m, 'error', 0);
    return SendOutcome(false, error: 'Could not reach device');
  }

  if (prep['status'] == 403) {
    for (final m in metas) emit(m, 'declined', 0);
    return SendOutcome(false, declined: true, error: 'Recipient declined');
  }
  final pbody = prep['body'];
  if (prep['status'] != 200 || pbody == null || pbody['sessionId'] == null) {
    for (final m in metas) emit(m, 'error', 0);
    return SendOutcome(false, error: 'Recipient unavailable');
  }

  final sessionId = pbody['sessionId'];
  final outFiles = (pbody['files'] as List?) ?? const [];
  if (outFiles.length != metas.length) {
    for (final m in metas) emit(m, 'error', 0);
    return SendOutcome(false, error: 'Unexpected response');
  }

  for (var i = 0; i < metas.length; i++) {
    final m = metas[i];
    final ff = outFiles[i];
    final file = m['file'] as File;
    final size = m['size'] as int;
    try {
      // resume offset
      var offset = 0;
      try {
        final st = await postGet(peer, '/api/status?session=$sessionId&file=${ff['id']}');
        if (st['status'] == 200 && st['body'] != null) {
          offset = ((st['body']['received'] ?? 0) as num).toInt();
          if (offset > size) offset = size;
        }
      } catch (_) {}

      if (offset >= size && size > 0) {
        emit(m, 'done', size);
        continue;
      }

      final client = _clientFor(peer);
      try {
        final url = 'https://${peer.ip}:${peer.port}/api/upload?session=$sessionId&file=${ff['id']}&token=${ff['token']}&offset=$offset';
        final req = await client.postUrl(Uri.parse(url));
        req.headers.contentType = ContentType('application', 'octet-stream');
        req.contentLength = size - offset;
        var sent = offset;
        await req.addStream(file.openRead(offset).map((chunk) {
          sent += chunk.length;
          emit(m, 'active', sent);
          return chunk;
        }));
        final res = await req.close();
        final text = await utf8.decoder.bind(res).join();
        final body = (() {
          try {
            return jsonDecode(text);
          } catch (_) {
            return null;
          }
        })();
        if (res.statusCode == 200 && (body?['complete'] == true || (body?['received'] ?? 0) >= size)) {
          emit(m, 'done', size);
        } else {
          emit(m, 'error', sent);
        }
      } finally {
        client.close(force: true);
      }
    } catch (e) {
      emit(m, 'error', 0);
    }
  }
  return SendOutcome(true);
}

Future<Map<String, dynamic>> postGet(Peer peer, String path) async {
  final client = _clientFor(peer);
  try {
    final req = await client.getUrl(Uri.parse('https://${peer.ip}:${peer.port}$path'));
    final res = await req.close();
    final text = await utf8.decoder.bind(res).join();
    dynamic parsed;
    try {
      parsed = jsonDecode(text);
    } catch (_) {}
    return {'status': res.statusCode, 'body': parsed};
  } finally {
    client.close(force: true);
  }
}
