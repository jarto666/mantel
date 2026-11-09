export type Source = "steam" | "epic" | "gog" | "xbox" | "ubisoft" | "custom";

export interface Art {
  cover: string[];
  hero: string[];
  logo: string[];
  icon: string[];
}

export interface Achievements {
  unlocked: number;
  /** 0 when the store doesn't say: Xbox leaves it out for many newer titles. */
  total: number;
  percent: number;
  /** Xbox only. */
  gamerscore?: number | null;
  gamerscoreTotal?: number | null;
}

export interface Achievement {
  name: string;
  description: string;
  icon?: string | null;
  unlocked: boolean;
  unlockedAt?: number | null;
  /** Share of players who have it, in percent. */
  rarity?: number | null;
  gamerscore?: number | null;
  /** Locked and meant to stay a surprise. */
  secret: boolean;
}

export interface Game {
  id: string;
  source: Source;
  sourceId: string;
  name: string;
  installDir?: string | null;
  art: Art;
  steamAppId?: number | null;
  playtimeMinutes: number;
  lastPlayed?: number | null;
  addedAt?: number | null;
  favorite: boolean;
  hidden: boolean;
  sizeBytes?: number | null;
  /** False for games an account owns but this device hasn't installed. */
  installed: boolean;
  achievements?: Achievements | null;
  /** Game Pass collections the game is in: "new", "leaving", "popular", "eaplay". */
  tags?: string[];
  /** Store categories, in the catalog's language. */
  genres?: string[];
  /** What it costs on the Steam store, for games from its lists; "Free" for free ones. */
  price?: string | null;
  /** Percent off that price right now. */
  discount?: number | null;
  /** "app" for programs and sites on the Apps tab; games leave it out. */
  kind?: "app" | null;
  /** An app's tile colour, its own where the app has one. */
  color?: string | null;
  /** The site an app opens, for sites added as apps. */
  site?: string | null;
}

/** Something to add on the Apps tab: an app from the Start menu, or a site. */
export interface AppChoice {
  name: string;
  /** What Windows launches it by: a Start menu app id, or the site's address. */
  target: string;
  /** A Microsoft Store app, a program, a site a browser installed as an app, or a site. */
  kind: "store" | "desktop" | "web" | "site";
  icon?: string | null;
  color?: string | null;
}

export interface StoreShelf {
  id: string;
  title: string;
  games: Game[];
}

/** The Steam store's front page and the genres to filter it by. */
export interface StoreHome {
  shelves: StoreShelf[];
  genres: { tag: number; name: string }[];
}

export interface StorePage {
  games: Game[];
  more: boolean;
}

/** A way to buy a game, as the Store sells it where the player is. */
export interface Edition {
  id: string;
  title: string;
  /** Empty when it isn't on sale here. */
  price: number | null;
  was: number | null;
  currency: string | null;
  /** What's inside a bundle: having all of it is as good as having the bundle. */
  parts: string[];
}

export interface Editions {
  /** The product with the files, which is what installs: many editions have none of their own. */
  game: string;
  pfn: string;
  title: string;
  editions: Edition[];
}

export interface StoreHit {
  game: Game;
  price: number | null;
  was: number | null;
  currency: string | null;
}

export interface InstallProgress {
  id: string;
  state: "pending" | "downloading" | "installing" | "paused" | "canceling" | "done" | "canceled" | "error";
  percent: number;
  /** Bytes so far and in all; 0 until Windows knows. */
  downloaded: number;
  total: number;
  /** Bytes per second, worked out here from one report to the next. */
  speed?: number;
  at?: number;
  error?: string | null;
}

export interface PickEntry {
  name: string;
  path: string;
  kind: "drive" | "place" | "dir" | "exe" | "lnk" | "url" | "bat" | "image";
  size?: number | null;
}

export interface Listing {
  path: string | null;
  parent: string | null;
  entries: PickEntry[];
}

export type ArtKind = "cover" | "hero" | "logo";

export interface ArtChoices {
  /** The image picked before, if any: an https URL or a copied file. */
  picked: string | null;
  options: { url: string; thumb: string }[];
  /** Whether a SteamGridDB key is set; without one there's nothing to choose from. */
  connected: boolean;
}

export interface Suggestion {
  name: string;
  path: string;
  target: string;
}

export interface AccountsStatus {
  steam: { user: string | null; connected: boolean; owned: number };
  xboxGamertag: string | null;
}

export interface Settings {
  sources: Record<Exclude<Source, "custom">, boolean>;
  steamgriddbKey: string;
  sounds: boolean;
  minimizeOnLaunch: boolean;
  trailers: boolean;
  /** Interface language id; "" follows Windows. */
  language: string;
  /** Show the Game Pass tab. */
  gamePass: boolean;
}

/** What a bundle is made of: the "main" game, its "launcher", another "game", or an "addon". */
export interface BundleItem {
  id: string;
  title: string;
  kind: "main" | "launcher" | "game" | "addon";
  size?: number | null;
}

export interface Video {
  /** DASH manifest. */
  url: string;
  thumb?: string | null;
  title?: string | null;
}

export interface Details {
  /** A catalog game's logos, looked up on first view. */
  logo?: string[];
  videos?: Video[];
  /** How it plays: single player, co-op, controller support. */
  features?: string[];
  /** A bundle's parts, when some can be left out of the install. */
  items?: BundleItem[];
  description?: string | null;
  /** Null for games the Store hasn't filed yet, like ones still to come out. */
  genres?: string[] | null;
  developers?: string[] | null;
  publishers?: string[] | null;
  releaseDate?: string | null;
  metacritic?: number | null;
  screenshots: string[];
  background?: string | null;
  /** DASH manifest of the main trailer. */
  trailer?: string | null;
}

export interface Running {
  id: string;
  startedAt: number;
  detected: boolean;
}

/** Control center state; whatever the device lacks is left out. */
export interface Quick {
  volume?: number | null;
  muted: boolean;
  brightness?: number | null;
  wifi?: { connected: boolean; name?: string | null; signal?: number | null } | null;
}

export interface Power {
  hasBattery: boolean;
  percent?: number | null;
  charging: boolean;
}
