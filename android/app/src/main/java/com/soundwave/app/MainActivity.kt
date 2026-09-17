package com.soundwave.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import java.io.File
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import org.apache.commons.compress.compressors.xz.XZCompressorInputStream

/**
 * Runs the real backend on the phone.
 *
 * The app bundles Termux's Node.js — a `node` executable actually built for
 * Android (PT_INTERP = /system/bin/linker64) plus every library it links
 * against — unpacks it into the app's private storage, and spawns it with
 * ProcessBuilder. That process serves the whole app on 127.0.0.1:5000 and the
 * WebView loads it.
 *
 * This is why the APK needs no server and no Termux install: the runtime travels
 * inside the APK.
 */
class MainActivity : Activity() {

    companion object {
        private const val TAG = "Soundwave"
        private const val PORT = 5000

        /** Bumped when the bundled runtime or app code changes incompatibly. */
        private const val RUNTIME_VERSION = 1
        private const val REQ_NOTIFICATIONS = 1001
    }

    private lateinit var status: TextView
    @Volatile private var serverProcess: Process? = null
    @Volatile private var webView: WebView? = null
    private var media: MediaControls? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)

        media = MediaControls(this)
        requestNotificationPermission()
        // Transport buttons on the notification launch the activity, so the
        // action may already be waiting on this intent.
        consumeTransportAction(intent)

        Thread {
            try {
                start()
            } catch (e: Exception) {
                Log.e(TAG, "startup failed", e)
                showStatus(getString(R.string.startup_failed, e.message ?: e.javaClass.simpleName))
            }
        }.start()
    }

    /** Android 13+ requires an explicit grant before any notification shows. */
    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        ) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
    }

    /** singleTask: notification transport buttons re-enter here. */
    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        consumeTransportAction(intent)
    }

    /**
     * Dispatches a transport action, and clears it from the intent.
     *
     * setIntent() keeps the intent for the lifetime of the activity, so without
     * clearing it every recreate — a rotation, a dark-mode switch, a restore
     * after process death — would replay whatever button the user last pressed
     * and start or stop playback on its own.
     */
    private fun consumeTransportAction(intent: Intent?) {
        val action = intent?.action ?: return
        if (!MediaControls.isTransportAction(action)) return
        intent.action = null
        media?.handle(action)
    }

    /** Runs a WebView call on the UI thread, which is where it is required. */
    fun runOnWebView(block: (WebView) -> Unit) {
        val w = webView ?: return
        runOnUiThread { runCatching { block(w) }.onFailure { Log.w(TAG, "webview call", it) } }
    }

    private fun start() {
        val root = File(filesDir, "runtime")
        val usr = File(root, "usr")

        if (needsExtract(usr)) {
            showStatus(getString(R.string.status_extracting))
            extractRuntime(usr)
            markExtracted()
        }

        copyNodeProject(root)

        showStatus(getString(R.string.status_booting))
        spawnNode(usr, root)

        if (!waitForHealth()) {
            showStatus(getString(R.string.startup_timeout, tailOfNodeLog()))
            return
        }

        runOnUiThread {
            status.visibility = View.GONE
            loadApp()
        }
    }

    // ---------------------------------------------------------------- runtime

    private fun needsExtract(usr: File): Boolean {
        // bin/node is not in the tarball any more — it ships as a native library
        // so Android puts it somewhere executable. libicudata is the largest
        // file in the bundle and the last thing a partial unpack would leave
        // behind, so it is a reasonable marker that extraction completed.
        if (!File(usr, "lib/libicudata.so.78.3").isFile) return true
        val prefs = getSharedPreferences("soundwave", Context.MODE_PRIVATE)
        return prefs.getInt("runtime_version", -1) != RUNTIME_VERSION
    }

    private fun markExtracted() {
        getSharedPreferences("soundwave", Context.MODE_PRIVATE)
            .edit().putInt("runtime_version", RUNTIME_VERSION).apply()
    }

    /** Unpacks assets/runtime/usr.tar.xz (~22 MB) into filesDir/runtime/usr. */
    private fun extractRuntime(dest: File) {
        if (dest.exists()) dest.deleteRecursively()
        dest.mkdirs()

        assets.open("runtime/usr.tar.xz").use { raw ->
            XZCompressorInputStream(raw).use { xz ->
                TarArchiveInputStream(xz).use { tar ->
                    var entry = tar.nextEntry
                    while (entry != null) {
                        val out = File(dest, entry.name)
                        // Refuse anything that escapes the destination.
                        if (out.canonicalPath.startsWith(dest.canonicalPath + File.separator) ||
                            out.canonicalPath == dest.canonicalPath
                        ) {
                            when {
                                entry.isSymbolicLink -> {
                                    // NOT optional. Several libraries node links
                                    // against — libicuuc.so.78, libicui18n.so.78,
                                    // libz.so.1, libsqlite3.so — exist only as a
                                    // symlink to the versioned file. Skipping
                                    // these makes node fail to load at exec time.
                                    out.parentFile?.mkdirs()
                                    out.delete()
                                    try {
                                        java.nio.file.Files.createSymbolicLink(
                                            out.toPath(),
                                            java.nio.file.Paths.get(entry.linkName),
                                        )
                                    } catch (e: Exception) {
                                        // Filesystems without symlink support:
                                        // fall back to copying the target.
                                        val target = File(out.parentFile, entry.linkName)
                                        if (target.isFile) target.copyTo(out, overwrite = true)
                                        else Log.w(TAG, "symlink skipped: ${entry.name} -> ${entry.linkName}")
                                    }
                                }
                                entry.isFile -> {
                                    out.parentFile?.mkdirs()
                                    FileOutputStream(out).use { tar.copyTo(it) }
                                    // Termux ships bin/node already mode 755; honour it.
                                    if (entry.mode and 0b001_001_001 != 0) out.setExecutable(true, false)
                                }
                            }
                        }
                        entry = tar.nextEntry
                    }
                }
            }
        }

        val marker = File(dest, "lib/libicudata.so.78.3")
        if (!marker.isFile) {
            throw IllegalStateException("runtime extracted but lib/libicudata.so.78.3 is missing")
        }
        File(dest, "tmp").mkdirs()
        File(dest, "home").mkdirs()
        Log.i(TAG, "runtime extracted to ${dest.absolutePath}")
    }

    /**
     * Copies assets/nodejs-project into filesDir/runtime, but only when the APK
     * itself changed — otherwise every launch would rewrite the whole tree.
     */
    private fun copyNodeProject(root: File) {
        val prefs = getSharedPreferences("soundwave", Context.MODE_PRIVATE)
        // lastUpdateTime is epoch millis; -1 means "never recorded".
        val update = packageManager.getPackageInfo(packageName, 0).lastUpdateTime
        if (prefs.getLong("apk_last_update_time", -1L) == update && File(root, "nodejs-project/main.js").isFile) {
            return
        }
        val dest = File(root, "nodejs-project")
        if (dest.exists()) dest.deleteRecursively()
        copyAssetDir("nodejs-project", dest)
        prefs.edit().putLong("apk_last_update_time", update).apply()
        Log.i(TAG, "node project staged at ${dest.absolutePath}")
    }

    private fun copyAssetDir(assetPath: String, dest: File) {
        val children = assets.list(assetPath) ?: emptyArray()
        if (children.isEmpty()) {
            dest.parentFile?.mkdirs()
            assets.open(assetPath).use { input ->
                FileOutputStream(dest).use { input.copyTo(it) }
            }
            return
        }
        dest.mkdirs()
        for (child in children) {
            copyAssetDir("$assetPath/$child", File(dest, child))
        }
    }

    // ------------------------------------------------------------------- node

    /**
     * Locates the Node executable.
     *
     * Normally this is nativeLibraryDir/libnode.so, which the installer extracted
     * from the APK. That directory is the only place the app is allowed to exec
     * from — a copy in filesDir fails with EACCES on Android 10+.
     *
     * Some devices and install flows leave nativeLibraryDir empty, so fall back
     * to the copy in the unpacked runtime and let the error surface if that is
     * blocked too. Better a clear message than a silent dead app.
     */
    private fun nodeBinary(usr: File): File {
        val native = File(applicationInfo.nativeLibraryDir, "libnode.so")
        if (native.isFile) {
            native.setExecutable(true, false)
            Log.i(TAG, "node binary: ${native.absolutePath} (nativeLibraryDir)")
            return native
        }
        Log.w(TAG, "nativeLibraryDir has no libnode.so; falling back to filesDir")
        val fallback = File(usr, "bin/node")
        fallback.setExecutable(true, false)
        return fallback
    }

    private fun spawnNode(usr: File, root: File) {
        val node = nodeBinary(usr)
        val log = File(root, "node.log")

        val pb = ProcessBuilder(
            node.absolutePath,
            File(root, "nodejs-project/main.js").absolutePath,
        )
        pb.directory(root)
        pb.redirectErrorStream(true)
        pb.redirectOutput(ProcessBuilder.Redirect.to(log))

        // The binary's RUNPATH is /data/data/com.termux/files/usr/lib, which does
        // not exist in this app's sandbox. Android's linker honours
        // LD_LIBRARY_PATH for non-setuid executables, so point it at the unpacked
        // libraries instead. This is what makes the bundled runtime relocatable.
        val env = pb.environment()
        env["LD_LIBRARY_PATH"] = File(usr, "lib").absolutePath
        env["PATH"] = "${File(usr, "bin").absolutePath}:/system/bin:/vendor/bin"
        env["TMPDIR"] = File(usr, "tmp").absolutePath
        env["HOME"] = File(usr, "home").absolutePath
        env["NODE_ENV"] = "production"
        // Keeps node from inheriting a TERM/PREFIX that points at Termux.
        env.remove("PREFIX")

        serverProcess = pb.start()
        Log.i(TAG, "spawned node pid=${serverProcess} from ${node.absolutePath}")
    }

    private fun tailOfNodeLog(): String {
        return try {
            val log = File(File(filesDir, "runtime"), "node.log")
            if (!log.isFile) return "no output"
            log.readLines().takeLast(4).joinToString(" | ")
        } catch (e: Exception) {
            "unreadable (${e.message})"
        }
    }

    // ------------------------------------------------------------------ webview

    private fun waitForHealth(): Boolean {
        val url = URL("http://127.0.0.1:$PORT/api/health")
        // Indexing 85k tracks takes a while on a phone; allow two minutes.
        repeat(240) {
            try {
                val conn = url.openConnection() as HttpURLConnection
                conn.connectTimeout = 750
                conn.readTimeout = 750
                if (conn.responseCode == 200) {
                    conn.disconnect()
                    return true
                }
                conn.disconnect()
            } catch (_: Exception) {
                // not up yet
            }
            Thread.sleep(500)
        }
        return false
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun loadApp() {
        val web = findViewById<WebView>(R.id.web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
            // Loopback audio is fetched by the page; mixed content would
            // otherwise be blocked if the page ever loads over another scheme.
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        }
        // The page reports what is playing through this bridge, which is what
        // drives the notification and lock-screen controls.
        media?.let { web.addJavascriptInterface(it.Bridge(), "SoundwaveMedia") }
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?, code: Int, description: String?, failingUrl: String?,
            ) {
                Log.w(TAG, "webview error $code $description on $failingUrl")
            }
        }
        webView = web
        web.loadUrl("http://127.0.0.1:$PORT/")
    }

    private fun showStatus(message: String) {
        runOnUiThread {
            status.visibility = View.VISIBLE
            status.text = message
        }
    }

    override fun onDestroy() {
        // Take the Node process down with the activity. Without this the process
        // outlives the UI and Android reaps it at an arbitrary later point.
        try { serverProcess?.destroy() } catch (_: Exception) {}
        media?.release()
        media = null
        webView = null
        super.onDestroy()
    }
}
