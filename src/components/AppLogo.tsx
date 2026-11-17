import { useId } from "react";

/** The app icon (a page with a highlighted line and a big note in the margin), drawn as SVG: the same artwork as src-tauri/icons/app-icon.svg. */
export function AppLogo({ className = "brand-mark" }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="20 20 984 984" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id={`${id}bg`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f1e7d2" />
            <stop offset="1" stopColor="#e2d4b8" />
          </linearGradient>
          <linearGradient id={`${id}pp`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fffdf8" />
            <stop offset="1" stopColor="#f6efe0" />
          </linearGradient>
          <filter id={`${id}sh`} x="-10%" y="-10%" width="125%" height="125%">
            <feDropShadow dx="0" dy="12" stdDeviation="14" floodColor="#4a3826" floodOpacity="0.3" />
          </filter>
        </defs>
        <rect x="20" y="20" width="984" height="984" rx="210" fill={`url(#${id}bg)`} />
        <rect x="96" y="84" width="580" height="856" rx="34" fill={`url(#${id}pp)`} filter={`url(#${id}sh)`} />
        <g fill="#cbbfa8">
          <rect x="156" y="170" width="440" height="34" rx="17" />
          <rect x="156" y="260" width="400" height="34" rx="17" />
          <rect x="156" y="450" width="430" height="34" rx="17" />
          <rect x="156" y="540" width="340" height="34" rx="17" />
          <rect x="156" y="630" width="410" height="34" rx="17" />
          <rect x="156" y="720" width="300" height="34" rx="17" />
          <rect x="156" y="810" width="380" height="34" rx="17" />
        </g>
        <rect x="136" y="338" width="480" height="76" rx="18" fill="#f2c94c" />
        <rect x="156" y="358" width="440" height="36" rx="18" fill="#b58a2a" opacity="0.55" />
        <path d="M606 376 C 662 376, 676 440, 726 440" fill="none" stroke="#e8b92f" strokeWidth="16" strokeLinecap="round" />
        <g filter={`url(#${id}sh)`}>
          <rect x="686" y="290" width="298" height="400" rx="40" fill="#f2c94c" />
        </g>
        <g fill="#3a3029" opacity="0.6">
          <rect x="740" y="370" width="190" height="28" rx="14" />
          <rect x="740" y="446" width="150" height="28" rx="14" />
          <rect x="740" y="522" width="176" height="28" rx="14" />
          <rect x="740" y="598" width="120" height="28" rx="14" />
        </g>
      </svg>
    </span>
  );
}
