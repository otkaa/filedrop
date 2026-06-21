package dev.filedrop.filedrop

import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Bundle
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
                    else -> result.notImplemented()
                }
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
