import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { Layer, useInput } from "../input";
import { closeRunning, gameById, rescan, toast, useStore } from "../store";
import type { Power, Quick } from "../types";
import { useHints } from "./Hints";
import { Battery, timeText, useClock } from "./TopBar";

interface Item {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: boolean;
  run: () => void;
}

type Slider = "volume" | "brightness";

const STEP = 5;
/** How often the sheet rereads the device while open: the hardware keys change it too. */
const REFRESH = 4000;

export const GEAR = (
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>
);

const ICONS: Record<string, React.ReactNode> = {
  close: <path d="M6 6l12 12M18 6 6 18" />,
  rescan: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  settings: GEAR,
  desktop: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  fullscreen: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  restart: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" />,
  shutdown: <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />,
  quit: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
  volume: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /></>,
  muted: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="m16 9.5 5 5M21 9.5l-5 5" /></>,
  brightness: <><circle cx="12" cy="12" r="3.6" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>,
};

function Icon({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[id]}
    </svg>
  );
}

function WifiStatus({ wifi }: { wifi: NonNullable<Quick["wifi"]> }) {
  const signal = wifi.signal ?? 100;
  const bars = !wifi.connected ? 0 : signal >= 70 ? 3 : signal >= 40 ? 2 : 1;
  const arcs = ["M8.6 15.4a5 5 0 0 1 6.8 0", "M5.5 12.2a9.5 9.5 0 0 1 13 0", "M2.5 9a14 14 0 0 1 19 0"];
  return (
    <span className="cc-chip">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        {arcs.map((d, n) => <path key={d} d={d} className={n < bars ? "" : "off"} />)}
        <circle cx="12" cy="18.6" r="1.1" fill="currentColor" className={wifi.connected ? "" : "off"} />
      </svg>
      {wifi.connected ? wifi.name ?? "Connected" : "Not connected"}
    </span>
  );
}

/**
 * Sends the latest value only: while one call is out, newer values replace each other, so
 * holding the d-pad never queues up a backlog of WMI calls.
 */
function useLatest(send: (v: number) => Promise<void>) {
  const busy = useRef(false);
  const next = useRef<number | null>(null);
  return (value: number) => {
    next.current = value;
    if (busy.current) return;
    busy.current = true;
    (async () => {
      while (next.current !== null) {
        const v = next.current;
        next.current = null;
        await send(v).catch((e) => toast(String(e), "warn"));
      }
      busy.current = false;
    })();
  };
}

function SliderRow({
  id,
  label,
  value,
  muted,
  focused,
  onChange,
  onFocus,
}: {
  id: Slider;
  label: string;
  value: number;
  muted?: boolean;
  focused: boolean;
  onChange: (v: number) => void;
  onFocus: () => void;
}) {
  const track = useRef<HTMLSpanElement>(null);
  const fromPointer = (e: React.PointerEvent) => {
    const r = track.current!.getBoundingClientRect();
    onChange(Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100));
  };
  return (
    <div className={`cc-slider ${focused ? "is-focused" : ""} ${muted ? "is-muted" : ""}`} onClick={onFocus}>
      <span className="cc-slider-icon"><Icon id={muted ? "muted" : id} /></span>
      <span className="cc-slider-label">{label}</span>
      <span
        className="cc-track"
        ref={track}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          onFocus();
          fromPointer(e);
        }}
        onPointerMove={(e) => e.buttons && fromPointer(e)}
      >
        <span className="cc-bar">
          <span className="cc-fill" style={{ width: `${value}%` }} />
        </span>
      </span>
      <span className="cc-slider-value">{muted ? "Muted" : value}</span>
    </div>
  );
}

/** Bottom sheet in the spirit of a console control center: quick settings over one row of big actions. */
export function QuickMenu() {
  const open = useStore((s) => s.overlay === "menu");
  const running = useStore((s) => s.running);
  const now = useClock();
  const [index, setIndex] = useState(0);
  const [zone, setZone] = useState<Slider | "actions">("actions");
  const [armed, setArmed] = useState<string | null>(null);
  const [quick, setQuick] = useState<Quick | null>(null);
  const [power, setPower] = useState<Power | null>(null);
  // Checked on every open: Game Bar can switch the mode while the menu is closed.
  const [canEnterFullScreen, setCanEnterFullScreen] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.fullScreenMode().then((m) => setCanEnterFullScreen(m.canSwitch && !m.active), () => setCanEnterFullScreen(false));
    const read = () => {
      api.quickStatus().then(setQuick, () => {});
      api.powerStatus().then(setPower, () => {});
    };
    read();
    const t = setInterval(read, REFRESH);
    return () => clearInterval(t);
  }, [open]);
  const close = () => {
    setArmed(null);
    setIndex(0);
    setZone("actions");
    useStore.setState({ overlay: null });
  };

  const sendVolume = useLatest(api.setVolume);
  const sendBrightness = useLatest(api.setBrightness);
  const sliders: Slider[] = [
    ...(quick?.volume != null ? (["volume"] as const) : []),
    ...(quick?.brightness != null ? (["brightness"] as const) : []),
  ];
  const setLevel = (s: Slider, value: number) => {
    const v = Math.min(100, Math.max(0, value));
    if (s === "volume") {
      setQuick((q) => q && { ...q, volume: v, muted: v > 0 ? false : q.muted });
      sendVolume(v);
    } else {
      setQuick((q) => q && { ...q, brightness: v });
      sendBrightness(v);
    }
  };
  const toggleMute = () => {
    if (!quick) return;
    setQuick({ ...quick, muted: !quick.muted });
    api.setMuted(!quick.muted).catch((e) => toast(String(e), "warn"));
  };

  const game = gameById(running?.id ?? null);
  const items: Item[] = [
    ...(game ? [{ id: "close", label: "Close game", danger: true, confirm: true, run: () => closeRunning() }] : []),
    { id: "search", label: "Search", run: () => useStore.setState({ overlay: "search" }) },
    { id: "rescan", label: "Refresh library", run: () => rescan() },
    { id: "settings", label: "Settings", run: () => useStore.setState({ view: "settings", detailsId: null }) },
    ...(canEnterFullScreen ? [{ id: "fullscreen", label: "Full screen mode", run: () => api.powerAction("fullscreen") }] : []),
    { id: "desktop", label: "Desktop", run: () => api.powerAction("desktop") },
    { id: "restart", label: "Restart", confirm: true, run: () => api.powerAction("restart") },
    { id: "shutdown", label: "Power off", confirm: true, danger: true, run: () => api.powerAction("shutdown") },
    { id: "quit", label: "Quit Mantel", confirm: true, run: () => api.powerAction("quit") },
  ];
  const i = Math.min(index, items.length - 1);
  // The zone can outlive its slider, e.g. when the output device goes away.
  const at = zone === "actions" || sliders.includes(zone) ? zone : "actions";

  const activate = (item: Item) => {
    if (item.confirm && armed !== item.id) {
      setArmed(item.id);
      return;
    }
    close();
    item.run();
  };

  useInput(
    (a) => {
      if (a === "b" || a === "menu") return close();
      if (at !== "actions") {
        const value = (at === "volume" ? quick?.volume : quick?.brightness) ?? 0;
        const pos = sliders.indexOf(at);
        switch (a) {
          case "left":
            return value > 0 ? setLevel(at, value - STEP) : "edge";
          case "right":
            return value < 100 ? setLevel(at, value + STEP) : "edge";
          case "up":
            return pos > 0 ? setZone(sliders[pos - 1]) : "edge";
          case "down":
            return setZone(sliders[pos + 1] ?? "actions");
          case "a":
            return at === "volume" ? toggleMute() : "silent";
          default:
            return "silent";
        }
      }
      switch (a) {
        case "left":
          if (i === 0) return "edge";
          setArmed(null);
          setIndex(i - 1);
          return;
        case "right":
          if (i === items.length - 1) return "edge";
          setArmed(null);
          setIndex(i + 1);
          return;
        case "up":
          if (!sliders.length) return "edge";
          setArmed(null);
          return setZone(sliders[sliders.length - 1]);
        case "a":
          return activate(items[i]);
        default:
          return "silent";
      }
    },
    Layer.overlay,
    open,
  );
  useHints(
    at === "actions"
      ? [["a", armed ? "Confirm" : "Select"], ["b", "Close"]]
      : at === "volume"
        ? [["dpad", "Adjust"], ["a", quick?.muted ? "Unmute" : "Mute"], ["b", "Close"]]
        : [["dpad", "Adjust"], ["b", "Close"]],
    Layer.overlay,
    open,
  );

  const minutes = running ? Math.max(0, Math.floor((now.getTime() / 1000 - running.startedAt) / 60)) : 0;

  return (
    <div className={`cc-wrap ${open ? "is-open" : ""}`} onClick={(e) => e.target === e.currentTarget && close()}>
      <div className="cc">
        <div className="cc-top">
          <div className="cc-now">
            {game ? (
              <>
                <span className="live-dot" />
                <span>{game.name}</span>
                <span className="cc-dim">{minutes} min this session</span>
              </>
            ) : (
              <span className="cc-dim">Control Center</span>
            )}
          </div>
          <div className="cc-status">
            {quick?.wifi && <WifiStatus wifi={quick.wifi} />}
            {power?.hasBattery && (
              <span className="cc-chip">
                <Battery power={power} />
                {power.charging && <span className="cc-dim">Charging</span>}
              </span>
            )}
            <div className="cc-time">
              {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
              <span>{timeText(now)}</span>
            </div>
          </div>
        </div>
        {quick && sliders.length > 0 && (
          <div className="cc-sliders">
            {sliders.map((s) => (
              <SliderRow
                key={s}
                id={s}
                label={s === "volume" ? "Volume" : "Brightness"}
                value={(s === "volume" ? quick.volume : quick.brightness) ?? 0}
                muted={s === "volume" && quick.muted}
                focused={at === s}
                onChange={(v) => setLevel(s, v)}
                onFocus={() => setZone(s)}
              />
            ))}
          </div>
        )}
        <div className="cc-row">
          {items.map((item, n) => (
            <button
              key={item.id}
              className={`cc-item ${at === "actions" && n === i ? "is-focused" : ""} ${item.danger ? "danger" : ""} ${armed === item.id ? "is-armed" : ""}`}
              onClick={() => {
                setZone("actions");
                setIndex(n);
                activate(item);
              }}
            >
              <span className="cc-icon"><Icon id={item.id} /></span>
              <span className="cc-label">{armed === item.id ? "Press A again" : item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
