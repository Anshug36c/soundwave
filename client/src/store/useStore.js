import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { streamFor } from '../services/musicApi';
import { trackKeyOf, excludeKey, dailySeed, newSeed } from '../services/taste';

// A skip is a taste signal only if the listener gave the track a real chance.
// 30s matches the industry "a play counts" threshold and Echo's own candidate
// filter (which forgives skips once 45s of total listening exists).
const SKIP_BEFORE_S = 30;

// Both playStats writers (pushHistory and recordPlayTime) share one cap, or the
// table grows without bound in localStorage: 400 tracks, oldest last-played
// dropped first. Mirrors the existing playCounts cap.
const PLAY_STATS_CAP = 400;
function capPlayStats(playStats) {
  const keys = Object.keys(playStats);
  if (keys.length <= PLAY_STATS_CAP) return playStats;
  keys.sort((a, b) => (playStats[a]?.lastPlayedAtMillis || 0) - (playStats[b]?.lastPlayedAtMillis || 0));
  const out = { ...playStats };
  for (const k of keys.slice(0, keys.length - PLAY_STATS_CAP)) delete out[k];
  return out;
}

const uid = () => Math.random().toString(36).slice(2, 10);

// persist writes fire on EVERY state change — including the ~4Hz playback clock
// (setTime) — but currentTime/duration aren't in partialize, so clock ticks
// re-emit a byte-identical payload. Skip identical writes: discrete actions
// still persist instantly (synchronously), clock churn costs one memcmp.
const persistStorage = (() => {
  let lastWritten = null;
  return {
    getItem: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    setItem: (k, v) => {
      v = String(v);
      if (v === lastWritten) return;
      lastWritten = v;
      try { localStorage.setItem(k, v); } catch { /* quota/private-mode */ }
    },
    removeItem: (k) => { lastWritten = null; try { localStorage.removeItem(k); } catch { /* noop */ } },
  };
})();

export const useStore = create(
  persist(
    (set, get) => ({
      // ---------- player (not persisted except prefs) ----------
      queue: [],
      index: -1,
      isPlaying: false,
      buffering: false, // audible stall or src assigned but not yet playing
      setBuffering: (v) => set({ buffering: v }),
      playError: null, // persistent playback failure; the player UI shows Failed
      setPlayError: (v) => set({ playError: v }),
      shuffle: false,
      repeat: 'off', // off | one | all
      abLoop: { a: null, b: null }, // A-B section repeat, seconds (transient)
      volume: 0.9,
      gain: 1, // volume boost multiplier 1..2 via Studio graph master gain
      muted: false,
      playbackRate: 1,
      // Echo v1.4.2 "Varispeed": link pitch to speed for a tape-style effect.
      // Off (default) keeps the browser's pitch-preserving time stretch.
      varispeed: false,
      setPlaybackRate: (v) => set({ playbackRate: v }),
      setVarispeed: (v) => set({ varispeed: !!v }),
      currentTime: 0,
      duration: 0,
      showFullPlayer: false,
      showQueue: false,
      similar: [], // similar songs for current track (transient, not persisted)
      setSimilar: (s) => set({ similar: s || [] }),
      disliked: {}, // trackId -> true (excluded from recommendations)
      hiddenArtists: {}, // folded name -> display name
      discoverMix: 30, // 0 familiar .. 100 adventurous
      toggleDislike: (track) => set(s => {
        const d = { ...s.disliked };
        if (d[track.id]) delete d[track.id]; else d[track.id] = true;
        return { disliked: d };
      }),
      // Echo v1.4.2 song-menu action "Never recommend again": the track leaves
      // every local recommendation surface AND is sent to /api/for-you as an
      // exclusion, so the server refills the slot instead of returning it short.
      neverRecommend: (track) => {
        if (!track?.id) return;
        const s = get();
        const on = !s.disliked[track.id];
        s.toggleDislike(track);
        s.toast(on ? `Won't recommend “${track.title}” again` : `“${track.title}” allowed back`, 'info');
      },
      // Keys sent to the server for "never recommend again" filtering: the raw
      // id plus the folded "title|artist" key, so the same recording is still
      // excluded when it comes back from a different provider.
      excludeKeys: () => {
        const s = get();
        const out = new Set();
        for (const [id, t] of Object.entries(s.disliked)) {
          if (!id) continue;
          out.add(String(id).toLowerCase());
          // `disliked` stores `true`, not the track — resolve the object from
          // stats, liked or history, or the title|artist key can never be built.
          const src = (t && typeof t === 'object') ? t
            : s.playStats[id]?.track || s.liked[id] || s.history.find(h => h?.id === id);
          const k = excludeKey(src?.title || '', src?.artist?.name || '');
          if (k && k !== '|') out.add(k);
        }
        return [...out];
      },
      hideArtist: (name) => { const k = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); if (k) set(s => ({ hiddenArtists: { ...s.hiddenArtists, [k]: name } })); },
      unhideArtist: (name) => { const k = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); set(s => { const h = { ...s.hiddenArtists }; delete h[k]; return { hiddenArtists: h }; }); },
      setDiscoverMix: (v) => set({ discoverMix: v }),
      resetTaste: () => { set({ liked: {}, disliked: {}, hiddenArtists: {}, similar: [], playStats: {} }); get().toast('Taste profile reset', 'info'); },
      sleepTimerMin: 0,

      playTracks: (tracks, startIndex = 0) => {
        const list = (tracks || []).filter(Boolean);
        if (!list.length) return;
        get()._maybeSkip();
        const si = Math.max(0, Math.min(startIndex | 0, list.length - 1));
        set({ queue: list, index: si, isPlaying: true, currentTime: 0 });
        get().pushHistory(list[si]);
      },
      playTrack: (track, context = []) => {
        if (!track) return;
        if (context?.length) {
          const i = context.findIndex(t => t.id === track.id);
          get().playTracks(context, i >= 0 ? i : 0); // skip is counted inside
        } else {
          get()._maybeSkip();
          const { queue } = get();
          const i = queue.findIndex(t => t.id === track.id);
          if (i >= 0) { set({ index: i, isPlaying: true }); get().pushHistory(track); }
          else { set({ queue: [...queue, track], index: queue.length, isPlaying: true }); get().pushHistory(track); }
        }
      },
      togglePlay: () => set(s => (s.index < 0 && s.queue.length ? { index: 0, isPlaying: true } : { isPlaying: !s.isPlaying })),
      next: () => {
        const { queue, index, shuffle } = get();
        if (!queue.length) return;
        get()._maybeSkip();
        if (shuffle && queue.length > 1) {
          let n = index;
          while (n === index) n = Math.floor(Math.random() * queue.length);
          set({ index: n, isPlaying: true, currentTime: 0 });
        } else {
          set({ index: (index + 1) % queue.length, isPlaying: true, currentTime: 0 });
        }
        const t = get().queue[get().index];
        if (t) get().pushHistory(t);
      },
      prev: () => {
        const { queue, index, currentTime } = get();
        if (!queue.length) return;
        get()._maybeSkip();
        if (currentTime > 3) { set({ currentTime: 0 }); get()._seekTo?.(0); return; }
        const n = (index - 1 + queue.length) % queue.length;
        set({ index: n, isPlaying: true, currentTime: 0 });
        const t = get().queue[n];
        if (t) get().pushHistory(t);
      },
      addToQueue: (track) => { if (!track?.id) return; set(s => ({ queue: [...s.queue, track] })); },
      appendTracks: (tracks) => set(s => {
        const have = new Set(s.queue.map(t => t?.id));
        const fresh = (tracks || []).filter(t => t?.id && !have.has(t.id));
        if (!fresh.length) return s;
        return { queue: [...s.queue, ...fresh] };
      }),
      addManyToQueue: (tracks) => {
        const list = (tracks || []).filter(t => t?.id);
        if (!list.length) return;
        set(s => ({ queue: [...s.queue, ...list] }));
        get().toast(`${list.length} song${list.length > 1 ? 's' : ''} added to queue`, 'info');
      },
      playNext: (track) => {
        if (!track?.id) return;
        set(s => { const q = [...s.queue]; q.splice(s.index + 1, 0, track); return { queue: q }; });
        get().toast('Will play next', 'info');
      },
      moveInQueue: (from, to) => set(s => {
        if (from < 0 || to < 0 || from >= s.queue.length || to >= s.queue.length || from === to) return s;
        const q = [...s.queue];
        const [m] = q.splice(from, 1);
        q.splice(to, 0, m);
        let idx = s.index;
        if (s.index === from) idx = to;
        else if (from < s.index && to >= s.index) idx -= 1;
        else if (from > s.index && to <= s.index) idx += 1;
        return { queue: q, index: idx };
      }),
      removeFromQueue: (i) => set(s => {
        const q = s.queue.filter((_, k) => k !== i);
        let idx = s.index;
        if (i < s.index) idx -= 1;
        const removedCurrent = i === s.index;
        if (removedCurrent) idx = Math.min(idx, q.length - 1);
        return { queue: q, index: q.length ? idx : -1, isPlaying: q.length ? s.isPlaying : false, ...(removedCurrent ? { currentTime: 0 } : null) };
      }),
      clearQueue: () => set({ queue: [], index: -1, isPlaying: false }),
      setPlaying: (v) => set({ isPlaying: v }),
      setTime: (t, d) => set({ currentTime: t, duration: d || get().duration }),
      setVolume: (v) => set({ volume: v, muted: v === 0 ? true : get().muted }),
      setMuted: (m) => set({ muted: m }),
      setGain: (v) => set({ gain: Math.min(2, Math.max(1, +v || 1)) }),
      // A-B cycle: tap1 sets A, tap2 sets B (loops), tap3 clears
      cycleLoopPoint: (t) => set(s => {
        const tt = Math.max(0, +t || 0);
        const { a, b } = s.abLoop;
        if (b != null) return { abLoop: { a: null, b: null } };
        if (a == null || tt <= a + 0.5) return { abLoop: { a: tt, b: null } };
        return { abLoop: { a, b: tt } };
      }),
      clearLoop: () => set(s => (s.abLoop.a == null && s.abLoop.b == null) ? s : { abLoop: { a: null, b: null } }),
      toggleShuffle: () => set(s => ({ shuffle: !s.shuffle })),
      cycleRepeat: () => set(s => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
      setShowFullPlayer: (v) => set({ showFullPlayer: v }),
      setShowQueue: (v) => set({ showQueue: v }),
      setSleepTimer: (min) => set({ sleepTimerMin: min }),

      // ---------- library ----------
      liked: {},            // id -> track
      playlists: [],        // {id,name,description,tracks,isPublic,createdAt}
      followedArtists: {},  // id -> artist
      savedAlbums: {},      // id -> album
      history: [],          // recent tracks (dedup, max 100)
      downloads: {},        // id -> true

      toggleLike: (track) => set(s => {
        const liked = { ...s.liked };
        if (liked[track.id]) delete liked[track.id]; else liked[track.id] = { ...track, _likedAt: Date.now() };
        return { liked };
      }),
      createPlaylist: (name, description = '') => {
        const pl = { id: `local:${uid()}`, name, description, tracks: [], isPublic: true, createdAt: Date.now() };
        set(s => ({ playlists: [pl, ...s.playlists] }));
        return pl.id;
      },
      deletePlaylist: (id) => set(s => ({ playlists: s.playlists.filter(p => p.id !== id) })),
      renamePlaylist: (id, name, description) => set(s => ({
        playlists: s.playlists.map(p => (p.id === id ? { ...p, name, description: description ?? p.description } : p)),
      })),
      addToPlaylist: (playlistId, track) => set(s => ({
        playlists: s.playlists.map(p => (p.id === playlistId && !p.tracks.some(t => t.id === track.id) ? { ...p, tracks: [...p.tracks, track] } : p)),
      })),
      removeFromPlaylist: (playlistId, trackId) => set(s => ({
        playlists: s.playlists.map(p => (p.id === playlistId ? { ...p, tracks: p.tracks.filter(t => t.id !== trackId) } : p)),
      })),
      reorderPlaylist: (playlistId, from, to) => set(s => ({
        playlists: s.playlists.map(p => {
          if (p.id !== playlistId) return p;
          const arr = [...p.tracks];
          const [m] = arr.splice(from, 1);
          arr.splice(to, 0, m);
          return { ...p, tracks: arr };
        }),
      })),
      toggleFollowArtist: (artist) => set(s => {
        const f = { ...s.followedArtists };
        if (f[artist.id]) delete f[artist.id]; else f[artist.id] = artist;
        return { followedArtists: f };
      }),
      toggleSaveAlbum: (album) => set(s => {
        const a = { ...s.savedAlbums };
        if (a[album.id]) delete a[album.id]; else a[album.id] = album;
        return { savedAlbums: a };
      }),
      playCounts: {}, // id -> { n, last, track } for Most Played (capped)
      // Echo v1.4.2 Local Taste Engine input: accumulated listening time and
      // skip counts per track, keyed by id and carrying upstream's trackKey.
      // Shape matches scoreStats()/applyCandidateFilter() field-for-field.
      playStats: {},
      recordPlayTime: (track, deltaMs) => {
        const id = track?.id;
        const ms = Math.max(0, Math.min(Number(deltaMs) || 0, 10000)); // clamp a throttled-tab jump
        if (!id || ms <= 0) return;
        set(s => {
          const prev = s.playStats[id];
          const next = {
            trackKey: prev?.trackKey || trackKeyOf(track.title, track.artist?.name),
            title: track.title || prev?.title || '',
            artist: track.artist?.name || prev?.artist || '',
            totalPlayTimeMs: (prev?.totalPlayTimeMs || 0) + ms,
            playCount: prev?.playCount || 0,
            skipCount: prev?.skipCount || 0,
            lastPlayedAtMillis: Date.now(),
            track: prev?.track || track,
          };
          return { playStats: capPlayStats({ ...s.playStats, [id]: next }) };
        });
      },
      recordSkip: (track) => {
        const id = track?.id;
        if (!id) return;
        set(s => {
          const prev = s.playStats[id];
          return {
            playStats: capPlayStats({
              ...s.playStats,
              [id]: {
                trackKey: prev?.trackKey || trackKeyOf(track.title, track.artist?.name),
                title: track.title || '', artist: track.artist?.name || '',
                totalPlayTimeMs: prev?.totalPlayTimeMs || 0,
                playCount: prev?.playCount || 0,
                skipCount: (prev?.skipCount || 0) + 1,
                lastPlayedAtMillis: prev?.lastPlayedAtMillis || Date.now(),
                track: prev?.track || track,
              },
            }),
          };
        });
      },
      /** Count a skip when the listener bailed before the track got going. */
      _maybeSkip: () => {
        const s = get();
        const t = s.queue[s.index];
        if (t && s.currentTime > 1 && s.currentTime < SKIP_BEFORE_S) s.recordSkip(t);
      },
      // ---------- Daily Taste Mix (Echo v1.4.2) ----------
      // One seed per calendar day: Home refreshes the mix every 24 h instead of
      // building a duplicate each mount. A manual refresh rolls a fresh
      // per-invocation seed, which is what makes the picks differ (#559).
      tasteMix: { day: 0, seed: 0 },
      syncTasteMix: () => {
        const day = dailySeed();
        const cur = get().tasteMix || { day: 0, seed: 0 };
        if (cur.day === day && cur.seed) return cur.seed;
        set({ tasteMix: { day, seed: day } });
        return day;
      },
      refreshTasteMix: () => {
        const seed = newSeed();
        set(s => ({ tasteMix: { ...s.tasteMix, seed } }));
        return seed;
      },
      pushHistory: (track) => {
        if (!track?.id) return;
        const stamped = { ...track, _playedAt: Date.now() };
        set(s => {
          let playStatsDraft = null;
          const pc = { ...s.playCounts };
          pc[track.id] = { n: (pc[track.id]?.n || 0) + 1, last: Date.now(), track: stamped };
          const st = s.playStats[track.id];
          playStatsDraft = {
            ...s.playStats,
            [track.id]: {
              trackKey: st?.trackKey || trackKeyOf(track.title, track.artist?.name),
              title: track.title || '', artist: track.artist?.name || '',
              totalPlayTimeMs: st?.totalPlayTimeMs || 0,
              playCount: (st?.playCount || 0) + 1,
              skipCount: st?.skipCount || 0,
              lastPlayedAtMillis: Date.now(),
              track: stamped,
            },
          };
          const keys = Object.keys(pc);
          if (keys.length > 300) {
            keys.sort((a, b) => pc[a].last - pc[b].last);
            for (const k of keys.slice(0, keys.length - 300)) delete pc[k];
          }
          return {
            history: [stamped, ...s.history.filter(t => t.id !== track.id)].slice(0, 100),
            playCounts: pc,
            ...(playStatsDraft ? { playStats: capPlayStats(playStatsDraft) } : null),
          };
        });
      },
      clearHistory: () => set({ history: [] }),
      toggleDownload: (track) => {
        const s = get();
        const dl = { ...s.downloads };
        // cache the EXACT playback URL (quality params included) — the raw
        // streamUrl never matches a playback request, so offline would always miss
        const url = track.streamUrl ? streamFor(track, get().quality) : '';
        if (dl[track.id]) {
          delete dl[track.id];
          if (navigator.serviceWorker?.controller) navigator.serviceWorker.controller.postMessage({ type: 'UNCACHE_AUDIO', url });
        } else {
          dl[track.id] = true;
          if (navigator.serviceWorker?.controller && url) navigator.serviceWorker.controller.postMessage({ type: 'CACHE_AUDIO', url });
          else if (url) { const a = document.createElement('a'); a.href = url; a.download = `${track.title}.mp3`; a.click(); }
        }
        set({ downloads: dl });
      },

      // ---------- settings / profile ----------
      theme: 'dark',
      quality: 'auto', // auto = pick tier from network speed (effectiveType)
      crossfade: true, // smooth fade between tracks
      autoplay: true, // queue ended: keep playing similar songs (Echo Brain-style)
      studioOn: false, // Studio sound: WebAudio EQ + visualizer via proxied streams
      eqEnabled: true,
      eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      eqPreset: 'flat',
      eqPreamp: 0,
      normalizeOn: false,
      profile: { name: 'Guest Listener', email: '' },
      searchHistory: [],
      setTheme: (theme) => set({ theme }),
      setQuality: (quality) => set({ quality }),
      setCrossfade: (v) => set({ crossfade: v }),
      setAutoplay: (v) => set({ autoplay: v }),
      setStudioOn: (v) => set({ studioOn: v }),
      setEqEnabled: (v) => set({ eqEnabled: v }),
      setEqGain: (i, db) => set(s => { const eqGains = [...s.eqGains]; eqGains[i] = db; return { eqGains, eqPreset: 'custom' }; }),
      setEqPreset: (p, gains) => set({ eqPreset: p, eqGains: [...gains] }),
      setEqPreamp: (v) => set({ eqPreamp: v }),
      setNormalizeOn: (v) => set({ normalizeOn: v }),
      setProfile: (p) => set(s => ({ profile: { ...s.profile, ...p } })),
      pushSearch: (q) => set(s => ({ searchHistory: [q, ...s.searchHistory.filter(x => x !== q)].slice(0, 12) })),
      clearSearchHistory: () => set({ searchHistory: [] }),

      // ---------- toasts ----------
      toasts: [],
      toast: (msg, kind = 'info') => {
        const id = uid();
        set(s => ({ toasts: [...s.toasts, { id, msg, kind }] }));
        setTimeout(() => set(s => ({ toasts: s.toasts.filter(t => t.id !== id) })), 2600);
      },
    }),
    {
      name: 'soundwave-store-v1',
      storage: createJSONStorage(() => persistStorage),
      merge: (ps, cs) => {
        if (!ps) return cs;
        const q = Array.isArray(ps.queue) ? ps.queue.filter(Boolean).slice(0, 200) : [];
        return { ...cs, ...ps, queue: q, index: q.length ? Math.max(-1, Math.min(ps.index ?? -1, q.length - 1)) : -1 };
      },
      partialize: (s) => ({
        queue: s.queue.slice(0, 200), index: s.index,
        liked: s.liked, playlists: s.playlists, followedArtists: s.followedArtists,
        savedAlbums: s.savedAlbums, history: s.history, playCounts: s.playCounts, playStats: s.playStats, downloads: s.downloads,
        theme: s.theme, quality: s.quality, playbackRate: s.playbackRate, varispeed: s.varispeed,
        crossfade: s.crossfade, autoplay: s.autoplay, tasteMix: s.tasteMix,
        studioOn: s.studioOn, eqEnabled: s.eqEnabled, eqGains: s.eqGains,
        eqPreset: s.eqPreset, eqPreamp: s.eqPreamp, normalizeOn: s.normalizeOn,
        profile: s.profile, searchHistory: s.searchHistory, volume: s.volume, gain: s.gain,
        disliked: s.disliked, hiddenArtists: s.hiddenArtists, discoverMix: s.discoverMix,
      }),
    }
  )
);
