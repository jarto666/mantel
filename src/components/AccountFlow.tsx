import { motion } from "motion/react";
import { useState } from "react";
import { api } from "../api";
import { Layer, useInput } from "../input";
import { ease } from "../motion";
import { rescan, toast } from "../store";
import type { AccountsStatus } from "../types";
import { useHints } from "./Hints";

type Action = "signin" | "sync" | "signout";

const ICONS: Record<Action, React.ReactNode> = {
  signin: <path d="M10 17l5-5-5-5M15 12H3M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5" />,
  sync: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  signout: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
};

export interface AccountCopy {
  service: string;
  /** Who's signed in, or null. */
  connectedAs: string | null;
  status: string;
  intro: { connected: string; signedOut: string };
  steps: string[];
  signInLabel: string;
  signIn: () => Promise<AccountsStatus>;
  disconnect: "steam" | "xbox";
}

/**
 * A store account sheet: sign in on the store's own page in a Mantel window (the password
 * never passes through Mantel), or sync and sign out once connected.
 */
export function AccountFlow({ copy, onChange, onClose }: { copy: AccountCopy; onChange: (s: AccountsStatus) => void; onClose: () => void }) {
  const connected = copy.connectedAs !== null;
  const actions: Action[] = connected ? ["sync", "signout"] : ["signin"];
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const i = Math.min(index, actions.length - 1);

  const run = async (a: Action) => {
    if (busy) return;
    setBusy(a);
    setError(null);
    try {
      if (a === "signin") {
        onChange(await copy.signIn());
        toast(`${copy.service} connected`, "good");
        rescan(true);
        onClose();
      } else if (a === "sync") {
        await rescan();
        onChange(await api.accountsStatus());
      } else {
        onChange(await api.disconnectAccount(copy.disconnect));
        toast(`Signed out of ${copy.service}`);
        rescan(true);
        onClose();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  useInput(
    (a) => {
      if (busy) return "silent";
      if (a === "b") return onClose();
      if (a === "up") return i > 0 ? setIndex(i - 1) : "edge";
      if (a === "down") return i < actions.length - 1 ? setIndex(i + 1) : "edge";
      if (a === "a") return void run(actions[i]);
      return "silent";
    },
    Layer.modal,
  );
  useHints(busy ? [] : [["a", "Select"], ["b", "Close"]], Layer.modal);

  const label: Record<Action, string> = {
    signin: busy === "signin" ? `Finish signing in in the ${copy.service} window…` : copy.signInLabel,
    sync: busy === "sync" ? "Syncing…" : "Sync now",
    signout: "Sign out",
  };

  return (
    <motion.div className="keyflow" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <motion.div className="keyflow-card" initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease }}>
        <div className="eyebrow">{copy.service}</div>
        <h2 className="keyflow-title">{connected ? copy.connectedAs : `Sign in to ${copy.service}`}</h2>
        <p className="keyflow-intro">{connected ? copy.intro.connected : copy.intro.signedOut}</p>
        {!connected && (
          <ol className="keyflow-howto">
            {copy.steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        )}
        <div className={`keyflow-status ${connected ? "ok" : ""}`}>{copy.status}</div>
        <div className="keyflow-steps">
          {actions.map((a, n) => (
            <button
              key={a}
              className={`keyflow-step ${n === i ? "is-focused" : ""} ${a === "signout" ? "danger" : ""}`}
              onClick={() => {
                setIndex(n);
                run(a);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {ICONS[a]}
              </svg>
              {label[a]}
              {busy === a && <span className="spinner" />}
            </button>
          ))}
        </div>
        {error && <div className="keyflow-error">{error}</div>}
      </motion.div>
    </motion.div>
  );
}
