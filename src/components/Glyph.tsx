import { siEpicgames, siGogdotcom, siSteam, siUbisoft } from "simple-icons";
import type { Source } from "../types";

export type Button = "a" | "b" | "x" | "y" | "lb" | "rb" | "lt" | "rt" | "menu" | "view" | "dpad" | "stick";

/** Controller face buttons in the dark-cap, coloured-letter style of modern pads. */
export function Glyph({ b, size = 1 }: { b: Button; size?: number }) {
  const style = { "--g": size } as React.CSSProperties;
  if (b === "a" || b === "b" || b === "x" || b === "y") {
    return (
      <span className={`glyph face ${b}`} style={style}>
        {b.toUpperCase()}
      </span>
    );
  }
  if (b === "lb" || b === "rb") {
    return <span className="glyph bumper" style={style}>{b.toUpperCase()}</span>;
  }
  if (b === "lt" || b === "rt") {
    return <span className={`glyph trigger ${b}`} style={style}>{b.toUpperCase()}</span>;
  }
  const icon = {
    menu: <path d="M5 7h14M5 12h14M5 17h14" />,
    view: <><rect x="4" y="5" width="11" height="9" rx="1.5" /><rect x="9" y="10" width="11" height="9" rx="1.5" /></>,
    dpad: <path d="M9.5 3h5v6.5H21v5h-6.5V21h-5v-6.5H3v-5h6.5z" />,
    stick: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="3.5" /></>,
  }[b];
  return (
    <span className="glyph round" style={style}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {icon}
      </svg>
    </span>
  );
}

const BRAND: Partial<Record<Source, { path: string }>> = {
  steam: siSteam,
  epic: siEpicgames,
  gog: siGogdotcom,
  ubisoft: siUbisoft,
};

export function SourceIcon({ source }: { source: Source }) {
  const brand = BRAND[source];
  return (
    <svg className="source-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      {brand ? (
        <path d={brand.path} />
      ) : source === "xbox" ? (
        // A generic pad: Microsoft's mark isn't in the icon set.
        <path d="M7 7h10a5 5 0 0 1 4.9 6l-.8 4a2.5 2.5 0 0 1-4.3 1.1L14.6 16H9.4l-2.2 2.1A2.5 2.5 0 0 1 2.9 17l-.8-4A5 5 0 0 1 7 7Zm.5 3v1.5H6v1h1.5V14h1v-1.5H10v-1H8.5V10h-1Zm8.75.25a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Zm-1.9 1.9a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8Z" />
      ) : (
        <path d="M12 2.5l2.6 6.1 6.6.6-5 4.4 1.5 6.5L12 16.7l-5.7 3.4 1.5-6.5-5-4.4 6.6-.6z" />
      )}
    </svg>
  );
}
