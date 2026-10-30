import { useEffect, useRef, useState } from "react";
import { api, type FullScreenMode } from "../api";
import { SourceIcon } from "../components/Glyph";
import { useHints } from "../components/Hints";
import { AddGame } from "../components/AddGame";
import { KeyFlow } from "../components/KeyFlow";
import { AccountFlow } from "../components/AccountFlow";
import { useScrollFocus } from "../hooks";
import { Layer, useInput } from "../input";
import { installUpdate, rescan, saveSettings, setHidden, toast, useStore } from "../store";
import { sound } from "../sound";
import type { AccountsStatus, Settings as S, Source } from "../types";

type Row =
  | { kind: "group"; label: string }
  | { kind: "toggle"; id: string; label: string; sub?: string; value: boolean; icon?: Source; set: (v: boolean) => void }
  | { kind: "button"; id: string; label: string; sub?: string; value?: string; icon?: Icon; soon?: boolean; run: () => void };

type Icon = Source | "ea" | "battlenet" | "art";
type Flow = "steam" | "xbox" | "sgdb" | "add" | null;
type Category = "library" | "accounts" | "interface" | "system";

const CATEGORIES: [Category, string, React.ReactNode][] = [
  ["library", "Library", <><rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.6" /></>],
  ["accounts", "Accounts", <><circle cx="12" cy="8.5" r="3.8" /><path d="M4.5 20c1.2-3.6 4.1-5.5 7.5-5.5s6.3 1.9 7.5 5.5" /></>],
  ["interface", "Interface", <><rect x="3" y="4.5" width="18" height="12.5" rx="2.2" /><path d="M9 20.5h6M12 17v3.5" /></>],
  ["system", "System", <><rect x="6" y="6" width="12" height="12" rx="2.2" /><path d="M9.5 2.8v3.2M14.5 2.8v3.2M9.5 18v3.2M14.5 18v3.2M2.8 9.5H6M2.8 14.5H6M18 9.5h3.2M18 14.5h3.2" /></>],
];

const MORE_STORES: [string, string, Icon][] = [
  ["epic", "Epic Games", "epic"],
  ["gog", "GOG", "gog"],
  ["ea", "EA app", "ea"],
  ["ubisoft", "Ubisoft Connect", "ubisoft"],
  ["battlenet", "Battle.net", "battlenet"],
];

function RowIcon({ icon }: { icon: Icon }) {
  if (icon === "art") {
    return (
      <svg className="source-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
        <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
        <circle cx="9" cy="9" r="1.8" />
        <path d="m20 15-4.5-4.5L6 20" />
      </svg>
    );
  }
  if (icon === "ea" || icon === "battlenet") {
    return <span className="source-icon source-text">{icon === "ea" ? "EA" : "B"}</span>;
  }
  return <SourceIcon source={icon} />;
}

const SOURCES: [Exclude<Source, "custom">, string][] = [
  ["steam", "Steam"],
  ["epic", "Epic Games"],
  ["gog", "GOG Galaxy"],
  ["xbox", "Xbox / Game Pass"],
  ["ubisoft", "Ubisoft Connect"],
];

export function Settings({ active }: { active: boolean }) {
  const settings = useStore((s) => s.settings);
  const games = useStore((s) => s.games);
  const scanning = useStore((s) => s.scanning);
  const version = useStore((s) => s.version);
  const update = useStore((s) => s.update);
  const [category, setCategory] = useState<Category>("library");
  const [zone, setZone] = useState<"categories" | "rows">("categories");
  const [index, setIndex] = useState(0);
  const [autostart, setAutostart] = useState(false);
  const [flow, setFlow] = useState<Flow>(null);
  const [accounts, setAccounts] = useState<AccountsStatus | null>(null);
  const [mode, setMode] = useState<FullScreenMode | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getAutostart().then(setAutostart).catch(() => {});
    api.accountsStatus().then(setAccounts).catch(() => {});
  }, []);

  // Again on every visit: the home app is picked in Windows' own Settings.
  useEffect(() => {
    if (active) api.fullScreenMode().then(setMode).catch(() => {});
  }, [active]);

  useEffect(() => {
    list.current?.scrollTo({ top: 0 });
  }, [category]);
  // Scrolls only when the focused row nears an edge: the lists are short, rows stay put.
  useScrollFocus(list, `${category}${zone}${index}`);

  if (!settings) return null;
  const steam = accounts?.steam;
  const patch = (p: Partial<S>) => saveSettings(p);
  const hidden = games.filter((g) => g.hidden);

  const library: Row[] = [
    {
      kind: "button",
      id: "rescan",
      label: scanning ? "Scanning…" : "Refresh library",
      sub: "Look for new installs across all launchers",
      run: () => rescan(),
    },
    {
      kind: "button",
      id: "add",
      label: "Add a game manually",
      sub: "Any .exe, shortcut or .url: games outside a store, emulators, Battle.net, EA app",
      run: () => setFlow("add"),
    },
    { kind: "group", label: "Stores on this PC" },
    ...SOURCES.map(
      ([id, label]): Row => ({
        kind: "toggle",
        id: `src-${id}`,
        label,
        sub: `Show games installed with ${label}`,
        icon: id,
        value: settings.sources[id],
        set: (v) => {
          patch({ sources: { ...settings.sources, [id]: v } }).then(() => rescan(true));
        },
      }),
    ),
    ...(hidden.length
      ? [
          { kind: "group", label: `Hidden games · ${hidden.length}` } as Row,
          ...hidden.map(
            (g): Row => ({ kind: "button", id: `hidden-${g.id}`, label: g.name, value: "Unhide", run: () => setHidden(g, false) }),
          ),
        ]
      : []),
  ];

  const accountRows: Row[] = [
    {
      kind: "button",
      id: "acc-steam",
      icon: "steam",
      label: "Steam",
      sub: steam?.connected
        ? `${steam.owned} games on ${steam.user ?? "your account"}, playtime from every device`
        : "Sign in to see every game you own and playtime from all your devices",
      value: steam?.connected ? "Connected" : "Sign in",
      run: () => setFlow("steam"),
    },
    {
      kind: "button",
      id: "acc-xbox",
      icon: "xbox",
      label: "Xbox",
      sub: accounts?.xboxGamertag
        ? `Signed in as ${accounts.xboxGamertag}: play history and minutes played`
        : "Play history and minutes played across your Xbox PC games",
      value: accounts?.xboxGamertag ? "Connected" : "Sign in",
      run: () => setFlow("xbox"),
    },
    { kind: "group", label: "Artwork" },
    {
      kind: "button",
      id: "sgdb",
      icon: "art",
      label: "SteamGridDB",
      sub: "Covers, backgrounds and logos for games Steam doesn't know: Epic exclusives, emulators, your own",
      value: settings.steamgriddbKey ? "Connected" : "Connect",
      run: () => setFlow("sgdb"),
    },
    { kind: "group", label: "More stores" },
    ...MORE_STORES.map(
      ([id, label, icon]): Row => ({ kind: "button", id: `acc-${id}`, icon, label, value: "Coming soon", soon: true, run: () => toast(`${label} accounts are coming later`) }),
    ),
  ];

  const interfaceRows: Row[] = [
    {
      kind: "toggle",
      id: "trailers",
      label: "Trailers",
      sub: "Play a muted trailer behind the game you stop on",
      value: settings.trailers,
      set: (v) => patch({ trailers: v }),
    },
    {
      kind: "toggle",
      id: "sounds",
      label: "Interface sounds",
      value: settings.sounds,
      set: (v) => patch({ sounds: v }),
    },
  ];

  const system: Row[] = [
    ...(update
      ? ([
          {
            kind: "button",
            id: "update",
            label: `Update to Mantel ${update}`,
            sub: "Installs in under a minute and restarts Mantel",
            value: "Install",
            run: () => void installUpdate(),
          },
        ] as Row[])
      : []),
    {
      kind: "toggle",
      id: "autostart",
      label: "Start with Windows",
      sub: "Boot straight into Mantel, like a console",
      value: autostart,
      set: (v) => {
        setAutostart(v);
        api.setAutostart(v).catch((e) => toast(String(e), "warn"));
      },
    },
    {
      kind: "toggle",
      id: "minimize",
      label: "Minimize while playing",
      sub: "Mantel steps aside during a game and comes back when it closes",
      value: settings.minimizeOnLaunch,
      set: (v) => patch({ minimizeOnLaunch: v }),
    },
    ...(mode?.supported
      ? ([
          { kind: "group", label: "Xbox mode" },
          {
            kind: "button",
            id: "home-app",
            label: "Home app",
            sub: mode.home
              ? "Xbox mode starts in Mantel, and Home in Game Bar comes back to it"
              : mode.offered
                ? "Pick Mantel under Home app in Windows Settings to start Xbox mode in Mantel"
                : "Turn on Developer Mode in Windows, then reinstall Mantel, to start Xbox mode in Mantel",
            value: mode.home ? "Mantel" : mode.offered ? "Choose" : "Unavailable",
            run: () =>
              mode.offered
                ? void api.powerAction("home-app-settings").catch((e) => toast(String(e), "warn"))
                : toast("Windows offers Mantel as the home app only in Developer Mode for now", "warn"),
          },
        ] as Row[])
      : []),
  ];

  const rows = { library, accounts: accountRows, interface: interfaceRows, system }[category];
  const focusable = rows.map((r, n) => (r.kind === "group" ? -1 : n)).filter((n) => n >= 0);
  const i = focusable.includes(index) ? index : focusable[0];
  const pos = focusable.indexOf(i);
  const catPos = CATEGORIES.findIndex(([id]) => id === category);

  const pick = (c: Category) => {
    setCategory(c);
    setIndex(0);
  };
  const activate = (row: Row) => {
    if (row.kind === "toggle") {
      row.set(!row.value);
      sound.toggle();
    } else if (row.kind === "button") {
      sound.select();
      row.run();
    }
  };

  return (
    <SettingsInput
      active={active && !flow}
      zone={zone}
      onMove={(d) => {
        if (zone === "categories") {
          const next = CATEGORIES[catPos + d];
          if (!next) return "edge";
          pick(next[0]);
          return;
        }
        const next = focusable[pos + d];
        if (next === undefined) return "edge";
        setIndex(next);
      }}
      onEnter={() => setZone("rows")}
      onLeave={() => setZone("categories")}
      onActivate={() => activate(rows[i])}
    >
      <main className={`settings zone-${zone}`}>
        <h1 className="page-title">Settings</h1>
        <div className="settings-body">
          <nav className="settings-cats">
            {CATEGORIES.map(([id, label, icon]) => (
              <button
                key={id}
                className={`settings-cat ${id === category ? "is-current" : ""} ${id === category && zone === "categories" ? "is-focused" : ""}`}
                onClick={() => {
                  pick(id);
                  setZone("categories");
                }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  {icon}
                </svg>
                {label}
                {id === "system" && update && <span className="settings-badge" />}
              </button>
            ))}
          </nav>
          <div className="settings-list" ref={list}>
            {rows.map((row, n) =>
              row.kind === "group" ? (
                <div className="settings-group" key={`g${n}`}>{row.label}</div>
              ) : (
                <div
                  key={row.id}
                  className={`setting ${zone === "rows" && n === i ? "is-focused" : ""} ${row.kind === "button" && row.soon ? "is-soon" : ""}`}
                  onClick={() => {
                    setZone("rows");
                    setIndex(n);
                    activate(row);
                  }}
                >
                  {row.kind === "toggle" && row.icon && <SourceIcon source={row.icon} />}
                  {row.kind === "button" && row.icon && <RowIcon icon={row.icon} />}
                  <div className="setting-text">
                    <div className="setting-label">{row.label}</div>
                    {row.sub && <div className="setting-sub">{row.sub}</div>}
                  </div>
                  {row.kind === "toggle" ? (
                    <span className={`switch ${row.value ? "on" : ""}`}><span /></span>
                  ) : (
                    row.value && <span className="setting-value">{row.value}</span>
                  )}
                </div>
              ),
            )}
            {category === "system" && <div className="settings-foot">Mantel {version} · playmantel.com</div>}
          </div>
        </div>
        {flow === "add" && <AddGame onClose={() => setFlow(null)} />}
        {flow === "steam" && (
          <AccountFlow
            copy={{
              service: "Steam",
              connectedAs: steam?.connected ? steam.user ?? "Steam account" : null,
              status: steam?.connected ? `Connected · ${steam.owned} games` : "Not signed in",
              intro: {
                connected: "Mantel sees every game you own and your playtime from all devices. Games you haven't installed are under Library → Not installed.",
                signedOut: "Adds every game you own, installed or not, and playtime from all your devices. You sign in on Steam's own page: Mantel never sees your password, and email Steam Guard codes work.",
              },
              steps: ["A Steam window opens above Mantel", "Sign in and enter the code Steam emails you", "The window closes by itself when you're in"],
              signInLabel: "Sign in with Steam",
              signIn: api.steamSignIn,
              disconnect: "steam",
            }}
            onChange={setAccounts}
            onClose={() => setFlow(null)}
          />
        )}
        {flow === "xbox" && (
          <AccountFlow
            copy={{
              service: "Xbox",
              connectedAs: accounts?.xboxGamertag ?? null,
              status: accounts?.xboxGamertag ? `Signed in as ${accounts.xboxGamertag}` : "Not signed in",
              intro: {
                connected: "Mantel sees your Xbox play history and minutes played. PC games you've played but haven't installed are under Library → Not installed.",
                signedOut: "Brings in your Xbox play history and minutes played, and lists PC games you've played but haven't installed. You sign in on Microsoft's own page: Mantel never sees your password.",
              },
              steps: ["A Microsoft window opens above Mantel", "Sign in and allow Mantel to see your Xbox profile", "The window closes by itself when you're in"],
              signInLabel: "Sign in with Microsoft",
              signIn: api.xboxSignIn,
              disconnect: "xbox",
            }}
            onChange={setAccounts}
            onClose={() => setFlow(null)}
          />
        )}
        {flow === "sgdb" && (
          <KeyFlow
            service="SteamGridDB"
            title="Better artwork"
            intro="A free community library of covers, backgrounds and logos. Mantel uses it for games Steam doesn't have."
            howTo={["Open SteamGridDB and log in with Steam", "Preferences → API → Generate API key", "Copy it, come back here and paste it"]}
            url="https://www.steamgriddb.com/profile/preferences/api"
            site="steamgriddb.com"
            connected={!!settings.steamgriddbKey}
            status={settings.steamgriddbKey ? `Connected · key ••••${settings.steamgriddbKey.slice(-4)}` : undefined}
            onSubmit={async (key) => {
              if (!/^[0-9a-f]{32}$/i.test(key)) throw "That doesn't look like a SteamGridDB key (32 letters and digits).";
              await patch({ steamgriddbKey: key });
              rescan(true);
            }}
            onDisconnect={async () => {
              await patch({ steamgriddbKey: "" });
            }}
            onClose={() => setFlow(null)}
          />
        )}
      </main>
    </SettingsInput>
  );
}

/** Separate component so hooks run unconditionally regardless of the early return above. */
function SettingsInput({
  active,
  zone,
  onMove,
  onEnter,
  onLeave,
  onActivate,
  children,
}: {
  active: boolean;
  zone: "categories" | "rows";
  onMove: (d: number) => "edge" | void;
  onEnter: () => void;
  onLeave: () => void;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  useInput(
    (a) => {
      if (a === "up") return onMove(-1);
      if (a === "down") return onMove(1);
      if (zone === "categories") {
        if (a === "a" || a === "right") return onEnter();
        if (a === "left") return "edge";
        return false;
      }
      if (a === "a") {
        onActivate();
        return "silent";
      }
      if (a === "left" || a === "b") return onLeave();
      if (a === "right") return "edge";
      return false;
    },
    Layer.view,
    active,
  );
  useHints(
    zone === "categories"
      ? [["a", "Open"], ["dpad", "Move"], ["menu", "Control center"]]
      : [["a", "Select"], ["b", "Back"], ["menu", "Control center"]],
    Layer.view,
    active,
  );
  return <>{children}</>;
}
