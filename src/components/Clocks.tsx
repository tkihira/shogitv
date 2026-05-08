import { formatClockSetting, formatRemaining, type UseClocksState, type Color } from "../hooks/useClocks";

function classNames(...xs: (string | false | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function ClockRow({ state, color }: { state: UseClocksState; color: Color }) {
  const c = color === "sente" ? state.sente : state.gote;
  const ticking = state.turn === color;
  if (!state.clock) return null;
  return (
    <div className={classNames("clock-row", color, ticking && "ticking")}>
      <span className="dot" />
      <span className="time">{formatRemaining(c)}</span>
    </div>
  );
}

export function ClockMeta({ state }: { state: UseClocksState }) {
  if (!state.clock) return null;
  return (
    <div className="clock-meta">
      <span className="format">{formatClockSetting(state.clock)}</span>
      <span className="plies">{state.plies}手目</span>
      {state.estimated ? (
        <span className="est" title="接続前の消費時間は均等に推定">推定</span>
      ) : null}
    </div>
  );
}
