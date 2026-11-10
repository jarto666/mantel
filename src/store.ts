import { create } from "zustand";
import { api, isTauri } from "./api";
import { errorText, locale, steamLanguage, t } from "./i18n";
import { rumble } from "./input";
import { setSoundEnabled, sound } from "./sound";
import type { AccountsStatus, Editions, Game, InstallProgress, Running, Settings, StoreHome, StoreShelf } from "./types";
import { accentFor, baseTitle, DEFAULT_ACCENT, money, SOURCE_NAME } from "./util";

export type View = "home" | "apps" | "library" | "steam" | "gamepass" | "settings";
export type Overlay = "menu" | "search" | null;

export interface Updating {
  version: string;
  downloaded: number;
  total: number | null;
  /** Seconds left before Mantel closes for the installer, once the download is in. */
  restartIn: number | null;
}

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
  /** The PC Game Pass catalog: games to install, not part of the library. */
  catalog: Game[];
  /** The Steam store's front page; null until it's in or without Steam. */
  steamStore: StoreHome | null;
  /** The Microsoft Store's front page. */
  xboxStore: StoreShelf[] | null;
  /** Games seen on the stores' lists, which the library doesn't have. */
  storeGames: Record<string, Game>;
  accounts: AccountsStatus | null;
  /** Settings is to open this store's sign-in. */
  signInAsk: "steam" | "xbox" | null;
  /** Installs under way, by game id. */
  installs: Record<string, InstallProgress>;
  /** Library ids of games installed from Mantel this run; Home keeps them up front until played. */
  justInstalled: string[];
  /** Whether catalog games are on the player's Microsoft account, as far as the Store says. */
  access: Record<string, boolean | null>;
  /** A trailer is being watched full screen, so the background one holds still. */
  watching: boolean;
  /** The game whose download the player is being asked about cancelling. */
  cancelAsk: string | null;
  /** The game Windows is removing right now. */
  uninstalling: string | null;
  loaded: boolean;
  scanning: boolean;
  settings: Settings | null;
  /** Games running now, oldest first, with a launch still waiting for its process. */
  running: Running[];
  launching: Launching | null;
  /** Games asked to close, until they're gone or Windows refuses. */
  closing: string[];
  view: View;
  detailsId: string | null;
  overlay: Overlay;
  focusId: string | null;
  /** The game card selected right now on the tab in view; null on a tile that isn't a game. */
  selectedId: string | null;
  accent: string;
  toasts: Toast[];
  /** Custom game whose name is being edited. */
  renaming: string | null;
  version: string;
  /** A newer release waiting to be installed from Settings. */
  update: string | null;
  /** The Settings button's check for updates is running. */
  checkingUpdate: boolean;
  /** The step of the first-run setup on screen, or null when it's closed. */
  setupStep: number | null;
  /** A newer release to offer once, as soon as nothing is in the way; null after an answer. */
  updateOffer: string | null;
  /** The update being downloaded and installed, for the screen that shows it. */
  updating: Updating | null;
}

export const useStore = create<State>(() => ({
  games: [],
  catalog: [],
  steamStore: null,
  xboxStore: null,
  storeGames: {},
  accounts: null,
  signInAsk: null,
  installs: {},
  justInstalled: [],
  access: {},
  watching: false,
  cancelAsk: null,
  uninstalling: null,
  loaded: false,
  scanning: false,
  settings: null,
  running: [],
  launching: null,
  closing: [],
  view: "home",
  detailsId: null,
  overlay: null,
  focusId: null,
  selectedId: null,
  accent: DEFAULT_ACCENT,
  toasts: [],
  renaming: null,
  version: "",
  update: null,
  checkingUpdate: false,
  setupStep: null,
  updateOffer: null,
  updating: null,
}));

const set = useStore.setState;
const get = useStore.getState;

/** Games, as opposed to the programs and sites on the Apps tab. */
export const isGame = (g: Game) => g.kind !== "app";

export const gameById = (id: string | null) =>
  id ? get().games.find((g) => g.id === id) ?? get().catalog.find((g) => g.id === id) ?? get().storeGames[id] ?? null : null;

export const isCatalog = (game: Game) => game.id.startsWith("gamepass:");
/** On a store's lists and not in the library: it opens in that store. */
export const isStoreItem = (game: Game) => !!game.tags?.includes("store");

/** The same game on Game Pass or in the library, which can install or play, for a store entry. */
export function ownCopy(game: Game): Game {
  const { games, catalog } = get();
  if (game.source === "steam") return games.find((g) => g.id === game.id) ?? game;
  const pass = catalog.find((c) => c.id === game.id.replace("msstore:", "gamepass:"));
  if (pass) return gamePassGames(games, [pass])[0];
  const family = game.sourceId?.toLowerCase();
  return (family && games.find((g) => g.source === "xbox" && g.sourceId.toLowerCase() === family)) || game;
}

/** The Game Pass catalog with library games standing in for their entries, so what's
 * installed plays instead of offering an install. Bundles and editions come without a
 * package name, so the title decides for them. */
export function gamePassGames(games: Game[], catalog: Game[]): Game[] {
  const byPackage = new Map<string, Game>();
  const byTitle = new Map<string, Game>();
  for (const g of games) {
    if (g.source !== "xbox") continue;
    byPackage.set(g.sourceId.toLowerCase(), g);
    byTitle.set(baseTitle(g.name), g);
  }
  return catalog.map((c) => {
    const own = (c.sourceId && byPackage.get(c.sourceId.toLowerCase())) || byTitle.get(baseTitle(c.name));
    // The library's copy, still filed under the catalog's collections and genres.
    return own ? { ...own, tags: c.tags, genres: c.genres } : c;
  });
}

let passOf: [Game[], Game[]] | null = null;
let passIds = new Set<string>();
/** Whether a game is in the Game Pass catalog, in the library or not. */
export function onGamePass(game: Game) {
  const { games, catalog } = get();
  if (passOf?.[0] !== games || passOf?.[1] !== catalog) {
    passOf = [games, catalog];
    passIds = new Set(gamePassGames(games, catalog).map((g) => g.id));
  }
  return passIds.has(game.id);
}

function keepStoreGames(games: Game[]) {
  set((s) => ({ storeGames: { ...s.storeGames, ...Object.fromEntries(games.map((g) => [g.id, g])) } }));
}

let storeLanguage: string | null = null;

async function loadSteamStore() {
  if (!get().settings?.sources.steam) return set((st) => ({ steamStore: null, view: st.view === "steam" ? "home" : st.view }));
  if (storeLanguage === steamLanguage()) return;
  try {
    const home = await api.steamStoreHome();
    storeLanguage = steamLanguage();
    keepStoreGames(home.shelves.flatMap((s) => s.games));
    set({ steamStore: home });
  } catch (e) {
    api.log("warn", `steam store: ${e}`);
  }
}

/** A page of a Steam store list, all games if `tag` is null. */
export async function steamPage(list: string, tag: number | null, start: number) {
  const page = await api.steamStorePage(list, tag, start);
  keepStoreGames(page.games);
  return page;
}

let xboxStoreLanguage: string | null = null;

async function loadXboxStore() {
  if (!get().settings?.sources.xbox) return set({ xboxStore: null });
  if (xboxStoreLanguage === locale()) return;
  try {
    const shelves = await api.xboxStoreHome(locale().toLowerCase());
    xboxStoreLanguage = locale();
    keepStoreGames(shelves.flatMap((s) => s.games));
    set({ xboxStore: shelves });
  } catch (e) {
    api.log("warn", `xbox store: ${e}`);
  }
}

/** A page of a Microsoft Store list, counting from 1, all games if `genre` is null. */
export async function xboxPage(list: string, genre: string | null, page: number) {
  const found = await api.xboxStorePage(list, genre, page, locale().toLowerCase());
  keepStoreGames(found.games);
  return found;
}

/** The stores' games by name, for search. Each store answers for itself: one being down hides only its own. */
export async function searchStores(query: string): Promise<Game[]> {
  const sources = get().settings?.sources;
  const [xbox, steam] = await Promise.all([
    sources?.xbox ? api.xboxStoreSearch(query, locale().toLowerCase()).catch(() => []) : [],
    sources?.steam ? api.steamStoreSearch(query).catch(() => []) : [],
  ]);
  const games = [
    ...xbox.map(({ game, price, was, currency }) => ({
      ...game,
      price: price === null ? null : money(price, currency),
      discount: price !== null && was && was > price ? Math.round((1 - price / was) * 100) : null,
    })),
    ...steam,
  ];
  keepStoreGames(games);
  return games;
}

/** Installs the game behind an edition: the library's copy of it if there is one, and its own entry if not. */
export function installEdition(from: Game, found: Editions) {
  const family = found.pfn.toLowerCase();
  const copy = family ? get().games.find((g) => g.source === "xbox" && g.sourceId.toLowerCase() === family) : undefined;
  const target = copy ?? { ...from, id: `msstore:${found.game}`, name: found.title, sourceId: found.pfn };
  if (!copy) keepStoreGames([target]);
  set({ detailsId: target.id });
  if (!target.installed) void startInstall(target, true, [found.game]);
}

/** Settings, with this store's sign-in open. */
export function openSignIn(store: "steam" | "xbox") {
  set({ view: "settings", detailsId: null, signInAsk: store });
}

export async function loadCatalog() {
  const s = get().settings;
  if (!s?.sources.xbox || !s.gamePass) return set((st) => ({ catalog: [], view: st.view === "gamepass" && !st.games.some((g) => g.source === "xbox") ? "home" : st.view }));
  try {
    set({ catalog: await api.gamepassCatalog(locale().toLowerCase()) });
    followInstalls();
  } catch (e) {
    api.log("warn", `game pass catalog: ${e}`);
  }
}

const INSTALLING_KEY = "mantel.installing";
const INSTALLING_STORE_KEY = "mantel.installingStore";

/** Installs on their way, kept across runs: Windows carries on after Mantel closes. A store entry
 *  is kept whole, as nothing else lists it on the next run. */
function rememberInstalls() {
  try {
    const ids = Object.keys(get().installs);
    localStorage.setItem(INSTALLING_KEY, JSON.stringify(ids));
    localStorage.setItem(INSTALLING_STORE_KEY, JSON.stringify(ids.map((id) => get().storeGames[id]).filter((g) => g?.id.startsWith("msstore:"))));
  } catch {
    // Without storage the only loss is the notice in followInstalls.
  }
}

function rememberedInstalls(): string[] {
  try {
    return JSON.parse(localStorage.getItem(INSTALLING_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function rememberedStoreGames(): Game[] {
  try {
    return JSON.parse(localStorage.getItem(INSTALLING_STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

let followed = false;
/**
 * Catches up once on what Windows did on its own: installs still going, from before a restart or
 * from the Store, and those that finished while Mantel was closed. Runs after a scan, so a
 * finished game is in the library by now.
 */
async function followInstalls() {
  if (followed) return;
  followed = true;
  const before = rememberedInstalls();
  const fromStores = rememberedStoreGames();
  keepStoreGames(fromStores);
  const products = await api.installsUnderWay().catch(() => [] as string[]);
  const { games, catalog } = get();
  for (const game of gamePassGames(games, catalog)) {
    if (isCatalog(game) && products.includes(game.id.replace("gamepass:", ""))) startInstall(game, true);
  }
  for (const game of games) {
    if (!game.installed && products.includes(game.id)) startInstall(game, true);
  }
  for (const game of fromStores) {
    if (products.includes(game.id)) startInstall(game, true, [game.id.replace("msstore:", "")]);
  }
  for (const id of before) {
    const listed = catalog.find((g) => g.id === id);
    const fromStore = fromStores.find((g) => g.id === id);
    if (fromStore && products.includes(id)) continue;
    const own = listed ? gamePassGames(games, [listed])[0] : fromStore ? ownCopy(fromStore) : games.find((g) => g.id === id);
    if (!own || isCatalog(own) || !own.installed) continue;
    set((s) => ({ justInstalled: [own.id, ...s.justInstalled] }));
    toast(t("{name} finished installing while Mantel was closed", { name: own.name }), "good");
  }
  rememberInstalls();
}

let toastSeq = 0;
export function toast(text: string, tone: Toast["tone"] = "info") {
  const id = ++toastSeq;
  set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
  setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3800);
}

let focusTimer = 0;
/** Background art and accent follow focus, debounced so fast scrolling doesn't strobe. */
/** What the tab in view has selected now, for actions on "this game" such as closing it. */
export function setSelected(id: string | null) {
  if (get().selectedId !== id) set({ selectedId: id });
}

export function setFocus(game: Game | null) {
  if (!game) return;
  // Back on the game the art already shows, before the move away from it landed: that move is off,
  // or the art and trailer would stay on the other game while this one is selected.
  clearTimeout(focusTimer);
  if (get().focusId === game.id) return;
  focusTimer = window.setTimeout(async () => {
    set({ focusId: game.id });
    const accent = await accentFor(game);
    if (get().focusId === game.id) set({ accent });
  }, 90);
}

export async function boot() {
  const [settings, cached, running] = await Promise.all([api.getSettings(), api.getLibrary(false), api.runningGames()]);
  setSoundEnabled(settings.sounds);
  set({ settings, games: cached, loaded: true, running });
  // Xbox mode opened Mantel again while an update installs, and the installer is about to close
  // this copy, or to finish. Wait on the update screen instead of starting up a version that's
  // on its way out: no scan, no setup, no update check.
  const installing = await api.updateInProgress().catch(() => null);
  if (installing) {
    api.log("info", `update ${installing} is installing: waiting for it`);
    set({ updating: { version: installing, downloaded: 0, total: null, restartIn: 0 } });
    while (await api.updateInProgress().catch(() => null)) await new Promise((r) => setTimeout(r, 1000));
    set({ updating: null });
  }
  api.installs().then((list) => set({ installs: Object.fromEntries(list.map((p) => [p.id, p])) }), () => {});
  api.appVersion().then((version) => set({ version }));
  // The library scan carries on behind it, so setup can show what it found.
  if (!setupDone()) set({ setupStep: 0 });
  // Development only: ?setup=2 opens setup at that step, for screenshots and design work.
  const devStep = import.meta.env.DEV ? new URLSearchParams(location.search).get("setup") : null;
  if (devStep !== null) set({ setupStep: Math.max(0, Math.min(3, Number(devStep) || 0)) });
  await rescan(true);
  // A dev build would "update" itself into the installed release, unless it was built to take a
  // test feed (tools/ally.sh build-dev update-test). Sample data offers one with ?mockUpdate.
  if (updatesHere()) {
    setTimeout(checkForUpdate, 4_000);
    setInterval(checkForUpdate, 6 * 3600_000);
  }
}

const updatesHere = () => import.meta.env.PROD || !!import.meta.env.VITE_UPDATE_TEST || !isTauri;

const SETUP_KEY = "mantel.setupDone";

/** Whether setup ran on this PC; true when storage is unavailable, so it can't come back every start. */
function setupDone(): boolean {
  try {
    return !!localStorage.getItem(SETUP_KEY);
  } catch {
    return true;
  }
}

/** First-run setup, from the start: Settings offers it again. */
export function openSetup() {
  set({ setupStep: 0, overlay: null, detailsId: null });
}

export function closeSetup() {
  set({ setupStep: null });
  try {
    localStorage.setItem(SETUP_KEY, "1");
  } catch {
    // It shows again next time, which beats not showing at all.
  }
}

const SNOOZE_KEY = "mantel.updateLater";
const SNOOZE = 24 * 3600_000;

/** Offers a new version, unless "Later" was chosen less than a day ago. The banner then waits
 *  until setup and any game are out of the way; Settings shows the update either way. */
async function checkForUpdate() {
  const version = await api.checkUpdate().catch((e) => {
    api.log("warn", `update check: ${e}`);
    return null;
  });
  if (!version) return;
  set({ update: version });
  if (!snoozed()) set({ updateOffer: version });
}

function snoozed(): boolean {
  try {
    return Date.now() - Number(localStorage.getItem(SNOOZE_KEY) ?? 0) < SNOOZE;
  } catch {
    return false;
  }
}

/** "Later": no offer for a day, whatever version comes out meanwhile. */
export function dismissUpdateOffer() {
  set({ updateOffer: null });
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now()));
  } catch {
    // Then it asks again next start, which is still only once a run.
  }
}

/** The Settings button: unlike the background check, it always says how it went. */
export async function checkForUpdateNow() {
  if (get().checkingUpdate) return;
  set({ checkingUpdate: true });
  try {
    const version = await api.checkUpdate();
    if (!version) toast(t("You're on the latest version"), "good");
    // A dev build would "update" itself into the installed release, so it only says so.
    else if (!updatesHere()) toast(`Dev build: release ${version} is out`);
    else {
      // Settings' own row turns into the update, right where the player is looking.
      set({ update: version });
      toast(t("Mantel {version} is out", { version }), "good");
    }
  } catch (e) {
    api.log("warn", `update check: ${e}`);
    toast(t("Couldn't check for updates: {error}", { error: errorText(e) }), "warn");
  } finally {
    set({ checkingUpdate: false });
  }
}

export async function installUpdate() {
  if (get().running.length) return toast(t("Close the game first, then update"), "warn");
  const version = get().update ?? "";
  set({ updateOffer: null, updating: { version, downloaded: 0, total: null, restartIn: null } });
  const patch = (p: Partial<Updating>) => set((s) => ({ updating: s.updating && { ...s.updating, ...p } }));
  try {
    await api.installUpdate(
      (downloaded, total) => patch({ downloaded, total }),
      // A few seconds' warning: the window is about to close, and it isn't a crash.
      async () => {
        for (let n = 3; n > 0; n--) {
          patch({ restartIn: n });
          await new Promise((r) => setTimeout(r, 1000));
        }
        patch({ restartIn: 0 });
        // The copy Xbox mode opens while the installer works sees this and waits.
        await api.beginUpdate(version).catch(() => {});
      },
    );
    // On Windows the installer has closed Mantel by now; sample data has nothing to restart into.
    if (!isTauri) setTimeout(() => set({ updating: null }), 1500);
  } catch (e) {
    api.log("warn", `update: ${e}`);
    // Copies Xbox mode opens from now on start up as usual.
    api.endUpdate().catch(() => {});
    set({ updating: null });
    toast(t("Update failed: {error}", { error: errorText(e) }), "warn");
  }
}

export async function rescan(quiet = false) {
  if (get().scanning) return;
  set({ scanning: true });
  try {
    // Apps on the Apps tab aren't games: they don't count as new games found.
    const shown = (list: Game[]) => list.filter((g) => !g.hidden && isGame(g)).length;
    const before = shown(get().games);
    const games = await api.getLibrary(true);
    set({ games });
    const count = games.filter(isGame).length;
    if (!quiet) toast(count === 1 ? t("Library updated: 1 game") : t("Library updated: {n} games", { n: count }), "good");
    // Games that finished installing with Mantel closed get a notice of their own in followInstalls.
    else if (shown(games) > before && before > 0 && (followed || !rememberedInstalls().length)) toast(shown(games) - before === 1 ? t("1 new game found") : t("{n} new games found", { n: shown(games) - before }), "good");
    if (await api.resolveArt()) set({ games: await api.getLibrary(false) });
    if (await api.measureSizes()) set({ games: await api.getLibrary(false) });
    // Games from other stores that matched a Steam page get its art too, Steam turned on or not.
    if (get().games.some((g) => g.steamAppId) && (await api.resolveSteamFacts().catch(() => false))) set({ games: await api.getLibrary(false) });
    set({ accounts: await api.accountsStatus() });
    await loadCatalog();
    void loadSteamStore();
    void loadXboxStore();
  } catch (e) {
    toast(t("Scan failed: {error}", { error: errorText(e) }), "warn");
  } finally {
    set({ scanning: false });
  }
}

export async function saveSettings(patch: Partial<Settings>) {
  const keyChanged = patch.steamgriddbKey !== undefined && patch.steamgriddbKey !== get().settings?.steamgriddbKey;
  const settings = { ...get().settings!, ...patch };
  set({ settings });
  setSoundEnabled(settings.sounds);
  await api.saveSettings(settings);
  // Saving a new key drops the art found before it, so look it up again right away.
  if (keyChanged && (await api.resolveArt())) set({ games: await api.getLibrary(false) });
}

function patchGame(id: string, patch: Partial<Game>) {
  set((s) => ({ games: s.games.map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
}

export async function toggleFavorite(game: Game) {
  const value = !game.favorite;
  patchGame(game.id, { favorite: value });
  await api.setFlag(game.id, "favorite", value);
  toast(value ? t("Added {name} to favorites", { name: game.name }) : t("Removed {name} from favorites", { name: game.name }));
}

export async function setHidden(game: Game, value: boolean) {
  patchGame(game.id, { hidden: value });
  await api.setFlag(game.id, "hidden", value);
  toast(value ? t("{name} hidden — restore it in Settings", { name: game.name }) : t("{name} is back in your library", { name: game.name }));
}

export async function launch(game: Game) {
  if (!game.installed) {
    if (get().installs[game.id]) return set({ detailsId: game.id });
    if (game.source === "steam") {
      toast(t("Opening {store} to install {name}", { store: sourceLabel(game), name: game.name }));
      return startInstall(game, true);
    }
    // Its page says whether it's on the account, and installs it or opens the Xbox app.
    if (game.source === "xbox" && !isCatalog(game)) return set({ detailsId: game.id });
    // The store's own installer takes it from here; nothing to launch or track yet.
    try {
      await api.launchGame(game.id);
      toast(t("Opening {store} to install {name}", { store: sourceLabel(game), name: game.name }));
    } catch (e) {
      toast(errorText(e), "warn");
    }
    return;
  }
  if (isRunning(game.id)) return switchTo(game.id);
  sound.launch();
  rumble(0.5, 0.9, 260);
  // An app just opens its window: the cover flight and "Starting" are for games.
  if (!isGame(game)) {
    try {
      await api.launchGame(game.id);
      set((s) => ({ running: [...s.running.filter((r) => r.detected && r.id !== game.id), { id: game.id, startedAt: Date.now() / 1000, detected: false }] }));
    } catch (e) {
      toast(errorText(e), "warn");
    }
    return;
  }
  set({ launching: { id: game.id, phase: "starting", from: focusedCoverRect() }, overlay: null });
  try {
    await api.launchGame(game.id);
    // As the backend does: one launch waits at a time, games already running stay.
    set((s) => ({ running: [...s.running.filter((r) => r.detected && r.id !== game.id), { id: game.id, startedAt: Date.now() / 1000, detected: false }] }));
  } catch (e) {
    set({ launching: { id: game.id, phase: "error", message: errorText(e) } });
  }
}

export function isRunning(id: string) {
  return get().running.some((r) => r.id === id);
}

/** Back into a running game, as the taskbar would. */
export async function switchTo(id: string) {
  if (await api.switchToGame(id)) return;
  const name = gameById(id)?.name ?? "";
  toast(t("{name} is running in the background without a window. Close it from the control center (≡).", { name }), "warn");
}

const notClosing = (s: State, id: string) => s.closing.filter((x) => x !== id);

/** The game gets a few seconds to quit by itself; "game-stopped" then says it's gone. */
export async function closeRunning(id: string) {
  if (get().closing.includes(id)) return;
  set((s) => ({ closing: [...s.closing, id] }));
  const name = gameById(id)?.name;
  if (name) toast(t("Closing {name}…", { name }));
  try {
    await api.closeGame(id);
  } catch (e) {
    toast(errorText(e), "warn");
    return set((s) => ({ closing: notClosing(s, id) }));
  }
  // A launch that never got going is simply dropped, with no "game-stopped" to follow.
  const left = await api.runningGames();
  if (!left.some((r) => r.id === id))
    set((s) => ({ running: s.running.filter((r) => r.id !== id), launching: s.launching?.id === id ? null : s.launching, closing: notClosing(s, id) }));
}

export function wireEvents() {
  const offs = [
    api.on("game-started", (id) => {
      set((s) => ({
        running: s.running.some((r) => r.id === id)
          ? s.running.map((r) => (r.id === id ? { ...r, detected: true } : r))
          : [...s.running, { id: id as string, startedAt: Date.now() / 1000, detected: true }],
        launching: s.launching?.id === id ? { id: id as string, phase: "started" } : s.launching,
      }));
    }),
    api.on("game-stopped", async (payload) => {
      const { id, seconds } = payload as { id: string; seconds: number };
      set((s) => ({
        running: s.running.filter((r) => r.id !== id),
        launching: s.launching?.id === id ? null : s.launching,
        closing: notClosing(s, id),
      }));
      const game = gameById(id);
      const name = game?.name;
      const min = Math.round(seconds / 60);
      // Time in an app isn't playtime.
      if (name && seconds > 0) toast(min > 0 && isGame(game) ? t("{name}: +{min} min played", { name, min }) : t("{name} closed", { name }), "good");
      set({ games: await api.getLibrary(false) });
    }),
    api.on("install-progress", (payload) => void installProgress(payload as InstallProgress)),
    api.on("game-uninstalled", (payload) => void gameUninstalled(payload as string)),
    api.on("game-launch-timeout", (id) => {
      set((s) => ({
        running: s.running.filter((r) => r.id !== id || r.detected),
        launching: s.launching?.id === id ? { id: id as string, phase: "timeout" } : s.launching,
      }));
    }),
  ];
  return () => offs.forEach((off) => off());
}

/** Asks the Store until it says yes: the player may have subscribed in the meantime. */
export async function checkAccess(game: Game) {
  if (get().access[game.id]) return true;
  const access = await api.installAccess(game.id).catch(() => null);
  set((s) => ({ access: { ...s.access, [game.id]: access } }));
  return access;
}

/** Windows downloads any game it's asked to, and only refuses it at launch, so this asks first. */
export async function startInstall(game: Game, anyway = false, chosen?: string[]) {
  set((s) => ({ installs: { ...s.installs, [game.id]: { id: game.id, state: "pending", percent: 0, downloaded: 0, total: 0 } } }));
  rememberInstalls();
  if (!anyway && (await checkAccess(game)) === false) return dropInstall(game.id);
  try {
    await api.installGame(game.id, chosen);
  } catch (e) {
    dropInstall(game.id);
    toast(errorText(e), "warn");
  }
}

/** Cancels at once while there's nothing to lose yet, and asks once there is. */
export function askCancel(game: Game) {
  const install = get().installs[game.id];
  if (!install || install.state === "canceling") return;
  if (game.source === "steam") {
    // Past the download Steam takes no notice of an uninstall.
    if (install.state === "installing") return toast(t("Steam is finishing the install"));
    // Steam asks for itself, and may well hear no.
    return void api.cancelInstall(game.id).catch((e) => toast(errorText(e), "warn"));
  }
  if (install.downloaded < 1024 ** 2) return void cancelInstall(game);
  set({ cancelAsk: game.id });
}

export async function cancelInstall(game: Game) {
  const before = get().installs[game.id];
  if (!before || before.state === "canceling") return;
  const mark = (state: InstallProgress["state"]) =>
    set((s) => (s.installs[game.id] ? { installs: { ...s.installs, [game.id]: { ...s.installs[game.id], state } } } : s));
  mark("canceling");
  await api.cancelInstall(game.id).catch((e) => {
    mark(before.state);
    toast(errorText(e), "warn");
  });
}

function dropInstall(id: string) {
  set((s) => {
    const { [id]: _, ...rest } = s.installs;
    return { installs: rest };
  });
  rememberInstalls();
}

/** The download's speed, smoothed: Windows reports in bursts. */
function pace(was: InstallProgress | undefined, p: InstallProgress) {
  const at = Date.now();
  if (!was?.at || !was.downloaded) return { at, speed: was?.speed ?? 0 };
  const seconds = (at - was.at) / 1000;
  const got = p.downloaded - was.downloaded;
  if (got <= 0) return { at: was.at, speed: seconds > 10 ? 0 : was.speed ?? 0 };
  const now = got / seconds;
  return { at, speed: was.speed ? was.speed * 0.8 + now * 0.2 : now };
}

/** A scan already under way may predate what just changed, so this one waits its turn. */
async function rescanFresh() {
  while (get().scanning) await new Promise((r) => setTimeout(r, 400));
  await rescan(true);
}

export async function uninstall(game: Game) {
  try {
    // Steam takes it from here, with a dialog of its own.
    if (game.source === "steam") toast(t("Opening {store} to uninstall {name}", { store: sourceLabel(game), name: game.name }));
    else set({ uninstalling: game.id });
    await api.uninstallGame(game.id);
  } catch (e) {
    set({ uninstalling: null });
    toast(t("Couldn't uninstall {name}: {error}", { name: game.name, error: errorText(e) }), "warn");
  }
}

async function gameUninstalled(id: string) {
  const game = gameById(id);
  // The open page moves to the catalog's copy, with its Install button, if the game has one.
  const copy = game && get().catalog.find((c) => gamePassGames([game], [c])[0].id === id);
  set((s) => ({
    uninstalling: null,
    games: s.games.filter((g) => g.id !== id),
    justInstalled: s.justInstalled.filter((g) => g !== id),
    detailsId: s.detailsId === id ? copy?.id ?? null : s.detailsId,
  }));
  if (game) toast(t("{name} was uninstalled", { name: game.name }), "good");
  await rescanFresh();
}

async function installProgress(p: InstallProgress) {
  const game = gameById(p.id);
  if (p.state === "error" || p.state === "canceled") {
    dropInstall(p.id);
    if (!game) return;
    if (p.state === "error") return toast(t("Couldn't install {name}: {error}", { name: game.name, error: errorText(p.error ?? "") }), "warn");
    return toast(t("Install canceled: {name}", { name: game.name }));
  }
  set((s) => {
    const was = s.installs[p.id];
    // Windows goes on reporting progress for a moment after being told to cancel.
    const state = was?.state === "canceling" && p.state !== "done" ? "canceling" : p.state;
    return { installs: { ...s.installs, [p.id]: { ...p, state, ...pace(was, p) } } };
  });
  if (p.state !== "done") return;
  if (game) toast(t("{name} is installed", { name: game.name }), "good");
  await rescanFresh();
  // The open page moves to the library's copy, which can play; until then it says "Installed".
  if (game && !isCatalog(game)) set((s) => ({ justInstalled: [game.id, ...s.justInstalled] }));
  const own = game && (isCatalog(game) ? gamePassGames(get().games, [game])[0] : ownCopy(game));
  if (own && own.id !== p.id) {
    set((s) => ({ justInstalled: [own.id, ...s.justInstalled], detailsId: s.detailsId === p.id ? own.id : s.detailsId }));
  }
  dropInstall(p.id);
}

export function sourceLabel(game: Game) {
  return t(SOURCE_NAME[game.source]);
}
