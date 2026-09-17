package com.soundwave.app

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
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
    }

    private lateinit var status: TextView
    @Volatile private var serverProcess: Process? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status)

        Thread {
            try {
                start()
            } catch (e: Exception) {
                Log.e(TAG, "startup failed", e)
                showStatus(getString(R.string.startup_failed, e.message ?: e.javaClass.simpleName))
            }
        }.start()
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
        if (!File(usr, "bin/node").isFile) return true
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

        val node = File(dest, "bin/node")
        if (!node.isFile) throw IllegalStateException("runtime extracted but bin/node is missing")
        if (!node.setExecutable(true, false)) {
            throw IllegalStateException("could not mark bin/node executable")
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

    private fun spawnNode(usr: File, root: File) {
        val node = File(usr, "bin/node")
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
        // LD_LIBRARY_PATH for non-setuid executables, which is how Termux itself
        // runs binaries from a non-default prefix. This is the single thing that
        // makes the bundled runtime relocatable.
        val env = pb.environment()
        env["LD_LIBRARY_PATH"] = File(usr, "lib").absolutePath
        env["PATH"] = "${File(usr, "bin").absolutePath}:/system/bin:/vendor/bin"
        env["TMPDIR"] = File(usr, "tmp").absolutePath
        env["HOME"] = File(usr, "home").absolutePath
        env["NODE_ENV"] = "production"
        // Keeps node from inheriting a TERM/PREFIX that points at Termux.
        env.remove("PREFIX")

        serverProcess = pb.start()
        Log.i(TAG, "spawned node pid=${serverProcess}")
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
        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(
                view: WebView?, code: Int, description: String?, failingUrl: String?,
            ) {
                Log.w(TAG, "webview error $code $description on $failingUrl")
            }
        }
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
        super.onDestroy()
    }
}
