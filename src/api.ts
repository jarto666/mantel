import type { AccountsStatus, Achievement, ArtChoices, ArtKind, Details, Editions, Game, InstallProgress, Listing, Power, Quick, Running, Settings, StoreHit, StoreHome, StorePage, StoreShelf, Suggestion } from "./types";
import { mockApi } from "./mock";
import { steamLanguage } from "./i18n";

/** True inside the Tauri shell; false in a plain browser, where the mock library stands in. */
export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export interface Api {
  getLibrary(rescan: boolean): Promise<Game[]>;
  resolveArt(): Promise<boolean>;
  /** Sizes install folders whose store reports none; true when any changed. */
  measureSizes(): Promise<boolean>;
  getDetails(id: string): Promise<Details | null>;
  /** Every PC Game Pass game, in `language` like "en-us"; refreshed by the backend once a day. */
  gamepassCatalog(language: string): Promise<Game[]>;
  /** Installs a Game Pass game through Windows' Store installer; "install-progress" follows it. */
  /** `chosen` installs only these parts of a bundle. */
  installGame(id: string, chosen?: string[]): Promise<void>;
  cancelInstall(id: string): Promise<void>;
  /** Installs still under way. */
  installs(): Promise<InstallProgress[]>;
  /** Store product ids of the installs Windows has under way, whoever started them. */
  installsUnderWay(): Promise<string[]>;
  /** Whether a catalog game is on the player's Microsoft account; null when the Store can't say. */
  installAccess(id: string): Promise<boolean | null>;
  /** Removes an installed game; "game-uninstalled" says when it's gone. Steam asks the player first. */
  uninstallGame(id: string): Promise<void>;
  /** The game's achievements from the Steam or Xbox account it came from. */
  getAchievements(id: string): Promise<Achievement[]>;
  setFlag(id: string, flag: "favorite" | "hidden", value: boolean): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  addCustomGame(path: string, name?: string, target?: string): Promise<Game[]>;
  renameCustomGame(id: string, name: string): Promise<Game[]>;
  /** Folders and launchable files, or with `images` folders and pictures. */
  listDir(path: string | null, images?: boolean): Promise<Listing>;
  /** SteamGridDB's art of one kind for a game, and what was picked before. */
  artChoices(id: string, kind: ArtKind): Promise<ArtChoices>;
  /** An https URL or an image file as the game's art; null goes back to the store's. */
  setArt(id: string, kind: ArtKind, src: string | null): Promise<Game[]>;
  appSuggestions(): Promise<Suggestion[]>;
  switchToGame(): Promise<boolean>;
  removeCustomGame(id: string): Promise<Game[]>;
  launchGame(id: string): Promise<void>;
  closeGame(): Promise<void>;
  runningGame(): Promise<Running | null>;
  openGameFolder(id: string): Promise<void>;
  powerStatus(): Promise<Power>;
  quickStatus(): Promise<Quick>;
  setVolume(level: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  setBrightness(level: number): Promise<void>;
  powerAction(action: "shutdown" | "restart" | "desktop" | "fullscreen" | "home-app-settings" | "developer-settings" | "quit"): Promise<void>;
  /** Windows' full screen experience (Xbox mode): whether it's on and whether we can toggle it. */
  fullScreenMode(): Promise<FullScreenMode>;
  /** Makes Mantel the home app of Xbox mode, turning on Developer Mode first if needed: Windows
   *  then asks the player for permission. Rejects with a fixed English reason. */
  makeHomeApp(): Promise<FullScreenMode>;
  getAutostart(): Promise<boolean>;
  setAutostart(on: boolean): Promise<void>;
  on(event: GameEvent, cb: (payload: unknown) => void): () => void;
  log(level: "info" | "warn" | "error", message: string): void;
  accountsStatus(): Promise<AccountsStatus>;
  /** Opens Steam's sign-in page; resolves once signed in and the account's games are in. */
  steamSignIn(): Promise<AccountsStatus>;
  /** Opens Microsoft's sign-in page; resolves once signed in to Xbox Live. */
  xboxSignIn(): Promise<AccountsStatus>;
  disconnectAccount(service: "steam" | "xbox"): Promise<AccountsStatus>;
  openUrl(url: string): Promise<void>;
  openSteamDownloads(): Promise<void>;
  openSteamStore(appid: number): Promise<void>;
  /** Asks Steam about the library's Steam games; whether anything changed. */
  resolveSteamFacts(): Promise<boolean>;
  steamStoreHome(): Promise<StoreHome>;
  steamStorePage(list: string, tag: number | null, start: number): Promise<StorePage>;
  openXboxStore(product: string): Promise<void>;
  xboxEditions(id: string, language: string): Promise<Editions | null>;
  editionOnAccount(id: string, parts: string[]): Promise<boolean | null>;
  xboxStoreSearch(query: string, language: string): Promise<StoreHit[]>;
  steamStoreSearch(query: string): Promise<Game[]>;
  xboxStoreHome(language: string): Promise<StoreShelf[]>;
  xboxStorePage(list: string, genre: string | null, page: number, language: string): Promise<StorePage>;
  readClipboard(): Promise<string>;
  appVersion(): Promise<string>;
  /** The version of a newer release, or null when up to date. */
  checkUpdate(): Promise<string | null>;
  /** Downloads the release found by checkUpdate, reporting bytes as they come, waits for
   *  `beforeInstall`, then installs it and restarts into it: on Windows the installer closes
   *  Mantel itself. */
  installUpdate(onProgress: (downloaded: number, total: number | null) => void, beforeInstall: () => Promise<void>): Promise<void>;
}

export type GameEvent = "game-started" | "game-stopped" | "game-launch-timeout" | "install-progress" | "game-uninstalled";

export interface FullScreenMode {
  supported: boolean;
  active: boolean;
  canSwitch: boolean;
  /** Windows lists Mantel among home apps: its package is registered, which needs Developer Mode. */
  offered: boolean;
  /** Mantel is the home app. */
  home: boolean;
  /** Windows' Developer Mode, without which it won't take Mantel as the home app. */
  developerMode: boolean;
}

let pendingUpdate: import("@tauri-apps/plugin-updater").Update | null = null;

// GitHub can take the connection and then never answer, and the updater has no deadline of its
// own: the check would spin forever, and the update screen, where nothing can be pressed, stay up.
const CHECK_TIMEOUT = 20_000;
/** The whole download. It has to be set: without it the download inherits the check's. */
const DOWNLOAD_TIMEOUT = 15 * 60_000;
/** No bytes for this long, and the update screen gives up long before DOWNLOAD_TIMEOUT. */
const DOWNLOAD_STALL = 30_000;

const tauriApi: Api = {
  getLibrary: (rescan) => call("get_library", { rescan }),
  resolveArt: () => call("resolve_art"),
  measureSizes: () => call("measure_sizes"),
  getDetails: (id) => call("get_details", { id, language: steamLanguage() }),
  gamepassCatalog: (language) => call("gamepass_catalog", { language }),
  installGame: (id, chosen) => call("install_game", { id, chosen }),
  cancelInstall: (id) => call("cancel_install", { id }),
  installs: () => call("installs"),
  installsUnderWay: () => call("installs_under_way"),
  installAccess: (id) => call("install_access", { id }),
  uninstallGame: (id) => call("uninstall_game", { id }),
  getAchievements: (id) => call("get_achievements", { id }),
  setFlag: (id, flag, value) => call("set_flag", { id, flag, value }),
  getSettings: () => call("get_settings"),
  saveSettings: (settings) => call("save_settings", { settings }),
  addCustomGame: (path, name, target) => call("add_custom_game", { path, name: name ?? null, target: target ?? null }),
  renameCustomGame: (id, name) => call("rename_custom_game", { id, name }),
  listDir: (path, images) => call("list_dir", { path, images: images ?? false }),
  artChoices: (id, kind) => call("art_choices", { id, kind }),
  setArt: (id, kind, src) => call("set_art", { id, kind, src }),
  appSuggestions: () => call("app_suggestions"),
  switchToGame: () => call("switch_to_game"),
  removeCustomGame: (id) => call("remove_custom_game", { id }),
  launchGame: (id) => call("launch_game", { id }),
  closeGame: () => call("close_game"),
  runningGame: () => call("running_game"),
  openGameFolder: (id) => call("open_game_folder", { id }),
  powerStatus: () => call("power_status"),
  quickStatus: () => call("quick_status"),
  setVolume: (level) => call("set_volume", { level }),
  setMuted: (muted) => call("set_muted", { muted }),
  setBrightness: (level) => call("set_brightness", { level }),
  powerAction: (action) => call("power_action", { action }),
  fullScreenMode: () => call("full_screen_mode"),
  makeHomeApp: () => call("make_home_app"),
  async getAutostart() {
    const { isEnabled } = await import("@tauri-apps/plugin-autostart");
    return isEnabled();
  },
  async setAutostart(on) {
    const m = await import("@tauri-apps/plugin-autostart");
    await (on ? m.enable() : m.disable());
  },
  log(level, message) {
    call("client_log", { level, message }).catch(() => {});
  },
  accountsStatus: () => call("accounts_status"),
  steamSignIn: () => call("steam_sign_in"),
  xboxSignIn: () => call("xbox_sign_in"),
  disconnectAccount: (service) => call("disconnect_account", { service }),
  openUrl: (url) => call("open_url", { url }),
  openSteamDownloads: () => call("open_steam_downloads"),
  openSteamStore: (appid) => call("open_steam_store", { appid }),
  resolveSteamFacts: () => call("resolve_steam_facts", { language: steamLanguage() }),
  steamStoreHome: () => call("steam_store_home", { language: steamLanguage() }),
  steamStorePage: (list, tag, start) => call("steam_store_page", { list, tag, start, language: steamLanguage() }),
  openXboxStore: (product) => call("open_xbox_store", { product }),
  xboxEditions: (id, language) => call("xbox_editions", { id, language }),
  editionOnAccount: (id, parts) => call("edition_on_account", { id, parts }),
  xboxStoreSearch: (query, language) => call("xbox_store_search", { query, language }),
  steamStoreSearch: (query) => call("steam_store_search", { query, language: steamLanguage() }),
  xboxStoreHome: (language) => call("xbox_store_home", { language }),
  xboxStorePage: (list, genre, page, language) => call("xbox_store_page", { list, genre, page, language }),
  async readClipboard() {
    const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
    return (await readText()) ?? "";
  },
  on(event, cb) {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    import("@tauri-apps/api/event").then(({ listen }) =>
      listen(event, (e) => cb(e.payload)).then((u) => (cancelled ? u() : (unlisten = u))),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  },
  async appVersion() {
    const { getVersion } = await import("@tauri-apps/api/app");
    return getVersion();
  },
  async checkUpdate() {
    const { check } = await import("@tauri-apps/plugin-updater");
    const started = Date.now();
    try {
      pendingUpdate = await check({ timeout: CHECK_TIMEOUT });
    } catch (e) {
      // The updater's text for a timeout names the URL and not the reason.
      if (Date.now() - started >= CHECK_TIMEOUT - 1000) throw "GitHub isn't answering";
      throw e;
    }
    return pendingUpdate?.version ?? null;
  },
  async installUpdate(onProgress, beforeInstall) {
    const update = pendingUpdate;
    if (!update) return;
    let downloaded = 0;
    let total: number | null = null;
    await new Promise<void>((resolve, reject) => {
      // Rust goes on until DOWNLOAD_TIMEOUT; what it brings after this is simply not used.
      let stall = 0;
      const wait = () => {
        clearTimeout(stall);
        stall = window.setTimeout(() => reject("the download stopped"), DOWNLOAD_STALL);
      };
      wait();
      update
        .download(
          (e) => {
            wait();
            if (e.event === "Started") total = e.data.contentLength ?? null;
            else if (e.event === "Progress") downloaded += e.data.chunkLength;
            // All of it is in, whatever the server said the size would be: the installer is next.
            else total = downloaded;
            onProgress(downloaded, total);
          },
          { timeout: DOWNLOAD_TIMEOUT },
        )
        .then(resolve, reject)
        .finally(() => clearTimeout(stall));
    });
    await beforeInstall();
    // On Windows the installer closes the app itself and starts the new version.
    await update.install();
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  },
};

export const api: Api = isTauri ? tauriApi : mockApi;

/** Local files go through Tauri's asset protocol; URLs pass through untouched. */
export function toSrc(path: string): string {
  if (/^(https?|data|blob|asset):/i.test(path)) return path;
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc(p: string, proto?: string): string } })
    .__TAURI_INTERNALS__;
  return internals ? internals.convertFileSrc(path, "asset") : path;
}
