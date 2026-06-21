import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:open_filex/open_filex.dart';
import 'package:path_provider/path_provider.dart';

/// Bump this on every released APK, and update mobile/version.json to match.
const kAppVersion = '1.2.0';

const _manifestUrl = 'https://raw.githubusercontent.com/otkaa/filedrop/main/mobile/version.json';

/// In-app updater: checks a version manifest on GitHub, and on request
/// downloads the new APK and hands it to Android's package installer.
class Updater extends ChangeNotifier {
  String state = 'idle'; // idle | checking | available | none | downloading | error
  int percent = 0;
  String? latestVersion;
  String? error;
  String? _apkUrl;

  Future<void> check() async {
    state = 'checking';
    error = null;
    notifyListeners();
    try {
      final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
      final url = Uri.parse('$_manifestUrl?t=${DateTime.now().millisecondsSinceEpoch}');
      final res = await (await client.getUrl(url)).close();
      final body = await utf8.decoder.bind(res).join();
      client.close();
      final j = jsonDecode(body);
      latestVersion = '${j['version']}';
      _apkUrl = '${j['url']}';
      if (_isNewer(latestVersion!, kAppVersion)) {
        state = 'available';
      } else {
        state = 'none';
      }
    } catch (e) {
      state = 'error';
      error = 'Could not reach update server';
    }
    notifyListeners();
  }

  Future<void> downloadAndInstall() async {
    if (_apkUrl == null) return;
    state = 'downloading';
    percent = 0;
    notifyListeners();
    try {
      final dir = await getExternalStorageDirectory() ?? await getApplicationDocumentsDirectory();
      final path = '${dir.path}/Filedrop-update.apk';
      final client = HttpClient();
      final res = await (await client.getUrl(Uri.parse(_apkUrl!))).close();
      final total = res.contentLength;
      final sink = File(path).openWrite();
      var received = 0;
      var lastPct = -1;
      await for (final chunk in res) {
        sink.add(chunk);
        received += chunk.length;
        if (total > 0) {
          final p = (received * 100 / total).round();
          if (p != lastPct) {
            lastPct = p;
            percent = p;
            notifyListeners();
          }
        }
      }
      await sink.close();
      client.close();
      // hand off to the system package installer
      await OpenFilex.open(path, type: 'application/vnd.android.package-archive');
      state = 'available';
      notifyListeners();
    } catch (e) {
      state = 'error';
      error = 'Download failed';
      notifyListeners();
    }
  }

  bool _isNewer(String a, String b) {
    final pa = a.split('.').map((x) => int.tryParse(x) ?? 0).toList();
    final pb = b.split('.').map((x) => int.tryParse(x) ?? 0).toList();
    for (var i = 0; i < 3; i++) {
      final x = i < pa.length ? pa[i] : 0;
      final y = i < pb.length ? pb[i] : 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }
}

final updater = Updater();
