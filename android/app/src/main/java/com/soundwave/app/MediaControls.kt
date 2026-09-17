package com.soundwave.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * Notification-panel and lock-screen media controls.
 *
 * The player is the web app, so nothing here knows what is playing — the page
 * reports it through [Bridge], and this turns that into a MediaSession plus a
 * MediaStyle notification. Transport buttons flow the other way: the session
 * callback calls back into JavaScript, which drives the same store actions the
 * on-screen buttons use. There is one source of truth, and it is the store.
 *
 * Built on android.media.session rather than androidx.media. Every API used here
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
        const val ACTION_STOP = "com.soundwave.app.action.STOP"
    }

    private val main = Handler(Looper.getMainLooper())
    private val session = MediaSession(activity, "SoundWave")

    // Last reported values, kept so artwork arriving later can be merged without
    // asking MediaMetadata for them.
    @Volatile private var metaTitle = ""
    @Volatile private var metaArtist = ""
    @Volatile private var metaAlbum = ""
    @Volatile private var metaDurationMs = 0L
    @Volatile private var artwork: Bitmap? = null
    @Volatile private var playing = false
    @Volatile private var hasTrack = false
    @Volatile private var showing = false

    init {
        createChannel()
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() = callJs("play")
            override fun onPause() = callJs("pause")
            override fun onSkipToNext() = callJs("next")
            override fun onSkipToPrevious() = callJs("prev")
            override fun onStop() = callJs("stop")
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

        /** A data URL, or nothing — artwork is best-effort and never fatal. */
        @JavascriptInterface
        fun setArtwork(dataUrl: String?) {
            val bmp = decode(dataUrl) ?: return
            main.post {
                artwork = bmp
                publishMetadata()
                if (showing) notifyNow()
            }
        }
    }

    // ----------------------------------------------------------------- state

    private fun apply(o: JSONObject) {
        metaTitle = o.optString("title", "")
        metaArtist = o.optString("artist", "")
        metaAlbum = o.optString("album", "")
        metaDurationMs = o.optLong("durationMs", 0L)
        playing = o.optBoolean("playing", false)
        hasTrack = o.optBoolean("hasTrack", false)

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
            // is the single most common way to get uninstalled.
            NotificationManager.IMPORTANCE_LOW,
        )
        ch.description = activity.getString(R.string.channel_playback_desc)
        ch.setShowBadge(false)
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
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(metaTitle)
            .setContentText(metaArtist)
            .setSubText(metaAlbum)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(session.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )

        artwork?.let { b.setLargeIcon(it) }

        b.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREV))
        b.addAction(
            action(
                if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                if (playing) "Pause" else "Play",
                if (playing) ACTION_PAUSE else ACTION_PLAY,
            )
        )
        b.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
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
            ACTION_STOP -> main.post { c.stop() }
        }
    }

    fun release() {
        runCatching {
            dismiss()
            session.isActive = false
            session.release()
        }
    }

    // -------------------------------------------------------------- plumbing

    private fun callJs(fn: String, arg: Long = -1) {
        val js = if (arg >= 0) "window.__swMedia&&window.__swMedia.$fn($arg)"
                 else "window.__swMedia&&window.__swMedia.$fn()"
        activity.runOnWebView { it.evaluateJavascript(js, null) }
    }

    private fun decode(dataUrl: String?): Bitmap? {
        if (dataUrl.isNullOrEmpty()) return null
        val i = dataUrl.indexOf(',')
        if (i < 0) return null
        return runCatching {
            val bytes = Base64.decode(dataUrl.substring(i + 1), Base64.DEFAULT)
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        }.getOrNull()
    }
}
