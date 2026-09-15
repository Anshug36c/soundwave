import { useEffect, useRef } from 'react';
import { getAnalyser } from '../audio/studio';
import { useStore } from '../store/useStore';

/** Live frequency-bars visualizer fed by the Studio analyser node. */
export default function Visualizer({ height = 64, bars = 48 }) {
  const ref = useRef(null);
  const studioOn = useStore(s => s.studioOn);
  const isPlaying = useStore(s => s.isPlaying);
  const theme = useStore(s => s.theme);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext('2d');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1db954';
    const data = new Uint8Array(512);
    let raf = 0, t = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      t += 0.05;
      const W = canvas.width, H = canvas.height;
      g.clearRect(0, 0, W, H);
      const an = studioOn ? getAnalyser() : null;
      const bw = W / bars;
      g.fillStyle = accent;
      if (an && isPlaying) {
        an.getByteFrequencyData(data);
        for (let i = 0; i < bars; i++) {
          const v = data[Math.floor((i / bars) * data.length * 0.72)] / 255;
          const h = Math.max(3, v * H);
          const x = i * bw + bw * 0.2, w = bw * 0.6;
          g.beginPath();
          g.roundRect(x, H - h, w, h, w / 2);
          g.fill();
        }
      } else {
        // idle wave while paused / studio off
        for (let i = 0; i < bars; i++) {
          const h = 3 + Math.sin(t + i * 0.35) * 2 + 2;
          const x = i * bw + bw * 0.2, w = bw * 0.6;
          g.globalAlpha = 0.35;
          g.beginPath();
          g.roundRect(x, H - h, w, h, w / 2);
          g.fill();
          g.globalAlpha = 1;
        }
      }
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [studioOn, isPlaying, theme, bars]);

  return <canvas ref={ref} width={640} height={height} className="w-full" style={{ height }} aria-hidden="true" />;
}
