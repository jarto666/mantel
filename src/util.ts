import { toSrc } from "./api";
import { locale, t } from "./i18n";
import type { Game, InstallProgress, Source } from "./types";

export const SOURCE_NAME: Record<Source, string> = {
  steam: "Steam",
  epic: "Epic Games",
  gog: "GOG",
  xbox: "Xbox",
  ubisoft: "Ubisoft",
  custom: "Custom",
};

export function playtime(minutes: number): string {
  if (minutes <= 0) return t("Not played yet");
  if (minutes < 60) return t("{n} min", { n: minutes });
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h >= 100 || !m ? t("{h} h", { h }) : t("{h} h {m} min", { h, m });
}

/** Hours with one decimal, for big stat numerals. */
export function hours(minutes: number): string {
  if (minutes < 60) return `${minutes}`;
  return (Math.round(minutes / 6) / 10).toLocaleString(locale());
}

/** `played` tells a game with no date on record from one that was never started. */
export function lastPlayed(ts?: number | null, played = false): string {
  if (!ts) return played ? "—" : t("Never");
  const days = Math.floor((Date.now() / 1000 - ts) / 86400);
  const sameDay = new Date(ts * 1000).toDateString() === new Date().toDateString();
  if (sameDay) return t("Today");
  if (days <= 1) return t("Yesterday");
  if (days < 7) return t("{days} days ago", { days });
  if (days < 30) {
    const w = Math.floor(days / 7);
    return w === 1 ? t("Last week") : t("{w} weeks ago", { w });
  }
  return new Date(ts * 1000).toLocaleDateString(locale(), { day: "numeric", month: "short", year: days > 330 ? "numeric" : undefined });
}

export function size(bytes?: number | null): string {
  if (!bytes) return "—";
  const gb = bytes / 1024 ** 3;
  const digits = gb >= 100 ? 0 : 1;
  const n = gb.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return gb >= 1 ? t("{n} GB", { n }) : t("{n} MB", { n: Math.round(bytes / 1024 ** 2) });
}

export function speedText(bytesPerSecond: number): string {
  return t("{n} MB/s", { n: (bytesPerSecond / 1024 ** 2).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) });
}

export function timeLeft(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  if (minutes <= 1) return t("Less than a minute left");
  const h = Math.floor(minutes / 60);
  return h ? t("{h} h {m} min left", { h, m: minutes % 60 }) : t("{m} min left", { m: minutes });
}

export function installLabel(p: InstallProgress): string {
  const percent = Math.round(p.percent);
  switch (p.state) {
    case "pending":
      return p.id.startsWith("steam:") ? t("Waiting for Steam…") : t("Waiting to install…");
    case "paused":
      return t("Install paused");
    case "canceling":
      return t("Canceling…");
    case "done":
      return t("Installed");
    case "downloading":
      return t("Downloading… {percent}%", { percent });
    default:
      return percent >= 100 ? t("Installing…") : t("Installing… {percent}%", { percent });
  }
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

const EDITION_WORDS = new Set(
  "standard deluxe ultimate gold complete definitive goty game of the year cross gen edition bundle for windows pc launcher elite".split(" "),
);

/** A store title without its edition, for matching the same game across listings:
 * "Forza Horizon 5 Standard Edition" and "Forza Horizon 5" both become "forza horizon 5". */
export function baseTitle(name: string): string {
  const words = normalize(name).split(" ");
  while (words.length > 1 && EDITION_WORDS.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

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
