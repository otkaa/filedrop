import 'package:flutter/services.dart';

/// Bridge to the native Android foreground service that keeps a call alive when
/// the app is backgrounded/closed and shows an ongoing "In call" notification.
/// No-op on platforms without the channel.
const _ch = MethodChannel('filedrop/call_service');

Future<void> startCallService({String title = 'Filedrop', String text = 'In call'}) async {
  try {
    await _ch.invokeMethod('start', {'title': title, 'text': text});
  } catch (_) {}
}

Future<void> stopCallService() async {
  try {
    await _ch.invokeMethod('stop');
  } catch (_) {}
}
