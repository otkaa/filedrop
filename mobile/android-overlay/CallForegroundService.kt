package dev.filedrop.filedrop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps a voice/video call alive when the app is backgrounded (critical on
 * aggressive OEMs like HyperOS/MIUI that kill background processes) and shows an
 * ongoing "In call" notification. Started when a call connects, stopped when it
 * ends. Microphone foreground-service type (a call always holds the mic).
 */
class CallForegroundService : Service() {
    companion object {
        const val CHANNEL_ID = "filedrop_call"
        const val NOTIF_ID = 7341
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        createChannel()
        val title = intent?.getStringExtra("title") ?: "Filedrop"
        val text = intent?.getStringExtra("text") ?: "In call"

        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pi = if (launch != null) {
            PendingIntent.getActivity(
                this, 0, launch,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
            )
        } else {
            null
        }

        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(pi)
            .build()

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            } else {
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Exception) {
            // mic permission not granted yet / OEM quirk — still try to foreground
            try {
                startForeground(NOTIF_ID, notification)
            } catch (_: Exception) {
            }
        }
        return START_STICKY
    }

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(CHANNEL_ID, "Calls", NotificationManager.IMPORTANCE_LOW)
                ch.description = "Ongoing Filedrop call"
                ch.setShowBadge(false)
                nm.createNotificationChannel(ch)
            }
        }
    }

    override fun onDestroy() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                stopForeground(STOP_FOREGROUND_REMOVE)
            } else {
                @Suppress("DEPRECATION")
                stopForeground(true)
            }
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
