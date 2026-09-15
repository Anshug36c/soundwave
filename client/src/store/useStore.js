import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { pickFormat } from '../services/ytmusic';

const uid = () => Math.random().toString(36).slice(2, 10);

export const useStore = create(
  persist(
    (set, get) => ({
      // ---------- player (not persisted except prefs) ----------
      queue: [],
      index: -1,
      isPlaying: false,
      shuffle: false,
      repeat: 'off', // off | one | all
      volume: 0.9,
      muted: false,
      currentTime: 0,
      duration: 0,
      showFullPlayer: false,
      showQueue: false,
      sleepTimerMin: 0,
      formatPref: 'auto', // auto | opus | m4a (YouTube Music)
      srcOverride: null, // { url, label } — hot-swapped stream
      srcNonce: 0,
      activeFormat: null,
      ytStatus: 'idle', // idle | loading | ready | unavailable

      playTracks: (tracks, startIndex = 0) => {
        const list = (tracks || []).filter(Boolean);
        if (!list.length) return;
        set({ queue: list, index: Math.min(startIndex, list.length - 1), isPlaying: true, currentTime: 0 });
        get().pushHistory(list[Math.min(startIndex, list.length - 1)]);
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
      addToQueue: (track) => set(s => ({ queue: [...s.queue, track] })),
      removeFromQueue: (i) => set(s => {
        const q = s.queue.filter((_, k) => k !== i);
        let idx = s.index;
        if (i < s.index) idx -= 1;
        if (i === s.index) idx = Math.min(idx, q.length - 1);
        return { queue: q, index: q.length ? idx : -1, isPlaying: q.length ? s.isPlaying : false };
      }),
      clearQueue: () => set({ queue: [], index: -1, isPlaying: false }),
      setPlaying: (v) => set({ isPlaying: v }),
      setTime: (t, d) => set({ currentTime: t, duration: d || get().duration }),
      setVolume: (v) => set({ volume: v, muted: v === 0 ? true : get().muted }),
      setMuted: (m) => set({ muted: m }),
      toggleShuffle: () => set(s => ({ shuffle: !s.shuffle })),
      cycleRepeat: () => set(s => ({ repeat: s.repeat === 'off' ? 'all' : s.repeat === 'all' ? 'one' : 'off' })),
      setShowFullPlayer: (v) => set({ showFullPlayer: v }),
      setShowQueue: (v) => set({ showQueue: v }),
      setSleepTimer: (min) => set({ sleepTimerMin: min }),
      setFormatPref: (pref) => {
        const s = get();
        const t = s.queue[s.index];
        if (t?.source === 'ytmusic' && t.formats?.length) {
          const f = pickFormat(t.formats, pref);
          if (f?.url) {
            set({ formatPref: pref, srcOverride: { url: f.url, label: f.label }, activeFormat: f.label, srcNonce: s.srcNonce + 1 });
            return;
          }
        }
        set({ formatPref: pref });
      },
      switchFormat: (format) => set(s => ({
        srcOverride: { url: format.url, label: format.label },
        activeFormat: format.label,
        srcNonce: s.srcNonce + 1,
      })),
      setYtStatus: (v) => set({ ytStatus: v }),

      // ---------- library ----------
      liked: {},            // id -> track
      playlists: [],        // {id,name,description,coverAuto,trackIds,tracks,isPublic,createdAt}
      followedArtists: {},  // id -> artist
      savedAlbums: {},      // id -> album
      history: [],          // recent tracks (dedup, max 100)
      downloads: {},        // id -> true

      toggleLike: (track) => set(s => {
        const liked = { ...s.liked };
        if (liked[track.id]) delete liked[track.id]; else liked[track.id] = track;
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
      pushHistory: (track) => {
        if (!track) return;
        set(s => ({ history: [track, ...s.history.filter(t => t.id !== track.id)].slice(0, 100) }));
      },
      clearHistory: () => set({ history: [] }),
      toggleDownload: (track) => {
        const s = get();
        const dl = { ...s.downloads };
        const url = track.streamUrl || track.previewUrl;
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
      quality: 'high',
      crossfade: 0,
      eq: { bass: 0, mid: 0, treble: 0 },
      profile: { name: 'Guest Listener', email: '' },
      searchHistory: [],
      setTheme: (theme) => set({ theme }),
      setQuality: (quality) => set({ quality }),
      setCrossfade: (v) => set({ crossfade: v }),
      setEq: (eq) => set({ eq }),
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
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        liked: s.liked, playlists: s.playlists, followedArtists: s.followedArtists,
        savedAlbums: s.savedAlbums, history: s.history, downloads: s.downloads,
        theme: s.theme, quality: s.quality, crossfade: s.crossfade, eq: s.eq,
        profile: s.profile, searchHistory: s.searchHistory, volume: s.volume,
        formatPref: s.formatPref,
      }),
    }
  )
);
