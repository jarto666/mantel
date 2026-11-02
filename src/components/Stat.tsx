import { t } from "../i18n";
import type { Achievements, InstallProgress } from "../types";
import { size, speedText, timeLeft } from "../util";

export function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** How much of an install has come down. */
export function InstallStat({ install, total }: { install: InstallProgress; total?: number | null }) {
  // Windows says 1 while it's still working the size out.
  const all = install.total > 1 ? install.total : total;
  const label = all ? t("of {size}", { size: size(all) }) : install.downloaded ? t("Downloaded") : t("Download size");
  const left = all && install.speed && all > install.downloaded ? (all - install.downloaded) / install.speed : 0;
  return (
    <>
      <Stat value={size(install.downloaded)} label={label} />
      {install.state === "downloading" && !!install.speed && <Stat value={speedText(install.speed)} label={left ? timeLeft(left) : t("Downloading")} />}
    </>
  );
}

/** Unlocked out of total, or a percentage when the store gives no total (most newer Xbox titles). */
export function AchievementsStat({ a }: { a: Achievements }) {
  const [value, unit] = a.total > 0 ? [a.unlocked, `/${a.total}`] : [a.percent, "%"];
  return (
    <div className="stat stat-achievements">
      <div className="stat-value">
        {value}
        <span className="stat-unit">{unit}</span>
      </div>
      <div className="stat-label">{t("Achievements")}</div>
      <div className="stat-meter">
        <span style={{ width: `${a.percent}%` }} />
      </div>
    </div>
  );
}
