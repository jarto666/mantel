import { siEpicgames, siGogdotcom, siSteam, siUbisoft } from "simple-icons";
import { useInputDevice } from "../input";
import type { Source } from "../types";

/** Goes in a stroked 24-unit svg. */
export const DOWNLOAD = <path d="M12 3.5v12M6.75 10.25 12 15.5l5.25-5.25M4.5 20.5h15" />;

export type Button = "a" | "b" | "x" | "y" | "lb" | "rb" | "lt" | "rt" | "menu" | "view" | "dpad" | "stick";

/** The keyboard's stand-in for each button (input.ts maps them). */
const KEY_CAP: Record<Button, string> = {
  a: "Enter", b: "Esc", x: "F", y: "I", lb: "Q", rb: "E", lt: "PgUp", rt: "PgDn",
  menu: "Tab", view: "/", dpad: "←↑↓→", stick: "←↑↓→",
};

/** Controller face buttons in the dark-cap, coloured-letter style of modern pads; key caps
 *  instead while the player is on a keyboard. */
export function Glyph({ b, size = 1 }: { b: Button; size?: number }) {
  const style = { "--g": size } as React.CSSProperties;
  if (useInputDevice() === "keys") {
    return <span className={`glyph key ${b}`} style={style}>{KEY_CAP[b]}</span>;
  }
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
        // Not in the icon set, which dropped Microsoft's marks.
        <path d="M4.102 21.033C6.211 22.881 8.977 24 12 24c3.026 0 5.789-1.119 7.902-2.967 1.877-1.912-4.316-8.709-7.902-11.417-3.582 2.708-9.779 9.505-7.898 11.417zm11.16-14.406c2.5 2.961 7.484 10.313 6.076 12.912C23.002 17.48 24 14.861 24 12.004c0-3.34-1.365-6.362-3.57-8.536 0 0-.027-.022-.082-.042-.063-.022-.152-.045-.281-.045-.592 0-1.985.434-4.805 3.246zM3.654 3.426c-.057.02-.082.041-.086.042C1.365 5.642 0 8.664 0 12.004c0 2.854.998 5.473 2.661 7.533-1.401-2.605 3.579-9.951 6.08-12.91-2.82-2.813-4.216-3.245-4.806-3.245-.131 0-.223.021-.281.046v-.002zM12 3.551S9.055 1.828 6.755 1.746c-.903-.033-1.454.295-1.521.339C7.379.646 9.659 0 11.984 0H12c2.334 0 4.605.646 6.766 2.085-.068-.046-.615-.372-1.52-.339C14.946 1.828 12 3.545 12 3.545v.006z" />
      ) : (
        <path d="M12 2.5l2.6 6.1 6.6.6-5 4.4 1.5 6.5L12 16.7l-5.7 3.4 1.5-6.5-5-4.4 6.6-.6z" />
      )}
    </svg>
  );
}
