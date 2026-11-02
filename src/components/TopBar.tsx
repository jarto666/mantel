import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { gameById, useStore, type View } from "../store";
import type { Power } from "../types";
import { Glyph } from "./Glyph";

const TABS: [View, string][] = [
  ["home", "Games"],
  ["library", "Library"],
  ["gamepass", "Xbox"],
  ["steam", "Steam"],
];

/** A store gets a tab once there's something to browse: its games, or for Xbox the catalog. */
function hasTab(s: ReturnType<typeof useStore.getState>, view: View) {
  if (view === "steam") return !!s.settings?.sources.steam && (!!s.accounts?.steam.user || !!s.accounts?.steam.connected || s.games.some((g) => g.source === "steam"));
  if (view === "gamepass") return !!s.settings?.sources.xbox && (s.catalog.length > 0 || s.games.some((g) => g.source === "xbox" && !g.hidden));
  return true;
}

/** Views LB/RB step through. */
export const tabOrder = (): View[] => {
  const s = useStore.getState();
  return [...TABS.map(([id]) => id).filter((id) => hasTab(s, id)), "settings"];
};

export function useClock(every = 5000) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

export const timeText = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function usePower() {
  const [power, setPower] = useState<Power | null>(null);
  useEffect(() => {
    const read = () => api.powerStatus().then(setPower).catch(() => {});
    read();
    const t = setInterval(read, 30000);
    return () => clearInterval(t);
  }, []);
  return power;
}

export function Battery({ power }: { power: Power }) {
  const pct = power.percent ?? 0;
  const low = pct <= 20 && !power.charging;
  return (
    <span className={`battery ${low ? "low" : ""} ${power.charging ? "charging" : ""}`}>
      <span className="battery-pct">{pct}%</span>
      <span className="battery-body">
        <span className="battery-fill" style={{ width: `${pct}%` }} />
        {power.charging && (
          <svg className="battery-bolt" viewBox="0 0 24 24"><path d="M13 2 4 14h7l-1 8 9-12h-7z" /></svg>
        )}
      </span>
    </span>
  );
}

function RunningPill() {
  const running = useStore((s) => s.running);
  const game = gameById(running?.id ?? null);
  const now = useClock();
  if (!running || !game || !running.detected) return null;
  const min = Math.max(0, Math.floor((now.getTime() / 1000 - running.startedAt) / 60));
  return (
    <span className="running-pill">
      <span className="live-dot" />
      {game.name}
      <span className="running-time">{t("{n} min", { n: min })}</span>
    </span>
  );
}

/** An install in progress, from every tab; opens its game's page. */
function InstallPill() {
  const installs = useStore((s) => s.installs);
  const list = Object.values(installs);
  const install = list[0];
  const game = gameById(install?.id ?? null);
  if (!install || !game) return null;
  return (
    <button className="running-pill install-pill" onClick={() => useStore.setState({ detailsId: install.id })}>
      <svg className="install-ring" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9.5" />
        <circle cx="12" cy="12" r="9.5" pathLength={100} strokeDasharray={100} strokeDashoffset={100 - install.percent} />
      </svg>
      <span className="install-pill-name">{game.name}</span>
      <span className="running-time">{Math.round(install.percent)}%</span>
      {list.length > 1 && <span className="running-time">+{list.length - 1}</span>}
    </button>
  );
}

export function TopBar() {
  const view = useStore((s) => s.view);
  const overlay = useStore((s) => s.overlay);
  const scanning = useStore((s) => s.scanning);
  const tabs = useStore((s) => TABS.filter(([id]) => hasTab(s, id)).map(([id]) => id).join());
  const now = useClock();
  const power = usePower();
  const go = (v: View) => useStore.setState({ view: v, detailsId: null });

  return (
    <header className="topbar">
      <nav className="tabs">
        <Glyph b="lb" size={0.85} />
        {TABS.filter(([id]) => tabs.split(",").includes(id)).map(([id, label]) => (
          <button key={id} className={`tab ${view === id ? "is-active" : ""}`} onClick={() => go(id)}>
            {t(label)}
            {view === id && <motion.span layoutId="tab-line" className="tab-line" transition={{ type: "spring", stiffness: 480, damping: 38 }} />}
          </button>
        ))}
        <Glyph b="rb" size={0.85} />
      </nav>
      <div className="status">
        {scanning && <span className="scanning"><span className="spinner" />{t("Scanning")}</span>}
        <InstallPill />
        <RunningPill />
        <button
          className={`icon-btn ${overlay === "search" ? "is-active" : ""}`}
          aria-label={t("Search")}
          onClick={() => useStore.setState({ overlay: "search" })}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </svg>
        </button>
        <button className={`icon-btn ${view === "settings" ? "is-active" : ""}`} aria-label={t("Settings")} onClick={() => go("settings")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
          </svg>
        </button>
        {power?.hasBattery && <Battery power={power} />}
        <span className="clock">{timeText(now)}</span>
      </div>
    </header>
  );
}
