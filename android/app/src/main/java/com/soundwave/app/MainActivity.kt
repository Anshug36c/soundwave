package com.soundwave.app

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
// NOTE: this is the raw nodejs-mobile library, not the React Native plugin
// (whose package is com.janeasystems.rn_nodejs_mobile and whose NDK toolchain
// step is broken). If the class is not found at build time, this import and the
// dependency coordinate in app/build.gradle.kts are the two lines to correct.
import com.janeasystems.nodejs_mobile.NodeJsMobile
import java.io.File
import java.io.FileOutputStream

/**
 * SoundWave on Android: an embedded Node.js server plus a WebView pointed at it.
 *
 * The APK carries the real backend (server/server.js and its dependencies) in
 * assets/nodejs-project. On first launch after an install or update it is copied
 * to filesDir — Node cannot run from inside the APK archive — and then the
 * runtime is started with assets/nodejs-project/main.js, which boots Express on
 * 127.0.0.1:5000. The WebView polls /api/health until the provider indexes have
 * loaded, then loads the app.
 *
 * Nothing here talks to the network except the Node server itself; the WebView
 * only ever reaches loopback.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var web: WebView
    private lateinit var status: TextView
    private var nodeStarted = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        web = findViewById(R.id.web)
        status = findViewById(R.id.status)

        val settings = web.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true       // playlists, likes and history live in localStorage
        settings.mediaPlaybackRequiresUserGesture = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.cacheMode = android.webkit.WebSettings.LOAD_DEFAULT

        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                // Keep everything inside this WebView, including external links the
                // provider metadata may contain.
                return true
            }
        }

        startNodeThenLoadApp()
    }

    private fun startNodeThenLoadApp() {
        // Read the APK timestamp on the main thread: PackageManager is not safe
        // to call from the worker thread on every OEM.
        val apkTime = packageManager.getApplicationInfo(packageName, 0).lastUpdateTime
        Thread {
            try {
                val nodeDir = File(filesDir, "nodejs-project")
                if (apkTime != savedApkTime) {
                    // The bundled project changes with every APK, so an update must
                    // replace it — otherwise the old backend keeps running.
                    nodeDir.deleteRecursively()
                    copyAssetFolder("nodejs-project", nodeDir)
                    savedApkTime = apkTime
                }

                if (!nodeStarted) {
                    nodeStarted = true
                    NodeJsMobile.startNodeWithArguments(
                        arrayOf("node", File(nodeDir, "main.js").absolutePath)
                    )
                }

                runOnUiThread { status.text = getString(R.string.starting) }
                waitForServer()
            } catch (e: Exception) {
                Log.e(TAG, "startup failed", e)
                runOnUiThread { status.text = getString(R.string.startup_failed, e.message ?: e.javaClass.simpleName) }
            }
        }.start()
    }

    /** Poll the embedded server until it answers, then hand over to the WebView. */
    private fun waitForServer() {
        val url = "http://127.0.0.1:$PORT/api/health"
        var attempt = 0
        while (attempt < MAX_ATTEMPTS) {
            attempt++
            try {
                val conn = java.net.URL(url).openConnection() as java.net.HttpURLConnection
                conn.connectTimeout = 1500
                conn.readTimeout = 1500
                conn.requestMethod = "GET"
                if (conn.responseCode == 200) {
                    runOnUiThread {
                        status.visibility = View.GONE
                        web.loadUrl("http://127.0.0.1:$PORT/")
                    }
                    return
                }
                conn.disconnect()
            } catch (_: Exception) {
                // not up yet — the provider indexes take a few seconds to load
            }
            Thread.sleep(500)
        }
        runOnUiThread { status.text = getString(R.string.startup_timeout) }
    }

    /** APK timestamp of the copy currently extracted into filesDir. */
    private var savedApkTime: Long
        get() = getSharedPreferences(PREFS, MODE_PRIVATE).getLong(KEY_UPDATE_TIME, 0L)
        set(value) = getSharedPreferences(PREFS, MODE_PRIVATE).edit().putLong(KEY_UPDATE_TIME, value).apply()

    // ---------------- asset extraction ----------------

    private fun copyAssetFolder(assetPath: String, dest: File) {
        val assets = assets
        val children = assets.list(assetPath)
        if (children.isNullOrEmpty()) {
            // A leaf: list() returns empty for files as well as for empty dirs.
            assets.open(assetPath).use { input ->
                dest.parentFile?.mkdirs()
                FileOutputStream(dest).use { output -> input.copyTo(output) }
            }
            return
        }
        dest.mkdirs()
        for (child in children) {
            copyAssetFolder("$assetPath/$child", File(dest, child))
        }
    }

    override fun onBackPressed() {
        if (web.canGoBack()) web.goBack() else super.onBackPressed()
    }

    companion object {
        private const val TAG = "SoundWave"
        private const val PORT = 5000
        private const val MAX_ATTEMPTS = 120      // 120 x 500ms = up to 60s of cold start
        private const val PREFS = "soundwave"
        private const val KEY_UPDATE_TIME = "apk_last_update_time"
    }
}
