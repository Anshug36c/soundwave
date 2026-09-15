// Spotify-style inline SVG icon set (currentColor, no emoji in chrome).
function S({ size = 20, className = '', children, filled = false, sw = 2 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'} strokeWidth={filled ? 0 : sw}
      strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{children}</svg>
  );
}

export const HomeIcon = ({ active, ...p }) => active ? (
  <S {...p} filled><path d="M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z" /></S>
) : (
  <S {...p}><path d="M4 11l8-7 8 7" /><path d="M6 9.5V20h12V9.5" /></S>
);
export const SearchIcon = ({ active, ...p }) => (
  <S {...p} sw={active ? 2.6 : 2}><circle cx="11" cy="11" r="7" /><path d="M16.5 16.5L21 21" /></S>
);
export const LibraryIcon = ({ active, ...p }) => active ? (
  <S {...p} filled><path d="M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v16h-4z" /></S>
) : (
  <S {...p}><path d="M6 4v16M12 4v10M18 4v16" /></S>
);
export const PlusIcon = (p) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
export const HeartIcon = ({ filled, ...p }) => (
  <S {...p} filled={!!filled}><path d="M12 20.5C7 16.5 3 13.3 3 9.3 3 6.4 5.2 4.5 7.7 4.5c1.7 0 3.3.9 4.3 2.4 1-1.5 2.6-2.4 4.3-2.4 2.5 0 4.7 1.9 4.7 4.8 0 4-4 7.2-9 11.2z" /></S>
);
export const PlayIcon = (p) => <S {...p} filled><path d="M8 5.5v13l11-6.5z" /></S>;
export const PauseIcon = (p) => <S {...p} filled><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></S>;
export const NextIcon = (p) => <S {...p} filled><path d="M5 5.5v13l8.5-6.5z" /><rect x="16" y="5" width="3" height="14" rx="1" /></S>;
export const PrevIcon = (p) => <S {...p} filled><path d="M19 5.5v13L10.5 12z" /><rect x="5" y="5" width="3" height="14" rx="1" /></S>;
export const ShuffleIcon = (p) => (
  <S {...p}><path d="M3 7h4l10 10h4m0 0-3-3m3 3-3 3" /><path d="M3 17h4l2.5-2.5M13.5 9.5L17 7h4m0 0-3-3m3 3-3 3" /></S>
);
export const RepeatIcon = (p) => (
  <S {...p}><path d="M4 8h12l-3-3M20 16H8l3 3" /></S>
);
export const RepeatOneIcon = (p) => (
  <S {...p}><path d="M4 8h12l-3-3M20 16H8l3 3" /><text x="12" y="15.5" textAnchor="middle" fontSize="8" fontWeight="800" fill="currentColor" stroke="none">1</text></S>
);
export const VolumeIcon = (p) => (
  <S {...p}><path d="M4 10v4h4l5 4V6l-5 4H4z" /><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11" /></S>
);
export const MuteIcon = (p) => (
  <S {...p}><path d="M4 10v4h4l5 4V6l-5 4H4z" /><path d="M16 10l5 5m0-5l-5 5" /></S>
);
export const QueueIcon = (p) => (
  <S {...p}><path d="M4 6h12M4 11h12M4 16h7" /><path d="M15 15.5v5l4.5-2.5z" /></S>
);
export const MicIcon = (p) => (
  <S {...p}><rect x="9" y="3" width="6" height="10" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></S>
);
export const CloseIcon = (p) => <S {...p}><path d="M6 6l12 12M18 6L6 18" /></S>;
export const CheckIcon = (p) => <S {...p} sw={2.6}><path d="M5 12.5l4.5 4.5L19 7.5" /></S>;
export const ChevronDownIcon = (p) => <S {...p} sw={2.4}><path d="M6 9l6 6 6-6" /></S>;
export const ChevronLeftIcon = (p) => <S {...p} sw={2.4}><path d="M15 6l-6 6 6 6" /></S>;
export const ChevronRightIcon = (p) => <S {...p} sw={2.4}><path d="M9 6l6 6-6 6" /></S>;
export const ExpandIcon = (p) => <S {...p}><path d="M9 4H4v5M15 4h5v5M9 20H4v-5M15 20h5v-5" /></S>;
export const MoonIcon = (p) => <S {...p}><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" /></S>;
export const DownloadIcon = (p) => <S {...p}><path d="M12 4v11m0 0l-4-4m4 4l4-4" /><path d="M5 20h14" /></S>;
export const ShareIcon = (p) => <S {...p}><path d="M12 15V4m0 0L8 8m4-4l4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" /></S>;
export const NoteIcon = (p) => (
  <S {...p}><circle cx="7" cy="18" r="2.6" /><circle cx="17" cy="15" r="2.6" /><path d="M9.6 18V6l10-2v11" /></S>
);
export const DotsIcon = (p) => (
  <S {...p} filled><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></S>
);
export const SunIcon = (p) => <S {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4l1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></S>;
export const GhostIcon = ({ size = 20, className = '' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
    <path d="M12 2C7.2 2 3.5 5.8 3.5 10.6v7.9l2.4-1.9 2 1.9 2.5-1.9 2 1.9 2.5-1.9 2 1.9 2.4-1.9v-7.9C20.5 5.8 16.8 2 12 2z" />
  </svg>
);
export const ClockIcon = (p) => <S {...p}><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></S>;
export const HideIcon = ({ active, ...p }) => (
  <S {...p}><circle cx="12" cy="12" r="8.5" /><path d="M8.5 12h7" /></S>
);
export const BoltIcon = (p) => <S {...p} filled><path d="M13 2L5 13.5h5L10 22l8-11.5h-5z" /></S>;
export const SlidersIcon = (p) => <S {...p}><path d="M4 7h10m4 0h2M4 17h4m4 0h8" /><circle cx="16" cy="7" r="2.2" /><circle cx="10" cy="17" r="2.2" /></S>;
export const DiscIcon = (p) => <S {...p}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="2.5" /></S>;
export const PencilIcon = (p) => <S {...p}><path d="M4 20l1-4L16.5 4.5a2.1 2.1 0 0 1 3 3L8 19l-4 1z" /></S>;
export const GearIcon = (p) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4L9.7 5.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5A7 7 0 0 0 5.3 12c0 .4 0 .8.1 1.2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z" /></S>;
export const ChartIcon = (p) => <S {...p}><path d="M4 20V4" /><path d="M4 20h16" /><path d="M8 15l3-4 3 2 4-6" /></S>;
