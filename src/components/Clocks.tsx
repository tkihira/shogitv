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

const STATUS_LABEL: Record<string, string> = {
  resign: "投了",
  outoftime: "切れ負け",
  mate: "詰み",
  draw: "引き分け",
  aborted: "中断",
  illegal: "反則",
  unknown: "終局",
};

/** What goes in the right-hand slot of the clock row: remaining time normally, "勝ち" for
 * the winner once the game has ended, or the end-status reason for the loser / both sides
 * when there's no winner (draw / aborted). Returns the text plus a modifier class for
 * styling (win / loss). */
function clockSlot(
  state: UseClocksState,
  color: Color,
): { text: string; modifier: "win" | "loss" | null } {
  if (!state.finished) {
    return { text: formatRemaining(color === "sente" ? state.sente : state.gote), modifier: null };
  }
  if (state.winner === color) {
    return { text: "勝ち", modifier: "win" };
  }
  const reason = state.endStatus ? STATUS_LABEL[state.endStatus] : "終局";
  // No declared winner (draw / aborted / unknown): both sides show the reason without
  // win/loss styling. With a declared winner, the *other* side shows the loss reason.
  return { text: reason, modifier: state.winner ? "loss" : null };
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
  const ticking = state.turn === color && !state.finished;
  if (state.initial === 0 && state.byoyomi === 0) return null;
  const slot = clockSlot(state, color);
  return (
    <div className={classNames("clock-row", color, ticking && "ticking")}>
      <span className="dot" />
      <span className="player-name">{playerName(player)}</span>
      {player?.rating ? <span className="rating">{player.rating}</span> : null}
      <span className={classNames("time", slot.modifier ?? false)}>{slot.text}</span>
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
