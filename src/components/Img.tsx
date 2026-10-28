import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, toSrc } from "../api";
import { logoViewBox } from "../util";

const reported = new Set<string>();

interface Attempt {
  key: string;
  index: number;
  loaded: boolean;
  viewBox: string | null;
}

/**
 * Tries each candidate in order; renders `fallback` once all of them fail.
 *
 * `lazy` uses our own IntersectionObserver rather than `loading="lazy"`: WebView2 swaps
 * native lazy images for placeholders and defers their load events, which left covers
 * (revealed on load) invisible.
 */
export function Img({
  srcs,
  className,
  fallback = null,
  lazy = false,
  trim = false,
  onLoad,
}: {
  srcs: string[];
  className?: string;
  fallback?: ReactNode;
  lazy?: boolean;
  /** Crop transparent margins (store logos). */
  trim?: boolean;
  onLoad?: (src: string) => void;
}) {
  const key = srcs.join("|");
  const [attempt, setAttempt] = useState<Attempt>({ key, index: 0, loaded: false, viewBox: null });
  // Reset synchronously when the candidates change, so a stale "loaded" never leaks across.
  const cur = attempt.key === key ? attempt : { key, index: 0, loaded: false, viewBox: null };
  if (cur !== attempt) setAttempt(cur);
  const update = (patch: Partial<Attempt>) => setAttempt((a) => (a.key === key ? { ...a, ...patch } : a));

  const [visible, setVisible] = useState(!lazy);
  const holder = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (visible || !holder.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), {
      rootMargin: "1200px",
    });
    io.observe(holder.current);
    return () => io.disconnect();
  }, [visible]);

  if (!visible) return <span ref={holder} className={className} style={{ display: "block" }} />;

  if (cur.index >= srcs.length) {
    // Every candidate failed: worth knowing about on a device we can't look at.
    if (srcs.length && !reported.has(key)) {
      reported.add(key);
      api.log("warn", `art failed (${className ?? "img"}): ${srcs.map(toSrc).join(" | ")}`);
    }
    return <>{fallback}</>;
  }
  const src = toSrc(srcs[cur.index]);
  return (
    <img
      key={src}
      src={src}
      className={`${className ?? ""} ${cur.loaded ? "is-loaded" : ""}`}
      decoding="async"
      draggable={false}
      alt=""
      style={cur.viewBox ? ({ objectViewBox: cur.viewBox } as React.CSSProperties) : undefined}
      onLoad={(e) => {
        // Steam answers some missing art with a 1×1 placeholder.
        if (e.currentTarget.naturalWidth < 8) return update({ index: cur.index + 1 });
        if (trim) {
          // Reveal only once cropped, so the logo doesn't jump in size.
          logoViewBox(src).then((viewBox) => update({ viewBox, loaded: true }));
        } else update({ loaded: true });
        onLoad?.(src);
      }}
      onError={() => update({ index: cur.index + 1 })}
    />
  );
}
