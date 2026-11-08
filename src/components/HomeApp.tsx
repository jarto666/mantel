import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { api, type FullScreenMode } from "../api";
import { errorText, t } from "../i18n";
import { Layer, useInput } from "../input";
import { ease } from "../motion";
import { toast } from "../store";
import { useHints } from "./Hints";

/**
 * Making Mantel the home app of Xbox mode. Windows takes an app from outside the Store only in
 * Developer Mode, so Mantel turns that on first, which Windows asks the player to allow (fse.rs).
 */
export function useHomeApp() {
  const [mode, setMode] = useState<FullScreenMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fullScreenMode().then(setMode).catch(() => {});
  }, []);

  const make = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setMode(await api.makeHomeApp());
      toast(t("Xbox mode will start in Mantel"), "good");
    } catch (e) {
      setError(errorText(e));
      // A half-done run, such as Developer Mode on but no home app yet, changes what's left to do.
      api.fullScreenMode().then(setMode).catch(() => {});
    } finally {
      setBusy(false);
    }
  };

  const openDeveloperSettings = () => void api.powerAction("developer-settings").catch((e) => toast(errorText(e), "warn"));

  return { mode, busy, error, make, openDeveloperSettings };
}

/** What happens, in the order the player sees it. */
export function homeAppCopy(mode: FullScreenMode) {
  return {
    intro: t("In Xbox mode, Windows opens a home app when the handheld starts and when you press Home in Game Bar. Mantel can be that app."),
    steps: mode.home
      ? []
      : [
          ...(mode.developerMode
            ? []
            : [t("Windows asks for permission once: choose Yes"), t("Mantel turns on Developer Mode, which Windows needs before an app from outside the Store can be the home app")]),
          t("The next time Xbox mode starts, it starts in Mantel"),
        ],
    note: t("Uninstalling Mantel gives Xbox mode back the home app it had before."),
    status: mode.home ? t("Mantel is the home app") : mode.developerMode ? t("Developer Mode is on") : t("Developer Mode is off"),
    action: t("Make Mantel the home app"),
    busy: mode.developerMode ? t("Setting up…") : t("Waiting for Windows…"),
  };
}

type Action = "make" | "developer" | "done";

/** Settings' sheet for it; setup shows the same steps full screen. */
export function HomeAppFlow({ onClose }: { onClose: () => void }) {
  const { mode, busy, error, make, openDeveloperSettings } = useHomeApp();
  const [index, setIndex] = useState(0);
  const copy = mode ? homeAppCopy(mode) : null;
  const actions: Action[] = !mode ? [] : mode.home ? ["done"] : error && !mode.developerMode ? ["make", "developer"] : ["make"];
  const i = Math.min(index, actions.length - 1);

  const run = (a: Action) => {
    if (a === "make") void make();
    else if (a === "developer") openDeveloperSettings();
    else onClose();
  };

  useInput(
    (a) => {
      if (busy) return "silent";
      if (a === "b") return onClose();
      if (a === "up") return i > 0 ? setIndex(i - 1) : "edge";
      if (a === "down") return i < actions.length - 1 ? setIndex(i + 1) : "edge";
      if (a === "a" && actions[i]) return run(actions[i]);
      return "silent";
    },
    Layer.modal,
  );
  useHints(busy ? [] : [["a", "Select"], ["b", "Close"]], Layer.modal);

  const label: Record<Action, string> = {
    make: busy && copy ? copy.busy : t("Make Mantel the home app"),
    developer: t("Open Developer settings"),
    done: t("Done"),
  };

  return (
    // A click beside the card closes it, as B does.
    <motion.div className="keyflow" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <motion.div className="keyflow-card" initial={{ opacity: 0, y: 24, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ duration: 0.5, ease }}>
        <div className="eyebrow">{t("Xbox mode")}</div>
        <h2 className="keyflow-title">{t("Start in Mantel")}</h2>
        {mode && copy && (
          <>
            <p className="keyflow-intro">{copy.intro}</p>
            {copy.steps.length > 0 && (
              <ol className="keyflow-howto">
                {copy.steps.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ol>
            )}
            <div className={`keyflow-status ${mode.home ? "ok" : ""}`}>{copy.status}</div>
          </>
        )}
        <div className="keyflow-steps">
          {actions.map((a, n) => (
            <button
              key={a}
              className={`keyflow-step ${n === i ? "is-focused" : ""}`}
              onPointerMove={(e) => e.pointerType === "mouse" && n !== i && !busy && setIndex(n)}
              onClick={() => {
                if (busy) return;
                setIndex(n);
                run(a);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                {a === "developer" ? <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /> : a === "done" ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : <path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z" />}
              </svg>
              {label[a]}
              {busy && a === "make" && <span className="spinner" />}
            </button>
          ))}
        </div>
        {error && <div className="keyflow-error">{error}</div>}
        {mode && copy && !mode.home && <p className="keyflow-note">{copy.note}</p>}
      </motion.div>
    </motion.div>
  );
}
