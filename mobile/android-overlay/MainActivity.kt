package dev.filedrop.filedrop

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Bundle
import io.flutter.embedding.android.FlutterActivity

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

    override fun onDestroy() {
        try {
            multicastLock?.release()
        } catch (_: Exception) {
        }
        super.onDestroy()
    }
}
