import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_callkit_incoming/entities/entities.dart';
import 'package:flutter_callkit_incoming/flutter_callkit_incoming.dart';

/// FCM (push) so incoming calls/messages wake the phone even when the app is
/// fully closed — the only mechanism Android allows for that (same as
/// WhatsApp/Discord). The relay sends a high-priority push when your socket is
/// offline; for a CALL the push carries the offer SDP so we can answer.

/// Runs in a background isolate when a push arrives and the app is dead.
@pragma('vm:entry-point')
Future<void> fcmBackgroundHandler(RemoteMessage message) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {}
  final data = message.data;
  if (data['type'] == 'call') {
    // Show the native ringing screen (lock-screen wake + ring + vibrate). On
    // Answer, the main app reads this `extra` to set up the WebRTC answer.
    await FlutterCallkitIncoming.showCallkitIncoming(CallKitParams(
      id: '${data['callId'] ?? ''}',
      nameCaller: '${data['fromName'] ?? 'Someone'}',
      handle: '${data['fromName'] ?? ''}',
      type: 0,
      textAccept: 'Answer',
      textDecline: 'Decline',
      extra: <String, dynamic>{
        'fromCode': '${data['fromCode'] ?? ''}',
        'sdp': '${data['sdp'] ?? ''}',
        'callId': '${data['callId'] ?? ''}',
      },
      android: const AndroidParams(
        isCustomNotification: true,
        isShowFullLockedScreen: true,
        ringtonePath: 'system_ringtone_default',
        backgroundColor: '#171A21',
        actionColor: '#4F7CFF',
      ),
      ios: const IOSParams(),
    ));
  }
  // 'msg' pushes carry an FCM notification block, shown by the system itself.
}

/// Initialise Firebase + register the background handler. Call before runApp.
Future<void> setupFcmBackground() async {
  try {
    await Firebase.initializeApp();
    FirebaseMessaging.onBackgroundMessage(fcmBackgroundHandler);
  } catch (_) {}
}

Future<String?> getFcmToken() async {
  try {
    return await FirebaseMessaging.instance.getToken();
  } catch (_) {
    return null;
  }
}

/// Fires with a fresh token whenever FCM rotates it (so we can re-register).
Stream<String> get fcmTokenRefresh => FirebaseMessaging.instance.onTokenRefresh;
