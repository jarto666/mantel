export type Source = "steam" | "epic" | "gog" | "xbox" | "ubisoft" | "custom";

export interface Art {
  cover: string[];
  hero: string[];
  logo: string[];
  icon: string[];
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
}

export interface PickEntry {
  name: string;
  path: string;
  kind: "drive" | "place" | "dir" | "exe" | "lnk" | "url" | "bat";
  size?: number | null;
}

export interface Listing {
  path: string | null;
  parent: string | null;
  entries: PickEntry[];
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
}

export interface Details {
  description?: string | null;
  genres: string[];
  developers?: string[] | null;
  publishers?: string[] | null;
  releaseDate?: string | null;
  metacritic?: number | null;
  screenshots: string[];
  background?: string | null;
}

export interface Running {
  id: string;
  startedAt: number;
  detected: boolean;
}

export interface Power {
  hasBattery: boolean;
  percent?: number | null;
  charging: boolean;
}
