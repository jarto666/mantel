// Stand-in backend for developing the UI in a regular browser.
import type { Api, GameEvent } from "./api";
import type { Achievements, Art, Game, Running, Settings, Source } from "./types";

const cdn = (id: number): Art => {
  const base = `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}`;
  return {
    cover: [`${base}/library_600x900_2x.jpg`, `${base}/library_600x900.jpg`],
    hero: [`${base}/library_hero.jpg`, `${base}/header.jpg`],
    logo: [`${base}/logo.png`],
    icon: [`${base}/header.jpg`],
  };
};
const none: Art = { cover: [], hero: [], logo: [], icon: [] };

const DAY = 86400;
const now = Math.floor(Date.now() / 1000);

type Seed = [Source, string, number | null, number, number | null];
// source, name, steam app id (for art), playtime minutes, days since last played
const seeds: Seed[] = [
  ["steam", "Cyberpunk 2077", 1091500, 6240, 0.2],
  ["steam", "Hades II", 1145350, 2710, 1],
  ["steam", "Baldur's Gate 3", 1086940, 9120, 3],
  ["steam", "Black Myth: Wukong", 2358720, 1880, 6],
  ["steam", "ELDEN RING", 1245620, 7300, 12],
  ["steam", "The Witcher 3: Wild Hunt", 292030, 11800, 40],
  ["steam", "Red Dead Redemption 2", 1174180, 4300, 25],
  ["steam", "Resident Evil 4", 2050650, 1320, 60],
  ["steam", "God of War", 1593500, 1980, 90],
  ["steam", "Stardew Valley", 413150, 5400, 8],
  ["steam", "Hollow Knight", 367520, 2200, 120],
  ["steam", "Clair Obscur: Expedition 33", 1903340, 3300, 2],
  ["steam", "Monster Hunter Wilds", 2246340, 940, 15],
  ["steam", "Path of Exile 2", 2694490, 610, null],
  ["steam", "Hogwarts Legacy", 990080, 0, null],
  ["steam", "Ghost of Tsushima", 2215430, 2600, 33],
  ["steam", "Counter-Strike 2", 730, 21000, 4],
  ["epic", "Alan Wake 2", null, 820, 18],
  ["epic", "Fortnite", null, 4100, 9],
  ["gog", "Disco Elysium", 632470, 2400, 200],
  ["xbox", "Forza Horizon 5", 1551360, 3900, 5],
  ["xbox", "Starfield", 1716740, 1200, 70],
  ["xbox", "Indiana Jones and the Great Circle", 2677660, 760, 11],
  ["ubisoft", "Prince of Persia: The Lost Crown", 2751000, 540, 45],
  ["custom", "Minecraft", null, 0, null],
];

/** Steam-style counts for some games, Xbox gamerscore (one without a total) for others. */
function achievementsFor(source: Source, i: number, minutes: number): Achievements | null {
  if (!minutes || source === "custom" || source === "epic") return null;
  if (source === "xbox") {
    const gamerscore = 120 + ((i * 290) % 880);
    return { unlocked: 4 + (i % 30), total: i % 2 ? 0 : 50, percent: Math.round(gamerscore / 10), gamerscore, gamerscoreTotal: 1000 };
  }
  const total = 20 + ((i * 13) % 60);
  const unlocked = Math.min(total, Math.round((minutes / 9000) * total) + (i % 5));
  return { unlocked, total, percent: Math.round((100 * unlocked) / total) };
}

let games: Game[] = seeds.map(([source, name, appid, minutes, days], i) => ({
  id: `${source}:${appid ?? i}`,
  source,
  sourceId: String(appid ?? i),
  name,
  installDir: `C:\\Games\\${name}`,
  art: appid ? cdn(appid) : none,
  steamAppId: appid,
  playtimeMinutes: minutes,
  lastPlayed: days == null ? null : Math.floor(now - days * DAY),
  addedAt: now - i * DAY * 3,
  favorite: [0, 2, 9, 20].includes(i),
  hidden: false,
  sizeBytes: (20 + ((i * 37) % 120)) * 1024 ** 3,
  installed: i !== 14 && i !== 16,
  achievements: achievementsFor(source, i, minutes),
}));

let settings: Settings = {
  sources: { steam: true, epic: true, gog: true, xbox: true, ubisoft: true },
  steamgriddbKey: "",
  sounds: true,
  minimizeOnLaunch: true,
  trailers: true,
};

// Real Steam trailers (DASH), so the player can be tried in the browser too.
const VIDEO = "https://video.akamai.steamstatic.com/store_trailers";
const trailers: Record<number, string> = {
  1091500: `${VIDEO}/1091500/319068602/a0e7ceceecf759bf446feac0658b6fe58a970b94/1792676918/dash_h264.mpd`,
  1145350: `${VIDEO}/1145350/1067641820/dfba9c6a8b09f5bd9b323d6e699ac685065b93d3/1758924611/dash_h264.mpd`,
  1086940: `${VIDEO}/1086940/637951/59ca25b847b0e471638d1e2474acf71b068d57f0/1750615003/dash_h264.mpd`,
  1551360: `${VIDEO}/1551360/442268/66eddb8cdf196bf7c8d9bb8e8895bd7f60133cc1/1750700745/dash_h264.mpd`,
  1903340: `${VIDEO}/1903340/876247/5c4709c3a98d932003a6b85bd5e4bfcd6a777e7a/1748581603/dash_h264.mpd`,
};

let running: Running | null = null;
let steamKey = "";
let xboxTag: string | null = null;
let autostart = false;
const listeners = new Map<GameEvent, Set<(p: unknown) => void>>();
const emit = (e: GameEvent, payload: unknown) => listeners.get(e)?.forEach((cb) => cb(payload));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockApi: Api = {
  async getLibrary(rescan) {
    if (rescan) await wait(900);
    return structuredClone(games);
  },
  async resolveArt() {
    return false;
  },
  async measureSizes() {
    return false;
  },
  async getDetails(id) {
    const g = games.find((x) => x.id === id);
    if (!g?.steamAppId) return null;
    await wait(250);
    return {
      description:
        "Demo description: in the app this comes from the Steam store. Right now the interface is running in a browser with a sample library.",
      genres: ["Action", "RPG", "Adventure"],
      developers: ["Studio"],
      releaseDate: "2024",
      metacritic: 80 + (g.name.length % 15),
      screenshots: [...g.art.hero.slice(0, 1), ...g.art.icon],
      trailer: trailers[g.steamAppId] ?? null,
    };
  },
  async setFlag(id, flag, value) {
    games = games.map((g) => (g.id === id ? { ...g, [flag]: value } : g));
  },
  async getSettings() {
    return structuredClone(settings);
  },
  async saveSettings(s) {
    settings = structuredClone(s);
  },
  async addCustomGame(path, name) {
    const stem = path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
    games = [...games, { ...games[24], id: `custom:${Date.now()}`, sourceId: String(Date.now()), name: name ?? stem, installDir: path, favorite: false }];
    return structuredClone(games);
  },
  async renameCustomGame(id, name) {
    games = games.map((g) => (g.id === id ? { ...g, name } : g));
    return structuredClone(games);
  },
  async listDir(path) {
    await wait(150);
    if (!path)
      return {
        path: null,
        parent: null,
        entries: [
          { name: "Desktop", path: "C:\\Users\\you\\Desktop", kind: "place" },
          { name: "Program Files (x86) (C:)", path: "C:\\Program Files (x86)", kind: "place" },
          { name: "Drive C:", path: "C:\\", kind: "drive" },
        ],
      };
    return {
      path,
      parent: path.length > 3 ? path.replace(/\\[^\\]+$/, "") || "C:\\" : null,
      entries: [
        { name: "Dying Light 2 Stay Human", path: `${path}\\Dying Light 2 Stay Human`, kind: "dir" },
        { name: "Emulators", path: `${path}\\Emulators`, kind: "dir" },
        { name: "DyingLightGame_x64_rwdi.exe", path: `${path}\\DyingLightGame_x64_rwdi.exe`, kind: "exe", size: 412_000_000 },
        { name: "unins000.exe", path: `${path}\\unins000.exe`, kind: "exe", size: 3_200_000 },
      ],
    };
  },
  async appSuggestions() {
    await wait(600);
    return [
      { name: "Battle.net", path: "C:\\ProgramData\\Start Menu\\Battle.net.lnk", target: "C:\\Program Files (x86)\\Battle.net\\Battle.net Launcher.exe" },
      { name: "Dying Light 2 Stay Human", path: "C:\\Users\\you\\Desktop\\Dying Light 2.lnk", target: "C:\\Games\\DL2\\DyingLightGame_x64_rwdi.exe" },
      { name: "RetroArch", path: "C:\\RetroArch\\RetroArch.lnk", target: "C:\\RetroArch\\retroarch.exe" },
    ];
  },
  async switchToGame() {
    return false;
  },
  async removeCustomGame(id) {
    games = games.filter((g) => g.id !== id);
    return structuredClone(games);
  },
  async launchGame(id) {
    running = { id, startedAt: Math.floor(Date.now() / 1000), detected: false };
    setTimeout(() => {
      if (running?.id !== id) return;
      running.detected = true;
      emit("game-started", id);
    }, 2600);
  },
  async closeGame() {
    if (!running) return;
    const { id, startedAt } = running;
    running = null;
    const seconds = Math.floor(Date.now() / 1000) - startedAt;
    games = games.map((g) =>
      g.id === id ? { ...g, lastPlayed: Math.floor(Date.now() / 1000), playtimeMinutes: g.playtimeMinutes + Math.round(seconds / 60) } : g,
    );
    setTimeout(() => emit("game-stopped", { id, seconds }), 400);
  },
  async runningGame() {
    return running;
  },
  async openGameFolder() {},
  async powerStatus() {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
    if (nav.getBattery) {
      const b = await nav.getBattery();
      return { hasBattery: true, percent: Math.round(b.level * 100), charging: b.charging };
    }
    return { hasBattery: true, percent: 76, charging: false };
  },
  async powerAction(action) {
    console.info("[mock] power action", action);
  },
  async fullScreenMode() {
    return { supported: false, active: false, canSwitch: false, offered: false, home: false };
  },
  async getAutostart() {
    return autostart;
  },
  async setAutostart(on) {
    autostart = on;
  },
  async accountsStatus() {
    return { steam: { user: "player", connected: steamKey !== "", owned: steamKey ? 214 : 0 }, xboxGamertag: xboxTag };
  },
  async xboxSignIn() {
    await wait(2500);
    xboxTag = "Ellion";
    return mockApi.accountsStatus();
  },
  async steamSignIn() {
    await wait(2500);
    steamKey = "session";
    return mockApi.accountsStatus();
  },
  async disconnectAccount(service) {
    if (service === "xbox") xboxTag = null;
    else steamKey = "";
    return mockApi.accountsStatus();
  },
  async openUrl(url) {
    window.open(url, "_blank");
  },
  async readClipboard() {
    return navigator.clipboard?.readText?.().catch(() => "") ?? "";
  },
  async appVersion() {
    return "0.1.0";
  },
  async checkUpdate() {
    return null;
  },
  async installUpdate() {},
  log(level, message) {
    console[level === "error" ? "error" : level === "warn" ? "warn" : "info"]("[mantel]", message);
  },
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    return () => listeners.get(event)?.delete(cb);
  },
};
