import { useStore } from '../store/useStore';
import { SongRow } from './Cards';

// Similar songs for the current track (fetched + pre-cached by the audio engine).
// Renders inside the queue drawer; tap plays the whole similar list as a queue.
export function SimilarSongs() {
  const similar = useStore(s => s.similar);
  const queue = useStore(s => s.queue);
  const index = useStore(s => s.index);
  const track = index >= 0 ? queue[index] : null;
  if (!similar?.length) return null;
  return (
    <div className="mt-4">
      <h3 className="text-sm font-extrabold px-1 mb-1">
        Similar songs{track ? <span className="font-normal text-dim"> — because you played {track.title}</span> : null}
      </h3>
      <div className="flex flex-col gap-1">
        {similar.map((t, i) => (
          <SongRow key={`${t.id}-${i}`} track={t} index={i} context={similar} showIndex={false} />
        ))}
      </div>
    </div>
  );
}
