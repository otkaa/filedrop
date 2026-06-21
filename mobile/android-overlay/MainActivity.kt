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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Without a held MulticastLock, Android drops inbound multicast packets,
        // so device discovery wouldn't receive announcements.
        val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        multicastLock = wifi.createMulticastLock("filedrop").apply {
            setReferenceCounted(true)
            acquire()
        }
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Start/stop the ongoing-call foreground service so calls survive the app
        // being backgrounded/closed (HyperOS/MIUI kill background apps otherwise).
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "filedrop/call_service")
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        val i = Intent(this, CallForegroundService::class.java)
                        i.putExtra("title", call.argument<String>("title") ?: "Filedrop")
                        i.putExtra("text", call.argument<String>("text") ?: "In call")
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
                    else -> result.notImplemented()
                }
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
            // POST_NOTIFICATIONS not granted yet
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
