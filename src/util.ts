import { toSrc } from "./api";
import type { Game, Source } from "./types";

export const SOURCE_NAME: Record<Source, string> = {
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  xbox: "Xbox",
  ubisoft: "Ubisoft",
  custom: "Custom",
};

export function playtime(minutes: number): string {
  if (minutes <= 0) return "Not played yet";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h >= 100 || !m ? `${h} h` : `${h} h ${m} min`;
}

/** Hours with one decimal, for big stat numerals. */
export function hours(minutes: number): string {
  if (minutes < 60) return `${minutes}`;
  return `${Math.round(minutes / 6) / 10}`;
}

export function lastPlayed(ts?: number | null): string {
  if (!ts) return "Never";
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  const sameDay = new Date(ts * 1000).toDateString() === new Date().toDateString();
  if (sameDay) return "Today";
  if (days <= 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? "Last week" : `${w} weeks ago`;
  }
  return new Date(ts * 1000).toLocaleDateString("en-US", { day: "numeric", month: "short", year: days > 330 ? "numeric" : undefined });
}

export function size(bytes?: number | null): string {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(gb >= 100 ? 0 : 1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** A stable two-tone gradient per title, for games with no art at all. */
export function placeholderHue(name: string): number {
  return hash(name) % 360;
}

const normalize = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Substring match, plus initials ("rdr" → Red Dead Redemption). */
export function matches(game: Game, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const name = normalize(game.name);
  if (name.includes(q)) return true;
  const initials = name.split(" ").map((w) => w[0]).join("");
  return q.length >= 2 && !q.includes(" ") && initials.startsWith(q);
}

// ---- Accent colour from cover art ------------------------------------------------

export const DEFAULT_ACCENT = "#ff6b3d";
const accentCache = new Map<string, string>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function loadCors(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/**
 * The cover's most vivid colour, nudged into a range that reads well on near-black.
 * Hue buckets weighted by saturation beat a plain average, which tends to mud.
 */
export async function accentFor(game: Game): Promise<string> {
  const cached = accentCache.get(game.id);
  if (cached) return cached;
  for (const path of [...game.art.cover, ...game.art.hero]) {
    try {
      const img = await loadCors(toSrc(path));
      const canvas = document.createElement("canvas");
      canvas.width = 24;
      canvas.height = 36;
      const c = canvas.getContext("2d", { willReadFrequently: true })!;
      c.drawImage(img, 0, 0, 24, 36);
      const px = c.getImageData(0, 0, 24, 36).data;
      const buckets = new Array(12).fill(0).map(() => ({ w: 0, h: 0, s: 0 }));
      for (let i = 0; i < px.length; i += 4) {
        const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
        if (l < 0.12 || l > 0.92 || s < 0.2) continue;
        const w = s * s * (1 - Math.abs(l - 0.5));
        const b = buckets[Math.floor(h / 30) % 12];
        b.w += w;
        b.h += h * w;
        b.s += s * w;
      }
      const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
      const color =
        best.w < 0.6
          ? DEFAULT_ACCENT
          : `hsl(${Math.round(best.h / best.w)} ${Math.round(Math.min(95, Math.max(60, (best.s / best.w) * 100)))}% 62%)`;
      accentCache.set(game.id, color);
      return color;
    } catch {
      // Tainted or missing: try the next candidate.
    }
  }
  accentCache.set(game.id, DEFAULT_ACCENT);
  return DEFAULT_ACCENT;
}

// ---- Logo trimming -----------------------------------------------------------------

const trimCache = new Map<string, string | null>();

/**
 * Store logos ship with wide transparent margins. Returns an `object-view-box` inset that
 * crops to the visible pixels, or null when the image can't be read (no CORS) or is tight.
 */
export async function logoViewBox(src: string): Promise<string | null> {
  if (trimCache.has(src)) return trimCache.get(src)!;
  let box: string | null = null;
  try {
    const img = await loadCors(src);
    const w = 200;
    const h = Math.max(1, Math.round((w * img.naturalHeight) / img.naturalWidth));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d", { willReadFrequently: true })!;
    c.drawImage(img, 0, 0, w, h);
    const px = c.getImageData(0, 0, w, h).data;
    let [x0, y0, x1, y1] = [w, h, -1, -1];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 24) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= 0) {
      const pct = (n: number, of: number) => `${Math.max(0, (n / of) * 100 - 0.5).toFixed(2)}%`;
      const inset = [pct(y0, h), pct(w - 1 - x1, w), pct(h - 1 - y1, h), pct(x0, w)];
      if (inset.some((v) => parseFloat(v) > 3)) box = `inset(${inset.join(" ")})`;
    }
  } catch {
    // Tainted canvas or failed load: show the logo untrimmed.
  }
  trimCache.set(src, box);
  return box;
}
