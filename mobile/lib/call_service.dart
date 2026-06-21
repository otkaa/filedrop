import 'package:flutter/services.dart';

/// Bridge to the native Android foreground service that keeps a call alive when
/// the app is backgrounded/closed and shows an ongoing "In call" notification.
/// No-op on platforms without the channel.
const _ch = MethodChannel('filedrop/call_service');

Future<void> startCallService({String title = 'Filedrop', String text = 'In call', bool screen = false}) async {
  try {
    await _ch.invokeMethod('start', {'title': title, 'text': text, 'screen': screen});
  } catch (_) {}
}

Future<void> stopCallService() async {
  try {
    await _ch.invokeMethod('stop');
  } catch (_) {}
}

/// Post a system notification for an incoming chat message (one per peer `id`).
Future<void> showMessageNotification(String title, String text, int id) async {
  try {
    await _ch.invokeMethod('notify', {'title': title, 'text': text, 'id': id});
  } catch (_) {}
}

/// Post the ringing/Answer-Decline notification for an incoming call.
Future<void> showIncomingCallNotification(String callId, String name) async {
  try {
    await _ch.invokeMethod('incomingCall', {'callId': callId, 'name': name});
  } catch (_) {}
}

Future<void> cancelIncomingCallNotification() async {
  try {
    await _ch.invokeMethod('cancelIncomingCall');
  } catch (_) {}
}

/// Register a handler for Answer/Decline tapped in the incoming-call notification.
/// The native side invokes 'onCallAction' with {action: accept|decline, callId}.
void setCallActionHandler(void Function(String action, String? callId) handler) {
  _ch.setMethodCallHandler((call) async {
    if (call.method == 'onCallAction') {
      final a = call.arguments;
      final m = a is Map ? a : const {};
      handler('${m['action']}', m['callId'] as String?);
    }
    return null;
  });
}
