package com.soundwave.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Notification-panel and lock-screen media controls.
 *
 * The player is the web app, so nothing here knows what is playing — the page
 * reports it through [Bridge], and this turns that into a MediaSession plus a
 * MediaStyle notification. Transport buttons flow the other way: the session
 * callback calls back into JavaScript, which drives the same store actions the
 * on-screen buttons use. One source of truth, so the two cannot drift apart.
 *
 * Built on android.media.session rather than androidx.media: every API used here
 * exists since API 21 and minSdk is 24, verified against the platform jar, so
 * there is no dependency to resolve and no version to drift.
 */
class MediaControls(private val activity: MainActivity) {

    companion object {
        private const val TAG = "SoundwaveMedia"
        private const val CHANNEL_ID = "playback"
        const val NOTIFICATION_ID = 1
        const val ACTION_PLAY = "com.soundwave.app.action.PLAY"
        const val ACTION_PAUSE = "com.soundwave.app.action.PAUSE"
        const val ACTION_NEXT = "com.soundwave.app.action.NEXT"
        const val ACTION_PREV = "com.soundwave.app.action.PREV"
        private const val ARTWORK_PX = 512
    }

    private val main = Handler(Looper.getMainLooper())
    private val session = MediaSession(activity, "SoundWave")
    private val artworkPool = Executors.newSingleThreadExecutor()

    @Volatile private var metaTitle = ""
    @Volatile private var metaArtist = ""
    @Volatile private var metaAlbum = ""
    @Volatile private var metaDurationMs = 0L
    @Volatile private var artwork: Bitmap? = null
    @Volatile private var artworkUrl: String? = null
    /** Guards against a slow download landing after the user skipped tracks. */
    @Volatile private var artworkSeq = 0
    @Volatile private var playing = false
    @Volatile private var hasTrack = false
    @Volatile private var showing = false
    /** Set when a transient focus loss paused us, so it can auto-resume. */
    @Volatile private var resumeOnFocusGain = false

    private val audio = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private var focusRequest: AudioFocusRequest? = null

    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> {
                // Another app took over permanently: stop, and don't come back.
                resumeOnFocusGain = false
                abandonFocus()
                callJs("pause")
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                // A call or a navigation prompt. Pause, then resume on return —
                // the single most expected behaviour from a music app.
                if (playing) resumeOnFocusGain = true
                callJs("pause")
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                // Notification blip: let the system duck us rather than pausing.
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                if (resumeOnFocusGain) {
                    resumeOnFocusGain = false
                    callJs("play")
                }
            }
        }
    }

    init {
        createChannel()
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() {
                requestFocus()
                callJs("play")
            }
            override fun onPause() = callJs("pause")
            override fun onSkipToNext() = callJs("next")
            override fun onSkipToPrevious() = callJs("prev")
            override fun onStop() {
                resumeOnFocusGain = false
                abandonFocus()
                callJs("stop")
            }
            override fun onSeekTo(pos: Long) = callJs("seek", pos)
        })
        session.isActive = true
    }

    /** Attached to the WebView so the page can report playback state. */
    inner class Bridge {
        @JavascriptInterface
        fun setState(json: String?) {
            if (json.isNullOrEmpty()) return
            // Runs on the WebView JavaBridge thread; MediaSession and
            // notification calls must happen on the main thread.
            main.post {
                runCatching { apply(JSONObject(json)) }
                    .onFailure { Log.w(TAG, "setState failed", it) }
            }
        }

        /**
         * An image URL. Downloaded here rather than read from a canvas in the
         * page: album art comes from several CDNs and at least one sends no CORS
         * header, which taints the canvas and makes it unreadable from
         * JavaScript. Android has no such restriction, so fetching by URL works
         * for every provider.
         */
        @JavascriptInterface
        fun setArtworkUrl(url: String?) {
            if (url.isNullOrEmpty()) return
            val seq = ++artworkSeq
            artworkUrl = url
            artworkPool.execute {
                val bmp = download(url) ?: return@execute
                main.post {
                    // A newer track may already have superseded this download.
                    if (seq != artworkSeq) return@post
                    artwork = bmp
                    publishMetadata()
                    if (showing) notifyNow()
                }
            }
        }
    }

    // ----------------------------------------------------------------- state

    private fun apply(o: JSONObject) {
        val wasPlaying = playing
        metaTitle = o.optString("title", "")
        metaArtist = o.optString("artist", "")
        metaAlbum = o.optString("album", "")
        metaDurationMs = o.optLong("durationMs", 0L)
        playing = o.optBoolean("playing", false)
        hasTrack = o.optBoolean("hasTrack", false)

        if (playing && !wasPlaying) requestFocus()

        publishMetadata()

        val state = PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
                    PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
                    PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP or
                    PlaybackState.ACTION_SEEK_TO
            )
            // Speed 1.0 while playing lets the system interpolate the position,
            // so the page does not have to report a tick every second.
            .setState(
                when {
                    !hasTrack -> PlaybackState.STATE_STOPPED
                    playing -> PlaybackState.STATE_PLAYING
                    else -> PlaybackState.STATE_PAUSED
                },
                o.optLong("positionMs", 0L),
                if (playing) 1f else 0f,
                System.currentTimeMillis(),
            )
            .build()
        session.setPlaybackState(state)

        if (!hasTrack) {
            dismiss()
            return
        }
        showing = true
        notifyNow()
    }

    private fun publishMetadata() {
        val b = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, metaTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, metaArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, metaAlbum)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, metaDurationMs)
        artwork?.let { b.putBitmap(MediaMetadata.METADATA_KEY_ART, it) }
        session.setMetadata(b.build())
    }

    // ---------------------------------------------------------- notification

    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val ch = NotificationChannel(
            CHANNEL_ID,
            activity.getString(R.string.channel_playback),
            // LOW: silent. A media notification that dings on every track change
            // is the fastest way to get uninstalled.
            NotificationManager.IMPORTANCE_LOW,
        )
        ch.description = activity.getString(R.string.channel_playback_desc)
        ch.setShowBadge(false)
        ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        manager().createNotificationChannel(ch)
    }

    private fun manager() =
        activity.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun notifyNow() {
        runCatching { manager().notify(NOTIFICATION_ID, buildNotification()) }
            .onFailure { Log.w(TAG, "notify failed", it) }
    }

    private fun buildNotification(): Notification {
        val contentIntent = PendingIntent.getActivity(
            activity, 0,
            Intent(activity, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val b = Notification.Builder(activity, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_wave)
            .setContentTitle(metaTitle)
            .setContentText(metaArtist)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            // Stays put while playing so a stray swipe cannot kill playback.
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )

        if (metaAlbum.isNotEmpty()) b.setSubText(metaAlbum)
        artwork?.let { b.setLargeIcon(it) }

        b.addAction(action(R.drawable.ic_media_prev, "Previous", ACTION_PREV))
        b.addAction(
            action(
                if (playing) R.drawable.ic_media_pause else R.drawable.ic_media_play,
                if (playing) "Pause" else "Play",
                if (playing) ACTION_PAUSE else ACTION_PLAY,
            )
        )
        b.addAction(action(R.drawable.ic_media_next, "Next", ACTION_NEXT))
        return b.build()
    }

    /**
     * The buttons target the activity rather than a BroadcastReceiver, so there
     * is no exported component and no static reference back to the activity. The
     * activity is singleTask, so these arrive in onNewIntent.
     */
    private fun action(icon: Int, title: String, action: String): Notification.Action {
        val pi = PendingIntent.getActivity(
            activity, action.hashCode(),
            Intent(activity, MainActivity::class.java)
                .setAction(action)
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Action.Builder(icon, title, pi).build()
    }

    fun dismiss() {
        showing = false
        runCatching { manager().cancel(NOTIFICATION_ID) }
    }

    /** Handles a transport action that arrived as an activity intent. */
    fun handle(action: String?) {
        val c = session.controller.transportControls
        when (action) {
            ACTION_PLAY -> main.post { c.play() }
            ACTION_PAUSE -> main.post { c.pause() }
            ACTION_NEXT -> main.post { c.skipToNext() }
            ACTION_PREV -> main.post { c.skipToPrevious() }
        }
    }

    fun release() {
        runCatching {
            abandonFocus()
            dismiss()
            session.isActive = false
            session.release()
            artworkPool.shutdownNow()
        }
    }

    // --------------------------------------------------------- audio focus

    private fun requestFocus() {
        runCatching {
            val attrs = AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build()
            val granted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setWillPauseWhenDucked(true)
                    .setOnAudioFocusChangeListener(focusListener, main)
                    .build()
                focusRequest = req
                audio.requestAudioFocus(req)
            } else {
                @Suppress("DEPRECATION")
                audio.requestAudioFocus(
                    focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN,
                )
            }
            if (granted != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                Log.i(TAG, "audio focus not granted: $granted")
            }
        }.onFailure { Log.w(TAG, "requestFocus failed", it) }
    }

    private fun abandonFocus() {
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                focusRequest?.let { audio.abandonAudioFocusRequest(it) }
                focusRequest = null
            } else {
                @Suppress("DEPRECATION")
                audio.abandonAudioFocus(focusListener)
            }
        }
    }

    // -------------------------------------------------------------- plumbing

    private fun callJs(fn: String, arg: Long = -1) {
        val js = if (arg >= 0) "window.__swMedia&&window.__swMedia.$fn($arg)"
                 else "window.__swMedia&&window.__swMedia.$fn()"
        activity.runOnWebView { it.evaluateJavascript(js, null) }
    }

    /** Downloads and downscales album art. Runs off the main thread. */
    private fun download(url: String): Bitmap? = runCatching {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 8000
        conn.readTimeout = 8000
        conn.instanceFollowRedirects = true
        conn.setRequestProperty("User-Agent", "SoundWave/1.0")
        try {
            if (conn.responseCode !in 200..299) return null
            val bytes = conn.inputStream.use { it.readBytes() }
            decodeDownsampled(bytes)
        } finally {
            conn.disconnect()
        }
    }.getOrNull()

    /**
     * Decodes straight to roughly the notification size. Full-size album art is
     * often 1200px, and holding several of those in a notification bitmap is how
     * apps get killed for memory.
     */
    private fun decodeDownsampled(bytes: ByteArray): Bitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= ARTWORK_PX) sample *= 2
        val opts = BitmapFactory.Options().apply { inSampleSize = sample }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    }
}
