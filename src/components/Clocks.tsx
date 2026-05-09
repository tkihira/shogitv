import {
  formatClockSetting,
  formatRemaining,
  type Color,
  type UseClocksState,
} from "../hooks/useClocks";
import type { TvFeaturedPlayer } from "../feed/tvFeed";

function classNames(...xs: (string | false | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

function playerName(p: TvFeaturedPlayer | null): string {
  if (!p) return "?";
  if (p.user) return p.user.title ? `${p.user.title} ${p.user.name}` : p.user.name;
  if (p.ai) return `AI Lv.${p.ai}`;
  return "?";
}

export function ClockRow({
  state,
  color,
  player,
}: {
  state: UseClocksState;
  color: Color;
  player: TvFeaturedPlayer | null;
}) {
  const c = color === "sente" ? state.sente : state.gote;
  const ticking = state.turn === color && !state.finished;
  if (state.initial === 0 && state.byoyomi === 0) return null;
  return (
    <div className={classNames("clock-row", color, ticking && "ticking")}>
      <span className="dot" />
      <span className="player-name">{playerName(player)}</span>
      {player?.rating ? <span className="rating">{player.rating}</span> : null}
      <span className="time">{formatRemaining(c)}</span>
    </div>
  );
}

export function ClockMeta({ state }: { state: UseClocksState }) {
  if (state.initial === 0 && state.byoyomi === 0) return null;
  return (
    <div className="clock-meta">
      <span className="format">{formatClockSetting(state.initial, state.byoyomi, state.periods)}</span>
      <span className="plies">{state.plies}手目</span>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  resign: "投了",
  outoftime: "切れ負け",
  mate: "詰み",
  draw: "引き分け",
  aborted: "中断",
  illegal: "反則",
  unknown: "終局",
};

export function GameResultBanner({ state }: { state: UseClocksState }) {
  if (!state.finished) return null;
  const label = state.endStatus ? STATUS_LABEL[state.endStatus] : "終局";
  const winnerText = state.winner
    ? state.winner === "sente"
      ? "先手の勝ち"
      : "後手の勝ち"
    : null;
  return (
    <div className="game-result" role="status" aria-live="polite">
      <span className="end-status">{label}</span>
      {winnerText ? <span className="winner">{winnerText}</span> : null}
    </div>
  );
}
