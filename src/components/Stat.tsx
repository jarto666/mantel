import type { Achievements } from "../types";

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

/** Unlocked out of total, or a percentage when the store gives no total (most newer Xbox titles). */
export function AchievementsStat({ a }: { a: Achievements }) {
  const [value, unit] = a.total > 0 ? [a.unlocked, `/${a.total}`] : [a.percent, "%"];
  return (
    <div className="stat stat-achievements">
      <div className="stat-value">
        {value}
        <span className="stat-unit">{unit}</span>
      </div>
      <div className="stat-label">Achievements</div>
      <div className="stat-meter">
        <span style={{ width: `${a.percent}%` }} />
      </div>
    </div>
  );
}
