import { create } from "zustand";
import { api } from "./api";
import { rumble } from "./input";
import { setSoundEnabled, sound } from "./sound";
import type { Game, Running, Settings } from "./types";
import { accentFor, DEFAULT_ACCENT, SOURCE_NAME } from "./util";

export type View = "home" | "library" | "settings";
export type Overlay = "menu" | "search" | null;

export interface Toast {
  id: number;
  text: string;
  tone?: "info" | "good" | "warn";
}

export interface Launching {
  id: string;
  phase: "starting" | "started" | "timeout" | "error";
  message?: string;
  /** Where the cover sat on screen, so the launch card can fly out of it. */
  from?: { x: number; y: number; w: number; h: number };
}

/** The visible focused cover, if the launch came from a shelf or grid. */
function focusedCoverRect(): Launching["from"] {
  for (const el of document.querySelectorAll<HTMLElement>(".cover.is-focused .cover-frame")) {
    const view = el.closest(".view");
    if (view && !view.classList.contains("is-active")) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > 0 && r.left < innerWidth) return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  return undefined;
}

interface State {
  games: Game[];
  loaded: boolean;
  scanning: boolean;
  settings: Settings | null;
  running: Running | null;
  launching: Launching | null;
  view: View;
  detailsId: string | null;
  overlay: Overlay;
  focusId: string | null;
  accent: string;
  toasts: Toast[];
  /** Custom game whose name is being edited. */
  renaming: string | null;
  version: string;
  /** A newer release waiting to be installed from Settings. */
  update: string | null;
}

export const useStore = create<State>(() => ({
  games: [],
  loaded: false,
  scanning: false,
  settings: null,
  running: null,
  launching: null,
  view: "home",
  detailsId: null,
  overlay: null,
  focusId: null,
  accent: DEFAULT_ACCENT,
  toasts: [],
  renaming: null,
  version: "",
  update: null,
}));

const set = useStore.setState;
const get = useStore.getState;

export const gameById = (id: string | null) => (id ? get().games.find((g) => g.id === id) ?? null : null);

let toastSeq = 0;
export function toast(text: string, tone: Toast["tone"] = "info") {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3800);
}

let focusTimer = 0;
/** Background art and accent follow focus, debounced so fast scrolling doesn't strobe. */
export function setFocus(game: Game | null) {
  if (!game || get().focusId === game.id) return;
  clearTimeout(focusTimer);
  focusTimer = window.setTimeout(async () => {
    set({ focusId: game.id });
    const accent = await accentFor(game);
    if (get().focusId === game.id) set({ accent });
  }, 90);
}

export async function boot() {
  const [settings, cached, running] = await Promise.all([api.getSettings(), api.getLibrary(false), api.runningGame()]);
  setSoundEnabled(settings.sounds);
  set({ settings, games: cached, loaded: true, running });
  api.appVersion().then((version) => set({ version }));
  // Installing can't make Mantel the home app, only offer it, and Windows doesn't say so.
  api
    .fullScreenMode()
    .then((m) => m.offered && !m.home && firstTime("mantel.homeAppHint") && toast("Mantel can be the home app of Xbox mode: see Settings", "good"))
    .catch(() => {});
  await rescan(true);
  // Release builds only: a dev build would "update" itself into the installed release.
  if (import.meta.env.PROD) {
    setTimeout(checkForUpdate, 20_000);
    setInterval(checkForUpdate, 6 * 3600_000);
  }
}

/** True the first time `key` is asked for on this PC; false when storage is unavailable. */
function firstTime(key: string): boolean {
  try {
    if (localStorage.getItem(key)) return false;
    localStorage.setItem(key, "1");
    return true;
  } catch {
    return false;
  }
}

async function checkForUpdate() {
  const version = await api.checkUpdate().catch(() => null);
  if (!version || version === get().update) return;
  set({ update: version });
  toast(`Mantel ${version} is ready to install from Settings`, "good");
}

export async function installUpdate() {
  if (get().running) return toast("Close the game first, then update", "warn");
  toast("Installing the update. Mantel will restart");
  await api.installUpdate().catch((e) => toast(`Update failed: ${e}`, "warn"));
}

export async function rescan(quiet = false) {
  if (get().scanning) return;
  set({ scanning: true });
  try {
    const before = get().games.length;
    const games = await api.getLibrary(true);
    set({ games });
    if (!quiet) toast(`Library updated: ${games.length} games`, "good");
    else if (games.length > before && before > 0) toast(`${games.length - before} new ${games.length - before === 1 ? "game" : "games"} found`, "good");
    if (await api.resolveArt()) set({ games: await api.getLibrary(false) });
  } catch (e) {
    toast(`Scan failed: ${e}`, "warn");
  } finally {
    set({ scanning: false });
  }
}

export async function saveSettings(patch: Partial<Settings>) {
  const settings = { ...get().settings!, ...patch };
  set({ settings });
  setSoundEnabled(settings.sounds);
  await api.saveSettings(settings);
}

function patchGame(id: string, patch: Partial<Game>) {
  set((s) => ({ games: s.games.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
}

export async function toggleFavorite(game: Game) {
  const value = !game.favorite;
  patchGame(game.id, { favorite: value });
  await api.setFlag(game.id, "favorite", value);
  toast(value ? `Added ${game.name} to favorites` : `Removed ${game.name} from favorites`);
}

export async function setHidden(game: Game, value: boolean) {
  patchGame(game.id, { hidden: value });
  await api.setFlag(game.id, "hidden", value);
  toast(value ? `${game.name} hidden — restore it in Settings` : `${game.name} is back in your library`);
}

export async function launch(game: Game) {
  if (!game.installed) {
    // The store's own installer takes it from here; nothing to launch or track yet.
    try {
      await api.launchGame(game.id);
      toast(`Opening ${SOURCE_NAME[game.source]} to install ${game.name}`);
    } catch (e) {
      toast(String(e), "warn");
    }
    return;
  }
  const { running } = get();
  if (running?.id === game.id) {
    if (!(await api.switchToGame())) {
      toast(`${game.name} is running in the background without a window. Close it from the control center (≡).`, "warn");
    }
    return;
  }
  if (running?.detected) {
    toast(`Close ${gameById(running.id)?.name ?? "the running game"} first (≡ menu)`, "warn");
    return;
  }
  sound.launch();
  rumble(0.5, 0.9, 260);
  set({ launching: { id: game.id, phase: "starting", from: focusedCoverRect() }, overlay: null });
  try {
    await api.launchGame(game.id);
    set({ running: { id: game.id, startedAt: Date.now() / 1000, detected: false } });
  } catch (e) {
    set({ launching: { id: game.id, phase: "error", message: String(e) } });
  }
}

export async function closeRunning() {
  await api.closeGame();
}

export function wireEvents() {
  const offs = [
    api.on("game-started", (id) => {
      set((s) => ({
        running:
          s.running && s.running.id === id
            ? { ...s.running, detected: true }
            : s.running?.detected
              ? s.running
              : { id: id as string, startedAt: Date.now() / 1000, detected: true },
        launching: s.launching?.id === id ? { id: id as string, phase: "started" } : s.launching,
      }));
    }),
    api.on("game-stopped", async (payload) => {
      const { id, seconds } = payload as { id: string; seconds: number };
      set((s) => ({
        running: s.running?.id === id ? null : s.running,
        launching: s.launching?.id === id ? null : s.launching,
      }));
      const name = gameById(id)?.name;
      const min = Math.round(seconds / 60);
      if (name) toast(min > 0 ? `${name}: +${min} min played` : `${name} closed`, "good");
      set({ games: await api.getLibrary(false) });
    }),
    api.on("game-launch-timeout", (id) => {
      set((s) => ({
        running: s.running?.id === id ? null : s.running,
        launching: s.launching?.id === id ? { id: id as string, phase: "timeout" } : s.launching,
      }));
    }),
  ];
  return () => offs.forEach((off) => off());
}

export function sourceLabel(game: Game) {
  return SOURCE_NAME[game.source];
}
