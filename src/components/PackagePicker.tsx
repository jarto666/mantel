import { useState } from "react";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import type { BundleItem, Game } from "../types";
import { size } from "../util";
import { useHints } from "./Hints";

const required = (item: BundleItem) => item.kind === "main" || item.kind === "launcher";

/**
 * What to install of a bundle, before Windows starts on it. Add-ons and alternatives can be left
 * out; the main game and its launcher can't. `onInstall` gets the chosen parts, or nothing when
 * that's all of them.
 */
export function PackagePicker({ game, items, onInstall, onClose }: { game: Game; items: BundleItem[]; onInstall: (chosen?: string[]) => void; onClose: () => void }) {
  const [chosen, setChosen] = useState(() => new Set(items.map((i) => i.id)));
  const [at, setAt] = useState(0);
  // A launcher alone isn't a game.
  const ready = items.some((i) => chosen.has(i.id) && i.kind !== "launcher");
  const install = () => {
    if (!ready) return "edge" as const;
    onClose();
    onInstall(chosen.size === items.length ? undefined : items.filter((i) => chosen.has(i.id)).map((i) => i.id));
  };
  const toggle = (item: BundleItem) => {
    if (required(item)) return "edge" as const;
    setChosen((set) => {
      const next = new Set(set);
      if (!next.delete(item.id)) next.add(item.id);
      return next;
    });
  };

  useInput((a) => {
    switch (a) {
      case "up":
        return at > 0 ? setAt(at - 1) : "edge";
      case "down":
        return at < items.length ? setAt(at + 1) : "edge";
      case "a":
        return at === items.length ? install() : toggle(items[at]);
      case "b":
        return onClose();
      default:
        return "silent";
    }
  }, Layer.modal);
  useHints([["a", "Select"], ["b", "Back"]], Layer.modal);

  return (
    <div className="prompt">
      <div className="prompt-card">
        <div className="eyebrow">{game.name}</div>
        <h2 className="pkg-title">{t("Choose what to install")}</h2>
        <div className="pkg-list">
          {items.map((item, n) => (
            <button
              key={item.id}
              className={`pkg ${n === at ? "is-focused" : ""} ${chosen.has(item.id) ? "is-on" : ""}`}
              onClick={() => {
                setAt(n);
                toggle(item);
              }}
            >
              <span className="pkg-box">{chosen.has(item.id) && <svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>}</span>
              <span className="pkg-name">{item.title}</span>
              <span className="pkg-note">{required(item) ? t("Required") : item.kind === "addon" ? t("Add-on") : ""}{item.size ? ` · ${size(item.size)}` : ""}</span>
            </button>
          ))}
        </div>
        <div className="pkg-actions">
          <button
            className={`btn btn-play ${at === items.length ? "is-focused" : ""} ${ready ? "" : "is-off"}`}
            onClick={() => {
              setAt(items.length);
              install();
            }}
          >
            {t("Install")}
          </button>
        </div>
      </div>
    </div>
  );
}
