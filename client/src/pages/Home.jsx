import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api, debounce, formatTime, tasteFiltered } from '../services/musicApi';
import {
  trackKeyOf, tasteSeeds, forgottenFavorites, newSeed, dailySeed,
} from '../services/taste';
import { useStore } from '../store/useStore';
import { SongCard, SectionRow, SkeletonList, Img } from '../components/Cards';
import { RefreshIcon } from '../components/Icons';

// Memoized: the list re-renders only when its own track/playing-state changes,
// not on every unrelated store update (e.g. clock ticks elsewhere).
const RecRow = memo(function RecRow({ track, context }) {
  const playTrack = useStore(s => s.playTrack);
  const queue = useStore(s => s.queue);
  const idx = useStore(s => s.index);
  const isCurrent = queue[idx]?.id === track.id;
  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded-lg ${isCurrent ? 'bg-accent/10' : 'bg-hoverable'}`}>
      <button onClick={() => playTrack(track, context)} className="relative shrink-0" aria-label={`Play ${track.title}`}>
        <Img src={track.image} alt="" className="w-11 h-11 rounded-md object-cover" />
      </button>
      <button onClick={() => playTrack(track, context)} className="flex-1 min-w-0 text-left">
        <p className="truncate text-sm font-semibold">{track.title}</p>
        <p className="truncate text-xs text-dim">{track.artist?.name}</p>
        {track.reason && <p className="truncate text-[11px] text-green-500 font-semibold">{track.reason}</p>}
      </button>
      <span className="text-xs text-dim w-10 text-right">{formatTime(track.duration)}</span>
    </div>
  );
});

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const history = useStore(s => s.history);
  const playStats = useStore(s => s.playStats);
  const liked = useStore(s => s.liked);
  const discoverMix = useStore(s => s.discoverMix);
  const setDiscoverMix = useStore(s => s.setDiscoverMix);
  const disliked = useStore(s => s.disliked);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  const tasteMix = useStore(s => s.tasteMix);
  const syncTasteMix = useStore(s => s.syncTasteMix);
  const refreshTasteMix = useStore(s => s.refreshTasteMix);
  const [recs, setRecs] = useState([]);
  const [recsLoading, setRecsLoading] = useState(true);
  const [recsError, setRecsError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const reqId = useRef(0);

  // Echo v1.4.2 Local Taste Engine: the mix is seeded by the tracks that score
  // best over the last 30 days — log-normalised listening time, minus skips,
  // plus like/recency bonuses and a time-of-day multiplier — rather than by
  // whichever three songs happened to play last.
  const likedKeys = useMemo(
    () => new Set(Object.values(liked).map(t => trackKeyOf(t.title, t.artist?.name))),
    [liked],
  );
  const seeds = useMemo(() => {
    const blocked = new Set(Object.keys(disliked).map(id => playStats[id]?.trackKey).filter(Boolean));
    const ranked = tasteSeeds(Object.values(playStats), { likedKeys, excluded: blocked, count: 3 });
    if (ranked.length) return ranked.map(r => ({ t: r.stats.title, a: r.stats.artist || '' }));
    // No measured listening yet (fresh install, or history from before play
    // stats existed): fall back to the last three distinct plays.
    const seen = new Set(), out = [];
    for (const t of history) {
      if (!t?.title || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ t: t.title, a: t.artist?.name || '' });
      if (out.length >= 3) break;
    }
    return out;
  }, [playStats, likedKeys, disliked, history]);
  const topArtists = useMemo(() => {
    // Minutes listened, with skips counting against the artist (Echo's weights).
    const minutes = {};
    for (const st of Object.values(playStats)) {
      const n = st.artist;
      if (!n || n === 'Unknown') continue;
      minutes[n] = (minutes[n] || 0) + (st.totalPlayTimeMs || 0) / 60000 - (st.skipCount || 0) * 3;
    }
    if (Object.keys(minutes).length) {
      return Object.entries(minutes).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
    }
    const c = {};
    for (const t of history) { const n = t.artist?.name; if (n && n !== 'Unknown') c[n] = (c[n] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
  }, [playStats, history]);
  // Recently played, de-duplicated so repeats don't fill the rail.
  const recent = useMemo(() => {
    const seen = new Set(), out = [];
    for (const t of history) {
      if (!t?.id || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
      if (out.length >= 12) break;
    }
    return out;
  }, [history]);

  // Daily Taste Mix (Echo v1.4.2): one seed per calendar day, so the mix
  // refreshes itself every 24 h instead of being rebuilt — and duplicated — on
  // every visit. The manual refresh rolls a fresh per-invocation seed, which is
  // what makes the picks differ between refreshes (#559).
  useEffect(() => { try { syncTasteMix(); } catch { /* noop */ } }, [syncTasteMix]);
  const mixSeed = tasteMix?.seed || dailySeed();
  const excludeKeys = useStore(s => s.excludeKeys);

  const fetchRecs = useMemo(() => debounce((mix, sd, arts, seed, excl, id) => {
    setRecsLoading(true);
    setRecsError(false);
    api.forYou(mix, sd, arts, 15, { seed, exclude: excl })
      .then(r => { if (reqId.current === id) setRecs(r.songs || []); })
      .catch(() => { if (reqId.current === id) { setRecs([]); setRecsError(true); } })
      .finally(() => { if (reqId.current === id) setRecsLoading(false); });
  }, 500), []);
  useEffect(() => {
    const id = ++reqId.current;
    let excl = [];
    try { excl = excludeKeys(); } catch { /* no exclusions */ }
    fetchRecs(discoverMix, seeds, topArtists, mixSeed, excl, id);
    return () => { reqId.current++; }; // stale responses can't overwrite newer ones
  // stable by design: new songs must NOT reshuffle the list — the user refreshes manually
  }, [fetchRecs, discoverMix, retryTick, mixSeed]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleRecs = tasteFiltered(recs, disliked, hiddenArtists);

  // Forgotten Favourites (Echo home rail): tracks that were genuinely listened
  // to and then went quiet. Ordering uses one seed per invocation, so a refresh
  // varies but a single render pass can never reshuffle under the reader — the
  // exact bug Echo v1.4.3 fixed by replacing SQL `RANDOM()` with a bound seed.
  const [ffSeed, setFfSeed] = useState(() => newSeed());
  const forgotten = useMemo(() => {
    const entries = Object.entries(playStats).map(([id, st]) => ({ id, ...st, liked: !!liked[id] }));
    for (const [id, t] of Object.entries(liked)) {
      if (!playStats[id]) entries.push({ id, liked: true, totalPlayTimeMs: 0, skipCount: 0, lastPlayedAtMillis: t?._likedAt || 0, track: t });
    }
    const byId = (id) => playStats[id]?.track || liked[id] || history.find(h => h?.id === id) || null;
    return forgottenFavorites(entries, { seed: ffSeed, quietDays: 14, limit: 12 })
      .map(e => e.track || byId(e.id))
      .filter(Boolean);
  }, [playStats, liked, history, ffSeed]);
  const visibleForgotten = tasteFiltered(forgotten, disliked, hiddenArtists);

  return (
    <div className="pb-8">
      {/* Apple Music leads with a large display greeting and a quiet context
          line, rather than a small bold label. */}
      <header className="px-1 pt-2 pb-6 fade-up">
        <h1 className="h-display">{greeting()}</h1>
        <p className="t-caption mt-1.5">
          {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
        </p>
      </header>


        {history.length === 0 ? (
          <div className="panel p-10 mt-2 text-center fade-up-1">
            <p className="h-sub">Find your first song</p>
            <p className="t-body text-dim mt-2 max-w-sm mx-auto">Search above — your recent plays and recommendations will live here.</p>
          </div>
        ) : (
        <SectionRow title="Recently Played" subtitle="Jump back in">
          {recent.map(t => <SongCard key={t.id} track={t} context={recent} />)}
        </SectionRow>
      )}

      {visibleForgotten.length > 0 && (
        // Same rail markup as SectionRow, with a refresh button in its header:
        // one seed per press, never one per render (Echo v1.4.3).
        <section className="mt-8 first:mt-4" aria-label="Forgotten favourites">
          <div className="flex items-end justify-between mb-3 px-1 gap-4">
            <div className="min-w-0">
              <h2 className="h-section truncate">Forgotten Favourites</h2>
              <p className="t-caption mt-0.5 truncate">Quiet for a fortnight · still in your library</p>
            </div>
            <button onClick={() => setFfSeed(newSeed())} aria-label="Show a different set of forgotten favourites" title="Show a different set"
              className="p-2 rounded-full bg-white/10 text-dim hover:text-white shrink-0">
              <RefreshIcon size={14} />
            </button>
          </div>
          <div className="flex gap-4 overflow-x-auto no-scrollbar snap-x fade-r pb-2 px-1 [&>*]:snap-start">
            {visibleForgotten.slice(0, 10).map(t => <SongCard key={t.id} track={t} context={visibleForgotten} />)}
          </div>
        </section>
      )}

      {/* Daily Taste Mix — recommendations from measured listening */}
      <section className="mt-7" aria-label="Taste mix">
        <div className="flex items-center justify-between px-1 mb-1 flex-wrap gap-2">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">Taste Mix</h2>
            <p className="text-xs text-dim font-semibold">
              Refreshes every 24h{seeds[0] ? ` · from your plays, skips and likes · top seed: ${seeds[0].t}` : ''}
            </p>
          </div>
          <button onClick={() => refreshTasteMix()} disabled={recsLoading} aria-label="Refresh taste mix" title="Refresh taste mix"
            className="p-2 rounded-full bg-white/10 text-dim hover:text-white disabled:opacity-40">
            <RefreshIcon size={14} className={recsLoading ? 'animate-spin' : ''} />
          </button>
          <label className="flex items-center gap-2 text-[11px] font-bold text-dim">Familiar
            <input type="range" min="0" max="100" value={discoverMix} onChange={e => setDiscoverMix(+e.target.value)}
              className="w-28 sm:w-32 accent-green-500" aria-label="Discovery mix" />Adventurous</label>
        </div>
        <div className="card p-2 flex flex-col">
          {recsLoading && <SkeletonList count={4} />}
          {!recsLoading && recsError && (
            <div className="p-4 text-sm">
              <p className="font-bold">Couldn't load recommendations</p>
              <button onClick={() => setRetryTick(t => t + 1)} className="mt-2 px-4 py-1.5 rounded-full text-xs font-bold bg-white/10">Retry</button>
            </div>
          )}
          {!recsLoading && !recsError && visibleRecs.slice(0, 8).map((t, i) => <RecRow key={`${t.id}-${i}`} track={t} context={visibleRecs} />)}
          {!recsLoading && !recsError && !visibleRecs.length && (
            <p className="p-4 text-sm text-dim">Play a few songs and this mix will tune itself to you — it weighs what you finish, what you skip, and what you like.</p>
          )}
        </div>
      </section>
    </div>
  );
}
