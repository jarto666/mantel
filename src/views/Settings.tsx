import { useEffect, useRef, useState } from "react";
import { api } from "../api";
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
  const [index, setIndex] = useState(1);
  const [autostart, setAutostart] = useState(false);
  const [flow, setFlow] = useState<Flow>(null);
  const [accounts, setAccounts] = useState<AccountsStatus | null>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getAutostart().then(setAutostart).catch(() => {});
    api.accountsStatus().then(setAccounts).catch(() => {});
  }, []);

  useScrollFocus(list, index, { align: "center" });

  if (!settings) return null;
  const steam = accounts?.steam;
  const patch = (p: Partial<S>) => saveSettings(p);
  const hidden = games.filter((g) => g.hidden);

  const rows: Row[] = [
    ...(update
      ? ([
          { kind: "group", label: "Update" },
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
    { kind: "group", label: "Library" },
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
    { kind: "group", label: "Accounts" },
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
    ...MORE_STORES.map(
      ([id, label, icon]): Row => ({ kind: "button", id: `acc-${id}`, icon, label, value: "Coming soon", soon: true, run: () => toast(`${label} accounts are coming later`) }),
    ),
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
    { kind: "group", label: "Behavior" },
    {
      kind: "toggle",
      id: "minimize",
      label: "Minimize while playing",
      sub: "Mantel steps aside during a game and comes back when it closes",
      value: settings.minimizeOnLaunch,
      set: (v) => patch({ minimizeOnLaunch: v }),
    },
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
      id: "sounds",
      label: "Interface sounds",
      value: settings.sounds,
      set: (v) => patch({ sounds: v }),
    },
    ...(hidden.length
      ? [
          { kind: "group", label: `Hidden games · ${hidden.length}` } as Row,
          ...hidden.map(
            (g): Row => ({ kind: "button", id: `hidden-${g.id}`, label: g.name, value: "Unhide", run: () => setHidden(g, false) }),
          ),
        ]
      : []),
    { kind: "group", label: "Controls" },
    {
      kind: "button",
      id: "help",
      label: "A play · Y details · X favorite",
      sub: "LB/RB switch tabs · LT/RT filters · ⧉ search · ≡ control center and power",
      run: () => {},
    },
  ];

  const focusable = rows.map((r, n) => (r.kind === "group" ? -1 : n)).filter((n) => n >= 0);
  const i = focusable.includes(index) ? index : focusable[0];
  const pos = focusable.indexOf(i);

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
    <SettingsInput active={active && !flow} onMove={(d) => {
      const next = focusable[pos + d];
      if (next === undefined) return "edge";
      setIndex(next);
    }} onActivate={() => activate(rows[i])}>
      <main className="settings">
        <h1 className="page-title">Settings</h1>
        <div className="settings-list" ref={list}>
          {rows.map((row, n) =>
            row.kind === "group" ? (
              <div className="settings-group" key={`g${n}`}>{row.label}</div>
            ) : (
              <div
                key={row.id}
                className={`setting ${n === i ? "is-focused" : ""} ${row.kind === "button" && row.soon ? "is-soon" : ""}`}
                onClick={() => {
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
          <div className="settings-foot">Mantel {version} · playmantel.com</div>
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
  onMove,
  onActivate,
  children,
}: {
  active: boolean;
  onMove: (d: number) => "edge" | void;
  onActivate: () => void;
  children: React.ReactNode;
}) {
  useInput(
    (a) => {
      if (a === "up") return onMove(-1);
      if (a === "down") return onMove(1);
      if (a === "a") {
        onActivate();
        return "silent";
      }
      if (a === "left" || a === "right") return "edge";
      return false;
    },
    Layer.view,
    active,
  );
  useHints([["a", "Select"], ["dpad", "Move"], ["menu", "Control center"]], Layer.view, active);
  return <>{children}</>;
}
