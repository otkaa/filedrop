package dev.filedrop.filedrop

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var multicastLock: WifiManager.MulticastLock? = null
    private var callChannel: MethodChannel? = null
    // an Answer/Decline tapped before the Flutter engine is ready (cold start)
    private var pendingCallAction: Map<String, Any?>? = null

    companion object {
        const val INCOMING_ID = 7342
        const val INCOMING_CHANNEL = "filedrop_incoming"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Without a held MulticastLock, Android drops inbound multicast packets,
        // so device discovery wouldn't receive announcements.
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("filedrop").apply {
            setReferenceCounted(true)
            acquire()
        }
        ensureChannels()
        handleCallActionIntent(intent)
    }

    // Create our notification channels up front so they exist even when an FCM
    // message notification is rendered by the system while the app is killed (the
    // native notify path would otherwise create the Messages channel lazily, and
    // FCM's default_notification_channel_id meta-data points here for heads-up).
    private fun ensureChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel("filedrop_messages") == null) {
            nm.createNotificationChannel(
                NotificationChannel("filedrop_messages", "Messages", NotificationManager.IMPORTANCE_HIGH)
            )
        }
        if (nm.getNotificationChannel(INCOMING_CHANNEL) == null) {
            nm.createNotificationChannel(
                NotificationChannel(INCOMING_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleCallActionIntent(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val ch = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "filedrop/call_service")
        callChannel = ch
        ch.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> {
                    val i = Intent(this, CallForegroundService::class.java)
                    i.putExtra("title", call.argument<String>("title") ?: "Filedrop")
                    i.putExtra("text", call.argument<String>("text") ?: "In call")
                    i.putExtra("screen", call.argument<Boolean>("screen") ?: false)
                    ContextCompat.startForegroundService(this, i)
                    result.success(null)
                }
                "stop" -> {
                    stopService(Intent(this, CallForegroundService::class.java))
                    result.success(null)
                }
                "notify" -> {
                    postMessageNotification(
                        call.argument<String>("title") ?: "Message",
                        call.argument<String>("text") ?: "",
                        call.argument<Int>("id") ?: 1
                    )
                    result.success(null)
                }
                "incomingCall" -> {
                    showIncomingCall(
                        call.argument<String>("callId") ?: "",
                        call.argument<String>("name") ?: "Someone"
                    )
                    result.success(null)
                }
                "cancelIncomingCall" -> {
                    NotificationManagerCompat.from(this).cancel(INCOMING_ID)
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        }
        // replay an action that arrived before the engine was up (cold start)
        pendingCallAction?.let { ch.invokeMethod("onCallAction", it); pendingCallAction = null }
    }

    // An Answer/Decline button (or the full-screen tap) launched us with an extra.
    private fun handleCallActionIntent(intent: Intent?) {
        val action = intent?.getStringExtra("callAction") ?: return
        intent.removeExtra("callAction")
        val args = mapOf("action" to action, "callId" to intent.getStringExtra("callId"))
        NotificationManagerCompat.from(this).cancel(INCOMING_ID)
        val ch = callChannel
        if (ch != null) ch.invokeMethod("onCallAction", args) else pendingCallAction = args
    }

    private fun showIncomingCall(callId: String, name: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(INCOMING_CHANNEL) == null) {
                val ch = NotificationChannel(INCOMING_CHANNEL, "Incoming calls", NotificationManager.IMPORTANCE_HIGH)
                ch.description = "Ringing for incoming Filedrop calls"
                ch.setShowBadge(true)
                nm.createNotificationChannel(ch)
            }
        }
        fun actionPi(action: String, code: Int): PendingIntent {
            val i = Intent(this, MainActivity::class.java).apply {
                putExtra("callAction", action)
                putExtra("callId", callId)
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            }
            return PendingIntent.getActivity(this, code, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val answer = actionPi("accept", 1)
        val decline = actionPi("decline", 2)
        val n = NotificationCompat.Builder(this, INCOMING_CHANNEL)
            .setContentTitle(name)
            .setContentText("Incoming Filedrop call")
            .setSmallIcon(android.R.drawable.sym_call_incoming)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setAutoCancel(true)
            .setContentIntent(answer)
            .setFullScreenIntent(answer, true) // ring screen when allowed; else heads-up
            .addAction(android.R.drawable.sym_action_call, "Answer", answer)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Decline", decline)
            .build()
        try {
            NotificationManagerCompat.from(this).notify(INCOMING_ID, n)
        } catch (_: SecurityException) {
        }
    }

    private fun postMessageNotification(title: String, text: String, id: Int) {
        val channelId = "filedrop_messages"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(channelId) == null) {
                nm.createNotificationChannel(
                    NotificationChannel(channelId, "Messages", NotificationManager.IMPORTANCE_HIGH)
                )
            }
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pi = if (launch != null) {
            PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        } else {
            null
        }
        val n = NotificationCompat.Builder(this, channelId)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_dialog_email)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pi)
            .build()
        try {
            NotificationManagerCompat.from(this).notify(id, n)
        } catch (_: SecurityException) {
        }
    }

    override fun onDestroy() {
        try {
            multicastLock?.release()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
