import { useState } from "react";
import { api } from "../api";
import { Layer, useInput } from "../input";
import { closeRunning, gameById, rescan, useStore } from "../store";
import { useHints } from "./Hints";
import { timeText, useClock } from "./TopBar";

interface Item {
  id: string;
  label: string;
  danger?: boolean;
  confirm?: boolean;
  run: () => void;
}

const ICONS: Record<string, React.ReactNode> = {
  close: <path d="M6 6l12 12M18 6 6 18" />,
  rescan: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>,
  desktop: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  restart: <path d="M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5" />,
  shutdown: <path d="M12 3v8M6.3 6.3a8 8 0 1 0 11.4 0" />,
  quit: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
};

/** Bottom sheet in the spirit of a console control center: one row of big actions. */
export function QuickMenu() {
  const open = useStore((s) => s.overlay === "menu");
  const running = useStore((s) => s.running);
  const now = useClock();
  const [index, setIndex] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const close = () => {
    setArmed(null);
    setIndex(0);
    useStore.setState({ overlay: null });
  };

  const game = gameById(running?.id ?? null);
  const items: Item[] = [
    ...(game ? [{ id: "close", label: "Close game", danger: true, confirm: true, run: () => closeRunning() }] : []),
    { id: "search", label: "Search", run: () => useStore.setState({ overlay: "search" }) },
    { id: "rescan", label: "Refresh library", run: () => rescan() },
    { id: "settings", label: "Settings", run: () => useStore.setState({ view: "settings", detailsId: null }) },
    { id: "desktop", label: "Desktop", run: () => api.powerAction("desktop") },
    { id: "restart", label: "Restart", confirm: true, run: () => api.powerAction("restart") },
    { id: "shutdown", label: "Power off", confirm: true, danger: true, run: () => api.powerAction("shutdown") },
    { id: "quit", label: "Quit Mantel", confirm: true, run: () => api.powerAction("quit") },
  ];
  const i = Math.min(index, items.length - 1);

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
        case "a":
          return activate(items[i]);
        case "b":
        case "menu":
          return close();
        default:
          return "silent";
      }
    },
    Layer.overlay,
    open,
  );
  useHints([["a", armed ? "Confirm" : "Select"], ["b", "Close"]], Layer.overlay, open);

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
          <div className="cc-time">
            {now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}
            <span>{timeText(now)}</span>
          </div>
        </div>
        <div className="cc-row">
          {items.map((item, n) => (
            <button
              key={item.id}
              className={`cc-item ${n === i ? "is-focused" : ""} ${item.danger ? "danger" : ""} ${armed === item.id ? "is-armed" : ""}`}
              onClick={() => {
                setIndex(n);
                activate(item);
              }}
            >
              <span className="cc-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  {ICONS[item.id]}
                </svg>
              </span>
              <span className="cc-label">{armed === item.id ? "Press A again" : item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
