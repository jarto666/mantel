import { Component, type ReactNode } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { Layer, useInput } from "../input";
import { toast, useStore } from "../store";

/** A second crash this soon, in ms, means going back to Home didn't help. */
const AGAIN = 5000;

function Stuck() {
  useInput(() => {
    location.reload();
  }, Layer.modal);
  return (
    <main className="home" onClick={() => location.reload()}>
      <div className="empty-state">
        <h1>{t("Mantel ran into a problem")}</h1>
        <p>{t("Press any button to reload")}</p>
      </div>
    </main>
  );
}

/**
 * A screen that throws while rendering would otherwise blank the whole app, with no way back on
 * a handheld. This returns to Home and says so; if Home itself is what's broken, it offers a reload.
 */
export class Boundary extends Component<{ children: ReactNode }, { failed: boolean; stuck: boolean }> {
  state = { failed: false, stuck: false };
  private lastCrash = 0;

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    api.log("error", `ui crash: ${error.message}`);
    const stuck = Date.now() - this.lastCrash < AGAIN;
    this.lastCrash = Date.now();
    if (stuck) return this.setState({ stuck });
    useStore.setState({ view: "home", detailsId: null, overlay: null, launching: null });
    toast(t("That screen couldn't open"), "warn");
    this.setState({ failed: false });
  }

  render() {
    if (this.state.stuck) return <Stuck />;
    return this.state.failed ? null : this.props.children;
  }
}
