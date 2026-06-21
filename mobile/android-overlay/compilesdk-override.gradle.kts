
// Force every Flutter PLUGIN module to compile against SDK 36. A transitive
// plugin (flutter_plugin_android_lifecycle) requires it, and the app's
// compileSdk does not propagate to plugin modules on this Flutter/AGP.
// (:app is skipped — it's already set to 36 and is force-evaluated by the root,
// so afterEvaluate on it would throw.) Reflection keeps it AGP-version-proof.
fun forceCompileSdk36(androidExt: Any) {
    try {
        androidExt.javaClass.getMethod("setCompileSdk", Integer::class.java).invoke(androidExt, 36)
    } catch (e: Exception) {
        try {
            androidExt.javaClass.getMethod("compileSdkVersion", Integer.TYPE).invoke(androidExt, 36)
        } catch (ignored: Exception) {
        }
    }
}

subprojects {
    if (name != "app") {
        afterEvaluate {
            extensions.findByName("android")?.let { forceCompileSdk36(it) }
        }
    }
}
