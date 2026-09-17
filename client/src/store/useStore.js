import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { streamFor } from '../services/musicApi';

const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- per-account on-device libraries (Google sign-in) ----------
// Identity comes from the server session cookie; each account's library lives
// in its own localStorage snapshot. No database, no uploads.
const ACCOUNT_SLICES = ['liked', 'playlists', 'followedArtists', 'savedAlbums', 'history', 'playCounts', 'disliked', 'hiddenArtists', 'profile'];
const BLANK_ACCOUNT = { liked: {}, playlists: [], followedArtists: {}, savedAlbums: {}, history: [], playCounts: {}, disliked: {}, hiddenArtists: {} };
const acctKey = (k) => `soundwave-acct:${k}`;
function snapshotAccount(key) {
  try {
    const s = useStore.getState();
    const snap = {};
    for (const k of ACCOUNT_SLICES) snap[k] = s[k];
    localStorage.setItem(acctKey(key), JSON.stringify(snap));
  } catch { /* quota/private-mode: session stays in memory */ }
}
function loadAccount(key) {
  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(acctKey(key)) || 'null'); } catch { /* noop */ }
  if (!snap && key !== 'guest') snap = { ...BLANK_ACCOUNT, profile: { name: 'Listener', email: '' } };
  if (!snap) return; // guest with no snapshot: keep current (fresh) state
  useStore.setState({ ...snap });
}

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
      shuffle: false,
      repeat: 'off', // off | one | all
      abLoop: { a: null, b: null }, // A-B section repeat, seconds (transient)
      volume: 0.9,
      gain: 1, // volume boost multiplier 1..2 via Studio graph master gain
      muted: false,
      playbackRate: 1,
      setPlaybackRate: (v) => set({ playbackRate: v }),
      currentTime: 0,
      duration: 0,
      showFullPlayer: false,
      showQueue: false,
      showParty: false,
      party: null, // { role: 'host'|'guest', code } — session-only, never persisted
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
      hideArtist: (name) => { const k = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); if (k) set(s => ({ hiddenArtists: { ...s.hiddenArtists, [k]: name } })); },
      unhideArtist: (name) => { const k = String(name || '').toLowerCase().replace(/[^a-z0-9]/g, ''); set(s => { const h = { ...s.hiddenArtists }; delete h[k]; return { hiddenArtists: h }; }); },
      setDiscoverMix: (v) => set({ discoverMix: v }),
      resetTaste: () => { set({ liked: {}, disliked: {}, hiddenArtists: {}, similar: [] }); get().toast('Taste profile reset', 'info'); },
      sleepTimerMin: 0,
      instantPreview: true, // instant FLAC preview, then auto-switch to full MP3
      // How YouTube tracks play: 'audio' parks the embedded player off-screen
      // so a video is heard like a song, 'video' shows it in the player.
      ytMode: 'audio',
      setYtMode: (m) => set({ ytMode: m === 'video' ? 'video' : 'audio' }),

      playTracks: (tracks, startIndex = 0) => {
        const list = (tracks || []).filter(Boolean);
        if (!list.length) return;
        const si = Math.max(0, Math.min(startIndex | 0, list.length - 1));
        set({ queue: list, index: si, isPlaying: true, currentTime: 0 });
        get().pushHistory(list[si]);
      },
      playTrack: (track, context = []) => {
        if (!track) return;
        if (context?.length) {
          const i = context.findIndex(t => t.id === track.id);
          get().playTracks(context, i >= 0 ? i : 0);
        } else {
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
      setShowParty: (v) => set({ showParty: v }),
      startParty: (code) => set({ party: { role: 'host', code } }),
      joinParty: (code) => set({ party: { role: 'guest', code } }),
      leaveParty: () => set(s => (s.party ? { party: null } : s)),
      setSleepTimer: (min) => set({ sleepTimerMin: min }),
      setInstantPreview: (v) => set({ instantPreview: v }),

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
      pushHistory: (track) => {
        if (!track?.id) return;
        const stamped = { ...track, _playedAt: Date.now() };
        set(s => {
          const pc = { ...s.playCounts };
          pc[track.id] = { n: (pc[track.id]?.n || 0) + 1, last: Date.now(), track: stamped };
          const keys = Object.keys(pc);
          if (keys.length > 300) {
            keys.sort((a, b) => pc[a].last - pc[b].last);
            for (const k of keys.slice(0, keys.length - 300)) delete pc[k];
          }
          return { history: [stamped, ...s.history.filter(t => t.id !== track.id)].slice(0, 100), playCounts: pc };
        });
      },
      clearHistory: () => set({ history: [] }),
      toggleDownload: (track) => {
        const s = get();
        const dl = { ...s.downloads };
        // cache the EXACT playback URL (quality params included) — the raw
        // streamUrl never matches a playback request, so offline would always miss
        const url = track.streamUrl ? streamFor(track, get().quality) : track.previewUrl;
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
      liveAccount: 'guest', // which account the live store belongs to ('guest' or Google sub)
      authUser: null, // { sub, name, email, picture } — session-only, restored via /api/auth/me
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
      loginWithGoogle: (user, { silent = false } = {}) => {
        if (!user?.sub) return;
        const cur = get().liveAccount || 'guest';
        if (cur === user.sub) { set({ authUser: user }); return; }
        snapshotAccount(cur);
        loadAccount(user.sub);
        set({ authUser: user, liveAccount: user.sub, profile: { name: user.name || 'Listener', email: user.email || '', picture: user.picture || '' } });
        if (!silent) get().toast(`Signed in as ${user.name || user.email}`, 'info');
      },
      logoutToGuest: ({ silent = false } = {}) => {
        const cur = get().liveAccount || 'guest';
        if (cur !== 'guest') snapshotAccount(cur);
        loadAccount('guest');
        set({ authUser: null, liveAccount: 'guest' });
        if (!silent) get().toast('Signed out', 'info');
      },
      // boot: align the live store with the server session (cookie)
      reconcileSession: (user) => {
        if (user?.sub) get().loginWithGoogle(user, { silent: true });
        else if ((get().liveAccount || 'guest') !== 'guest') get().logoutToGuest({ silent: true });
      },
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
        savedAlbums: s.savedAlbums, history: s.history, playCounts: s.playCounts, downloads: s.downloads,
        theme: s.theme, quality: s.quality, playbackRate: s.playbackRate, crossfade: s.crossfade, autoplay: s.autoplay,
        studioOn: s.studioOn, eqEnabled: s.eqEnabled, eqGains: s.eqGains,
        eqPreset: s.eqPreset, eqPreamp: s.eqPreamp, normalizeOn: s.normalizeOn,
        profile: s.profile, liveAccount: s.liveAccount, searchHistory: s.searchHistory, volume: s.volume, gain: s.gain,
        instantPreview: s.instantPreview, disliked: s.disliked, hiddenArtists: s.hiddenArtists, discoverMix: s.discoverMix,
        ytMode: s.ytMode,
      }),
    }
  )
);
