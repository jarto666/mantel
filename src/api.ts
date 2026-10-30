import type { AccountsStatus, Achievement, Details, Game, Listing, Power, Running, Settings, Suggestion } from "./types";
import { mockApi } from "./mock";

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
  /** The game's achievements from the Steam or Xbox account it came from. */
  getAchievements(id: string): Promise<Achievement[]>;
  setFlag(id: string, flag: "favorite" | "hidden", value: boolean): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Settings): Promise<void>;
  addCustomGame(path: string, name?: string, target?: string): Promise<Game[]>;
  renameCustomGame(id: string, name: string): Promise<Game[]>;
  listDir(path: string | null): Promise<Listing>;
  appSuggestions(): Promise<Suggestion[]>;
  switchToGame(): Promise<boolean>;
  removeCustomGame(id: string): Promise<Game[]>;
  launchGame(id: string): Promise<void>;
  closeGame(): Promise<void>;
  runningGame(): Promise<Running | null>;
  openGameFolder(id: string): Promise<void>;
  powerStatus(): Promise<Power>;
  powerAction(action: "shutdown" | "restart" | "desktop" | "fullscreen" | "home-app-settings" | "quit"): Promise<void>;
  /** Windows' full screen experience (Xbox mode): whether it's on and whether we can toggle it. */
  fullScreenMode(): Promise<FullScreenMode>;
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
  readClipboard(): Promise<string>;
  appVersion(): Promise<string>;
  /** The version of a newer release, or null when up to date. */
  checkUpdate(): Promise<string | null>;
  /** Installs the release found by checkUpdate and restarts into it. */
  installUpdate(): Promise<void>;
}

export type GameEvent = "game-started" | "game-stopped" | "game-launch-timeout";

export interface FullScreenMode {
  supported: boolean;
  active: boolean;
  canSwitch: boolean;
  /** Windows lists Mantel among home apps (installed with Developer Mode on). */
  offered: boolean;
  /** The user picked Mantel as the home app. */
  home: boolean;
}

let pendingUpdate: import("@tauri-apps/plugin-updater").Update | null = null;

const tauriApi: Api = {
  getLibrary: (rescan) => call("get_library", { rescan }),
  resolveArt: () => call("resolve_art"),
  measureSizes: () => call("measure_sizes"),
  getDetails: (id) => call("get_details", { id }),
  getAchievements: (id) => call("get_achievements", { id }),
  setFlag: (id, flag, value) => call("set_flag", { id, flag, value }),
  getSettings: () => call("get_settings"),
  saveSettings: (settings) => call("save_settings", { settings }),
  addCustomGame: (path, name, target) => call("add_custom_game", { path, name: name ?? null, target: target ?? null }),
  renameCustomGame: (id, name) => call("rename_custom_game", { id, name }),
  listDir: (path) => call("list_dir", { path }),
  appSuggestions: () => call("app_suggestions"),
  switchToGame: () => call("switch_to_game"),
  removeCustomGame: (id) => call("remove_custom_game", { id }),
  launchGame: (id) => call("launch_game", { id }),
  closeGame: () => call("close_game"),
  runningGame: () => call("running_game"),
  openGameFolder: (id) => call("open_game_folder", { id }),
  powerStatus: () => call("power_status"),
  powerAction: (action) => call("power_action", { action }),
  fullScreenMode: () => call("full_screen_mode"),
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
    pendingUpdate = await check();
    return pendingUpdate?.version ?? null;
  },
  async installUpdate() {
    if (!pendingUpdate) return;
    // On Windows the installer closes the app itself and starts the new version.
    await pendingUpdate.downloadAndInstall();
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
