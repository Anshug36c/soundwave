import { EQ_LABELS, getPresets, setBandGain, setAllGains, setPreamp, setNormalize, setEqEnabled as eqWire } from '../audio/studio';
import { useStore } from '../store/useStore';

/** 10-band graphic equalizer + Studio sound controls (Monochrome-inspired). */
export default function Equalizer() {
  const studioOn = useStore(s => s.studioOn);
  const setStudioOn = useStore(s => s.setStudioOn);
  const eqEnabled = useStore(s => s.eqEnabled);
  const setEqEnabled = useStore(s => s.setEqEnabled);
  const eqGains = useStore(s => s.eqGains);
  const setEqGain = useStore(s => s.setEqGain);
  const eqPreset = useStore(s => s.eqPreset);
  const setEqPreset = useStore(s => s.setEqPreset);
  const eqPreamp = useStore(s => s.eqPreamp);
  const setEqPreamp = useStore(s => s.setEqPreamp);
  const normalizeOn = useStore(s => s.normalizeOn);
  const setNormalizeOn = useStore(s => s.setNormalizeOn);
  const toast = useStore(s => s.toast);
  const presets = getPresets();

  const live = (fn) => { try { fn(); } catch { /* graph not built yet — engine syncs on enable */ } };

  return (
    <div className="flex flex-col gap-4">
      <div className="p-3 rounded-xl bg-white/5 border border-soft flex items-center justify-between gap-3 flex-wrap">
        <div>
          <p className="font-extrabold text-sm">🎚️ Studio sound</p>
          <p className="text-xs text-dim">Routes audio through the server for EQ + visualizer. Uses more data.</p>
        </div>
        <button onClick={() => { setStudioOn(!studioOn); toast(studioOn ? 'Studio sound off' : 'Studio sound on 🎚️'); }}
          className={`px-5 py-1.5 rounded-full text-sm font-bold ${studioOn ? 'bg-accent text-black' : 'bg-white/10'}`}>
          {studioOn ? 'ON' : 'OFF'}
        </button>
      </div>

      {!studioOn && <p className="text-xs text-dim text-center">Turn on Studio sound to hear the equalizer. Your settings are saved.</p>}

      <div className={studioOn ? '' : 'opacity-50 pointer-events-none'}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-bold tracking-widest text-dim">PRESETS</p>
          <div className="flex gap-2">
            <button onClick={() => { const g = presets.flat.gains; setEqPreset('flat', g); live(() => setAllGains(g)); }}
              className="text-xs font-bold px-3 py-1 rounded-full bg-white/10">Reset</button>
            <button onClick={() => { setEqEnabled(!eqEnabled); live(() => eqWire(!eqEnabled)); }}
              className={`text-xs font-bold px-3 py-1 rounded-full ${eqEnabled ? 'bg-accent text-black' : 'bg-white/10'}`}>
              EQ {eqEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
          {Object.entries(presets).map(([key, p]) => (
            <button key={key} onClick={() => { setEqPreset(key, p.gains); live(() => setAllGains(p.gains)); }}
              className={`shrink-0 px-3 py-1.5 rounded-full text-xs font-bold ${eqPreset === key ? 'bg-accent text-black' : 'bg-white/10'}`}>
              {p.name}
            </button>
          ))}
        </div>

        <div className={`flex justify-between mt-4 px-1 ${eqEnabled ? '' : 'opacity-40 pointer-events-none'}`}>
          {EQ_LABELS.map((label, i) => (
            <label key={label} className="flex flex-col items-center gap-1" title={`${label} Hz: ${eqGains[i]} dB`}>
              <span className="text-[10px] font-bold text-dim w-8 text-center">{eqGains[i] > 0 ? `+${eqGains[i]}` : eqGains[i]}</span>
              <input type="range" min={-12} max={12} step={0.5} value={eqGains[i]}
                onChange={(e) => { const v = Number(e.target.value); setEqGain(i, v); live(() => setBandGain(i, v)); }}
                className="eq-slider" aria-label={`${label} Hz band`} />
              <span className="text-[10px] font-bold">{label}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-3 mt-4 slider-wrap">
          <span className="text-xs font-bold w-14">Preamp</span>
          <input type="range" min={-12} max={12} step={0.5} value={eqPreamp}
            onChange={(e) => { const v = Number(e.target.value); setEqPreamp(v); live(() => setPreamp(v)); }}
            className="slider flex-1" aria-label="Preamp" />
          <span className="text-xs font-bold w-12 text-right">{eqPreamp > 0 ? `+${eqPreamp}` : eqPreamp} dB</span>
        </div>

        <div className="flex items-center justify-between mt-3 p-3 rounded-xl bg-white/5 border border-soft">
          <div>
            <p className="font-bold text-sm">Normalize volume</p>
            <p className="text-xs text-dim">Gentle compression so quiet & loud songs match</p>
          </div>
          <button onClick={() => { setNormalizeOn(!normalizeOn); live(() => setNormalize(!normalizeOn)); }}
            className={`px-5 py-1.5 rounded-full text-sm font-bold ${normalizeOn ? 'bg-accent text-black' : 'bg-white/10'}`}>
            {normalizeOn ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>
    </div>
  );
}
