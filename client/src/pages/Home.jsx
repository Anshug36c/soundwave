import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { api, debounce, formatTime, tasteFiltered } from '../services/musicApi';
import { useStore } from '../store/useStore';
import { SongCard, SectionRow, SkeletonList, Img } from '../components/Cards';

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
  const discoverMix = useStore(s => s.discoverMix);
  const setDiscoverMix = useStore(s => s.setDiscoverMix);
  const disliked = useStore(s => s.disliked);
  const hiddenArtists = useStore(s => s.hiddenArtists);
  const [recs, setRecs] = useState([]);
  const [recsLoading, setRecsLoading] = useState(true);
  const [recsError, setRecsError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const reqId = useRef(0);

  // Seeds: last 3 distinct played songs drive the recommendations.
  const seeds = useMemo(() => {
    const seen = new Set(), out = [];
    for (const t of history) {
      if (!t?.title || seen.has(t.id)) continue;
      seen.add(t.id);
      out.push({ t: t.title, a: t.artist?.name || '' });
      if (out.length >= 3) break;
    }
    return out;
  }, [history]);
  const topArtists = useMemo(() => {
    const c = {};
    for (const t of history) { const n = t.artist?.name; if (n && n !== 'Unknown') c[n] = (c[n] || 0) + 1; }
    return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n]) => n);
  }, [history]);
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
  const seedsKey = seeds.map(s => s.t).join('|');
  const artistsKey = topArtists.join('|');

  const fetchRecs = useMemo(() => debounce((mix, sd, arts, id) => {
    setRecsLoading(true);
    setRecsError(false);
    api.forYou(mix, sd, arts)
      .then(r => { if (reqId.current === id) setRecs(r.songs || []); })
      .catch(() => { if (reqId.current === id) { setRecs([]); setRecsError(true); } })
      .finally(() => { if (reqId.current === id) setRecsLoading(false); });
  }, 500), []);
  useEffect(() => {
    const id = ++reqId.current;
    fetchRecs(discoverMix, seeds, topArtists, id);
    return () => { reqId.current++; }; // stale responses can't overwrite newer ones
  }, [fetchRecs, discoverMix, seedsKey, artistsKey, retryTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const visibleRecs = tasteFiltered(recs, disliked, hiddenArtists);

  return (
    <div className="pb-8">
      <h1 className="text-2xl font-extrabold tracking-tight mb-4 px-1">{greeting()}</h1>


      {history.length === 0 ? (
        <div className="card p-6 mt-6 text-center">
          <p className="font-extrabold">Find your first song</p>
          <p className="text-sm text-dim mt-1">Search above — your recent plays and recommendations will live here.</p>
        </div>
      ) : (
        <SectionRow title="Recently Played" subtitle="Jump back in">
          {recent.map(t => <SongCard key={t.id} track={t} context={recent} />)}
        </SectionRow>
      )}

      {/* Recommendations based on last played */}
      <section className="mt-7" aria-label="Recommended">
        <div className="flex items-center justify-between px-1 mb-1 flex-wrap gap-2">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">Recommended</h2>
            <p className="text-xs text-dim font-semibold">
              Based on your recent plays{seeds[0] ? ` · latest: ${seeds[0].t}` : ''}
            </p>
          </div>
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
            <p className="p-4 text-sm text-dim">Play a few songs and this mix will tune itself to you.</p>
          )}
        </div>
      </section>
    </div>
  );
}
