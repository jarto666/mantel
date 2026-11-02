import { useState } from "react";
import { api } from "../api";
import { errorText, t } from "../i18n";
import { Layer, useInput } from "../input";
import { toast } from "../store";
import type { Edition, Editions } from "../types";
import { money } from "../util";
import { useHints } from "./Hints";

function note(edition: Edition, owned: boolean | null | undefined) {
  if (owned === undefined) return "…";
  if (owned) return t("On your account");
  return edition.price === null ? "" : money(edition.price, edition.currency);
}

/**
 * The editions of a Store game, as in the Xbox app: on the account or at their price. One on the
 * account installs the game; any other opens in the Xbox app, which is where buying happens.
 */
export function EditionPicker({ found, owned, onInstall, onClose }: { found: Editions; owned: Record<string, boolean | null>; onInstall: () => void; onClose: () => void }) {
  const [at, setAt] = useState(0);
  const pick = (edition: Edition) => {
    if (owned[edition.id]) {
      onClose();
      return onInstall();
    }
    if (owned[edition.id] === undefined) return "edge" as const;
    api.openXboxStore(edition.id).catch((e) => toast(errorText(e), "warn"));
  };

  useInput((a) => {
    switch (a) {
      case "up":
        return at > 0 ? setAt(at - 1) : "edge";
      case "down":
        return at < found.editions.length - 1 ? setAt(at + 1) : "edge";
      case "a":
        return pick(found.editions[at]);
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
        <div className="eyebrow">{found.title}</div>
        <h2 className="pkg-title">{t("Choose an edition")}</h2>
        <div className="pkg-list">
          {found.editions.map((edition, n) => (
            <button
              key={edition.id}
              className={`pkg ${n === at ? "is-focused" : ""} ${owned[edition.id] ? "is-owned" : ""}`}
              onClick={() => {
                setAt(n);
                pick(edition);
              }}
            >
              <span className="pkg-name">{edition.title}</span>
              <span className="pkg-note">{note(edition, owned[edition.id])}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
