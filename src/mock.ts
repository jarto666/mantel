// Stand-in backend for developing the UI in a regular browser.
import type { Api, GameEvent } from "./api";
import type { Achievements, AppChoice, Art, Game, Quick, Running, Settings, Source } from "./types";

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
  ["epic", "Death Stranding", 1190460, 820, 18],
  ["epic", "Control", 870780, 4100, 9],
  ["gog", "Disco Elysium", 632470, 2400, 200],
  ["xbox", "Forza Horizon 5", 1551360, 3900, 5],
  ["xbox", "Starfield", 1716740, 1200, 70],
  ["xbox", "Indiana Jones and the Great Circle", 2677660, 760, 11],
  ["ubisoft", "Prince of Persia: The Lost Crown", 2751000, 540, 45],
  ["custom", "Celeste", 504230, 0, null],
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

// Apps for the browser: the real thing reads icons and colours from the installed apps.
const wiki = (path: string) => `https://upload.wikimedia.org/wikipedia/commons/thumb/${path}/330px-${path.split("/").pop()}.png`;
const ICONS = {
  spotify: wiki("8/84/Spotify_icon.svg"),
  discord: wiki("a/a2/Discord_logo_simplified.svg"),
  youtube: wiki("0/09/YouTube_full-color_icon_%282017%29.svg"),
  netflix: wiki("1/18/Netflix_2016_N_logo.svg"),
  twitch: wiki("d/d3/Twitch_Glitch_Logo_Purple.svg"),
  plex: wiki("7/7b/Plex_logo_2022.svg"),
  vlc: wiki("e/e6/VLC_Icon.svg"),
  edge: wiki("9/98/Microsoft_Edge_logo_%282019%29.svg"),
  chrome: wiki("e/e1/Google_Chrome_icon_%28February_2022%29.svg"),
  firefox: wiki("a/a0/Firefox_logo%2C_2019.svg"),
  disney: wiki("3/3e/Disney%2B_logo.svg"),
};
const app = (name: string, icon: string | null, color: string, site: string | null, days: number | null): Game => ({
  id: `app:${name.toLowerCase().replace(/\W+/g, "-")}`,
  source: "custom",
  sourceId: name,
  name,
  art: { cover: [], hero: [], logo: [], icon: icon ? [icon] : [] },
  playtimeMinutes: 0,
  lastPlayed: days == null ? null : Math.floor(now - days * DAY),
  favorite: false,
  hidden: false,
  installed: true,
  kind: "app",
  color,
  site,
});
games.push(
  app("Spotify", ICONS.spotify, "#121212", null, 0.1),
  app("YouTube", ICONS.youtube, "#0f0f0f", "youtube.com", 0.4),
  app("Discord", ICONS.discord, "#5865f2", null, 1),
  app("Netflix", ICONS.netflix, "#000000", null, 3),
  app("Twitch", ICONS.twitch, "#18181b", "twitch.tv", 5),
  app("Disney+", ICONS.disney, "#eef2fb", null, 20),
  app("Plex", ICONS.plex, "#1f1f1f", null, null),
  app("Microsoft Edge", ICONS.edge, "#0a2540", null, null),
);

const appChoices: AppChoice[] = [
  { name: "VLC media player", target: "VideoLAN.VLC", kind: "desktop", icon: ICONS.vlc, color: "#2b2b2b" },
  { name: "Google Chrome", target: "Chrome", kind: "desktop", icon: ICONS.chrome, color: "#1f1f1f" },
  { name: "Firefox", target: "308046B0AF4A39CB", kind: "desktop", icon: ICONS.firefox, color: "#20123a" },
  { name: "Moonlight", target: "Moonlight", kind: "desktop" },
  { name: "WhatsApp", target: "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App", kind: "store", color: "#0b141a" },
  { name: "YouTube Music", target: "https://music.youtube.com", kind: "site", icon: ICONS.youtube, color: "#030303" },
  { name: "Xbox Cloud Gaming", target: "https://www.xbox.com/play", kind: "site", color: "#107c10" },
  { name: "GeForce NOW", target: "https://play.geforcenow.com", kind: "site", color: "#1a1a1a" },
];

const pickedArt: Record<string, string> = {};
const installing = new Set<string>();

const catalog: Game[] = (
  [
    ["Forza Horizon 5 Standard Edition", 1551360],
    ["Hollow Knight: Silksong", 1030300],
    ["Celeste", 504230],
    ["Vampire Survivors", 1794680],
    ["It Takes Two", 1426210],
    ["Balatro", 2379780],
    ["Dave the Diver", 1868140],
    ["Dead Cells", 588650],
  ] as const
).map(([name, appid]) => ({
  ...games[0],
  id: `gamepass:${appid}`,
  source: "xbox",
  sourceId: "",
  name,
  art: cdn(appid),
  steamAppId: appid,
  playtimeMinutes: 0,
  lastPlayed: null,
  favorite: false,
  installed: false,
  sizeBytes: (3 + name.length * 3) * 1024 ** 3,
  achievements: null,
  tags: name === "Hollow Knight: Silksong" ? ["new", "popular"] : name === "Dead Cells" ? ["leaving"] : name === "It Takes Two" ? ["eaplay", "popular"] : ["new"],
  genres: ["Action & adventure", ...(["Celeste", "Hollow Knight: Silksong", "Dead Cells"].includes(name) ? ["Platformer"] : [])],
}));

// Store shelves for the browser: real art, made-up prices.
const storeSeeds: [string, number, string, number?][] = [
  ["Hades", 1145360, "$24.99"],
  ["HELLDIVERS 2", 553850, "$39.99"],
  ["Palworld", 1623730, "$29.99"],
  ["Sekiro: Shadows Die Twice", 814380, "$23.99", 60],
  ["Street Fighter 6", 1364780, "$23.99", 60],
  ["TEKKEN 8", 1778820, "$34.99", 50],
  ["Split Fiction", 2001120, "$49.99"],
  ["Persona 3 Reload", 2161700, "$27.99", 60],
  ["Metaphor: ReFantazio", 2679460, "$41.99", 40],
  ["SILENT HILL 2", 2124490, "$41.99", 40],
  ["Lethal Company", 1966720, "$9.99"],
  ["Sea of Thieves", 1172620, "$19.99", 50],
  ["Slay the Spire", 646570, "$6.24", 75],
  ["Portal 2", 620, "$0.99", 90],
  ["DOOM Eternal", 782330, "$9.99", 75],
  ["Control Ultimate Edition", 870780, "$7.99", 80],
  ["Dead Space", 1693980, "$14.99", 75],
  ["Factorio", 427520, "$35.00"],
  ["Sid Meier's Civilization VI", 289070, "$5.99", 90],
  ["Terraria", 105600, "$4.99", 50],
];
const xboxSeeds: [string, string, number][] = [["Cyberpunk 2077: Ultimate Edition", "CYBERULT0000", 1091500], ["Ori and the Will of the Wisps", "ORIWISPS0000", 1057090]];
const xboxList = (): Game[] =>
  xboxSeeds.map(([name, id, appid]) => ({ ...storeList[0], id: `msstore:${id}`, source: "xbox", sourceId: "", name, art: cdn(appid), steamAppId: null, price: "$31.99", discount: null, tags: ["store"] }));
const storeList: Game[] = storeSeeds.map(([name, appid, price, discount]) => ({
  ...games[0],
  id: `steam:${appid}`,
  source: "steam",
  sourceId: String(appid),
  name,
  art: cdn(appid),
  steamAppId: appid,
  playtimeMinutes: 0,
  lastPlayed: null,
  favorite: false,
  installed: false,
  sizeBytes: null,
  achievements: null,
  tags: ["store"],
  genres: ["Action", "Adventure"],
  price,
  discount: discount ?? null,
}));

let settings: Settings = {
  sources: { steam: true, epic: true, gog: true, xbox: true, ubisoft: true },
  steamgriddbKey: "",
  language: "",
  gamePass: true,
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

const SAMPLE_ACHIEVEMENTS = ["First Steps", "Night Owl", "Collector", "Untouchable", "Speed Demon", "Completionist", "Explorer", "Sharpshooter"];

let quick: Quick = { volume: 45, muted: false, brightness: 80, wifi: { connected: true, name: "Home Wi-Fi", signal: 72 } };
let running: Running[] = [];
let steamKey = "";
let xboxTag: string | null = null;
let autostart = false;
/** As on the Ally: Xbox mode, Developer Mode off, so setup has the home app to offer. */
const fullScreen = { supported: true, active: false, canSwitch: false, offered: false, home: false, developerMode: false };
const listeners = new Map<GameEvent, Set<(p: unknown) => void>>();
const emit = (e: GameEvent, payload: unknown) => listeners.get(e)?.forEach((cb) => cb(payload));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const mockApi: Api = {
  async getLibrary(rescan) {
    if (rescan) await wait(900);
    // ?mockGames=none, or a list such as ?mockGames=epic,gog: a PC with fewer stores, for empty states.
    const only = new URLSearchParams(location.search).get("mockGames");
    const kept = only === null ? games : games.filter((g) => only.split(",").includes(g.source));
    return structuredClone(kept);
  },
  async resolveArt() {
    return false;
  },
  async measureSizes() {
    return false;
  },
  async getDetails(id) {
    const g = games.find((x) => x.id === id) ?? catalog.find((x) => x.id === id) ?? storeList.find((x) => x.id === id) ?? xboxList().find((x) => x.id === id);
    if (!g?.steamAppId) return null;
    await wait(250);
    return {
      description:
        g.name === "Hades II"
          ? "Fight through the Underworld and beyond as its immortal princess, with a new mix of magic and weapons on every run."
          : "A sample game, for trying the interface in a browser.",
      genres: ["Action", "RPG", "Adventure"],
      features: ["Single player", "Online co-op", "Cross-platform", "Controller support", "Cloud saves", "Achievements"],
      videos: [{ url: "https://cdn.trailers.xboxservices.com/none/manifest.mpd", thumb: g?.art.hero[0], title: "Official trailer" }],
      items: g?.name === "Celeste" ? [
        { id: "9MOCKGAME001", title: g.name, kind: "main", size: 12 * 1024 ** 3 },
        { id: "9MOCKADDON01", title: `${g.name}: Farewell`, kind: "addon", size: null },
        { id: "9MOCKADDON02", title: `${g.name}: Soundtrack`, kind: "addon", size: 300 * 1024 ** 2 },
      ] : undefined,
      developers: [g.name === "Hades II" ? "Supergiant Games" : "Sample Studio"],
      releaseDate: "2024",
      metacritic: 80 + (g.name.length % 15),
      screenshots: [...g.art.hero.slice(0, 1), ...g.art.icon],
      trailer: trailers[g.steamAppId] ?? null,
    };
  },
  async getAchievements(id) {
    const g = games.find((x) => x.id === id);
    const a = g?.achievements;
    if (!g || !a) throw "Achievements come from Steam and Xbox accounts";
    await wait(500);
    const total = a.total || 40;
    const unlocked = a.total ? a.unlocked : Math.round((total * a.percent) / 100);
    return Array.from({ length: total }, (_, i) => ({
      name: `${SAMPLE_ACHIEVEMENTS[i % SAMPLE_ACHIEVEMENTS.length]}${i >= SAMPLE_ACHIEVEMENTS.length ? ` ${Math.floor(i / SAMPLE_ACHIEVEMENTS.length) + 1}` : ""}`,
      description: "Demo achievement: in the app this comes from your Steam or Xbox account.",
      icon: null,
      unlocked: i < unlocked,
      unlockedAt: i < unlocked ? now - i * DAY : null,
      rarity: Math.round(((i * 37) % 90) * 10 + 7) / 10,
      gamerscore: g.source === "xbox" ? 10 + (i % 4) * 5 : null,
      secret: i >= unlocked && i % 7 === 3,
    }));
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
  async listDir(path, images) {
    await wait(150);
    if (images)
      return {
        path,
        parent: null,
        entries: path
          ? [
              { name: "Wallpapers", path: `${path}\\Wallpapers`, kind: "dir" },
              { name: "fc27-cover.png", path: `${path}\\fc27-cover.png`, kind: "image", size: 812_000 },
              { name: "screenshot.jpg", path: `${path}\\screenshot.jpg`, kind: "image", size: 1_412_000 },
            ]
          : [
              { name: "Pictures", path: "C:\\Users\\you\\Pictures", kind: "place" },
              { name: "Downloads", path: "C:\\Users\\you\\Downloads", kind: "place" },
            ],
      };
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
  async installGame(id) {
    const game = catalog.find((g) => g.id === id) ?? (id.startsWith("msstore:") ? { ...xboxList()[0], id, sourceId: "Mock.Game_abc", sizeBytes: 8 * 1024 ** 3 } : undefined);
    if (!game) throw "Only Store games install from Mantel";
    installing.add(id);
    let percent = 0;
    const total = game.sizeBytes ?? 8 * 1024 ** 3;
    const bytes = () => ({ downloaded: (total * percent) / 100, total });
    emit("install-progress", { id, state: "pending", percent, ...bytes() });
    const tick = setInterval(() => {
      if (!installing.has(id)) {
        clearInterval(tick);
        return emit("install-progress", { id, state: "canceled", percent, ...bytes() });
      }
      percent = Math.min(100, percent + 9);
      if (percent < 100) return emit("install-progress", { id, state: "downloading", percent, ...bytes() });
      clearInterval(tick);
      installing.delete(id);
      games = [...games, { ...game, id: `xbox:${id}`, installed: true, tags: [] }];
      emit("install-progress", { id, state: "done", percent, ...bytes() });
    }, 600);
  },
  async cancelInstall(id) {
    installing.delete(id);
  },
  async installs() {
    return [];
  },
  async installsUnderWay() {
    return [];
  },
  async installAccess(id) {
    await wait(500);
    return catalog.find((g) => g.id === id)?.name !== "Dead Cells";
  },
  async uninstallGame(id) {
    await wait(1500);
    games = games.filter((g) => g.id !== id);
    emit("game-uninstalled", id);
  },
  async gamepassCatalog() {
    await wait(400);
    return structuredClone(catalog);
  },
  async artChoices(id, kind) {
    await wait(500);
    const picked = pickedArt[`${id}:${kind}`] ?? null;
    const options = games.filter((g) => g.id !== id && g.art[kind].length).map((g) => ({ url: g.art[kind][0], thumb: g.art[kind].at(-1)! }));
    return { picked, options: settings.steamgriddbKey ? options : [], connected: !!settings.steamgriddbKey };
  },
  async setArt(id, kind, src) {
    const key = `${id}:${kind}`;
    const old = pickedArt[key];
    if (src) pickedArt[key] = src;
    else delete pickedArt[key];
    games = games.map((g) =>
      g.id === id ? { ...g, art: { ...g.art, [kind]: [...(src ? [src] : []), ...g.art[kind].filter((s) => s !== old)] } } : g,
    );
    return structuredClone(games);
  },
  async appSuggestions() {
    await wait(600);
    return [
      { name: "Battle.net", path: "C:\\ProgramData\\Start Menu\\Battle.net.lnk", target: "C:\\Program Files (x86)\\Battle.net\\Battle.net Launcher.exe" },
      { name: "Dying Light 2 Stay Human", path: "C:\\Users\\you\\Desktop\\Dying Light 2.lnk", target: "C:\\Games\\DL2\\DyingLightGame_x64_rwdi.exe" },
      { name: "RetroArch", path: "C:\\RetroArch\\RetroArch.lnk", target: "C:\\RetroArch\\retroarch.exe" },
    ];
  },
  async appChoices() {
    await wait(500);
    return appChoices.filter((c) => !games.some((g) => g.kind === "app" && g.name === c.name));
  },
  async addApp(target) {
    await wait(300);
    const choice = appChoices.find((c) => c.target === target)!;
    const site = choice.kind === "site" ? new URL(choice.target).hostname.replace(/^www\./, "") : null;
    games.push({ ...app(choice.name, choice.icon ?? null, choice.color ?? "#1a1d26", site, null), addedAt: now });
    return structuredClone(games);
  },
  async addAppFile(path) {
    await wait(300);
    const name = path.split("\\").pop()!.replace(/\.(exe|lnk|url|bat|cmd)$/i, "");
    games.push({ ...app(name, null, "#1a1d26", null, null), addedAt: now });
    return structuredClone(games);
  },
  async removeApp(id) {
    games = games.filter((g) => g.id !== id);
    return structuredClone(games);
  },
  async switchToGame(id) {
    return running.some((r) => r.id === id && r.detected);
  },
  async removeCustomGame(id) {
    games = games.filter((g) => g.id !== id);
    return structuredClone(games);
  },
  async launchGame(id) {
    if (id.startsWith("gamepass:")) return;
    // As the backend does: one launch waits at a time, games already running stay.
    running = running.filter((r) => r.detected && r.id !== id);
    const launch = { id, startedAt: Math.floor(Date.now() / 1000), detected: false };
    running.push(launch);
    setTimeout(() => {
      if (!running.includes(launch)) return;
      launch.detected = true;
      emit("game-started", id);
    }, 2600);
  },
  async closeGame(id) {
    const game = running.find((r) => r.id === id);
    if (!game) return;
    // A game takes a moment to save and quit, as on a device.
    await wait(1500);
    const { startedAt } = game;
    running = running.filter((r) => r !== game);
    const seconds = Math.floor(Date.now() / 1000) - startedAt;
    games = games.map((g) =>
      g.id === id ? { ...g, lastPlayed: Math.floor(Date.now() / 1000), playtimeMinutes: g.playtimeMinutes + Math.round(seconds / 60) } : g,
    );
    setTimeout(() => emit("game-stopped", { id, seconds }), 1200);
  },
  async runningGames() {
    return structuredClone(running);
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
  async quickStatus() {
    return structuredClone(quick);
  },
  async setVolume(level) {
    quick = { ...quick, volume: level, muted: level > 0 ? false : quick.muted };
  },
  async setMuted(muted) {
    quick = { ...quick, muted };
  },
  async setBrightness(level) {
    quick = { ...quick, brightness: level };
  },
  async powerAction(action) {
    console.info("[mock] power action", action);
  },
  async fullScreenMode() {
    return { ...fullScreen };
  },
  async makeHomeApp() {
    // Stands in for Windows' permission prompt.
    await wait(1800);
    Object.assign(fullScreen, { developerMode: true, offered: true, home: true });
    return { ...fullScreen };
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
  async openSteamDownloads() {},
  async openSteamStore() {},
  async resolveSteamFacts() {
    return false;
  },
  async steamStoreHome() {
    await wait(300);
    const shelves = [
      { id: "top", title: "Top sellers", games: storeList.slice(0, 7) },
      { id: "new", title: "New releases", games: storeList.slice(6, 14) },
      { id: "deals", title: "Deals", games: storeList.filter((g) => g.discount) },
    ];
    const genres = ["Action", "Adventure", "RPG", "Strategy", "Simulation", "Shooter", "Racing", "Sports", "Puzzle"].map((name, i) => ({ tag: i + 1, name }));
    return { shelves, genres };
  },
  async steamStorePage(_list, _tag, start) {
    await wait(300);
    return { games: storeList.slice(start, start + 12), more: start + 12 < storeList.length };
  },
  async openXboxStore() {},
  async xboxEditions(id) {
    const product = id.replace("msstore:", "").replace("xbox:", "");
    return {
      game: "BASE00000000",
      pfn: "Mock.Game_abc",
      title: xboxList().find((g) => g.id === id)?.name ?? product,
      editions: [
        { id: "BASE00000000", title: "Standard Edition", price: 29.99, was: 59.99, currency: "USD", parts: [] },
        { id: "DELUXE000000", title: "Deluxe Edition", price: 79.99, was: 79.99, currency: "USD", parts: ["BASE00000000", "ADDON0000000"] },
      ],
    };
  },
  async editionOnAccount(id) {
    await new Promise((r) => setTimeout(r, 300));
    return id === "BASE00000000";
  },
  async xboxStoreSearch(query) {
    const q = query.toLowerCase();
    return xboxList()
      .filter((g) => g.name.toLowerCase().includes(q))
      .map((game) => ({ game, price: 29.99, was: 59.99, currency: "USD" }));
  },
  async steamStoreSearch(query) {
    const q = query.toLowerCase();
    return storeList.filter((g) => g.source === "steam" && g.name.toLowerCase().includes(q));
  },
  async xboxStoreHome() {
    return [{ id: "top", title: "Top sellers", games: xboxList() }];
  },
  async xboxStorePage() {
    return { games: xboxList(), more: false };
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
    // ?mockUpdate shows the update offer and the update screen in the browser.
    return new URLSearchParams(location.search).has("mockUpdate") ? "0.4.0" : null;
  },
  async installUpdate(onProgress, beforeInstall) {
    const total = 96 * 1024 ** 2;
    for (let step = 0; step <= 40; step++) {
      onProgress(Math.round((total * step) / 40), total);
      await wait(75);
    }
    await beforeInstall();
    await wait(600);
  },
  log(level, message) {
    console[level === "error" ? "error" : level === "warn" ? "warn" : "info"]("[mantel]", message);
  },
  on(event, cb) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(cb);
    return () => listeners.get(event)?.delete(cb);
  },
};
