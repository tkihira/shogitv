import { parseSfen, makeSfen } from "shogiops/sfen";
import { parseUsi } from "shogiops/util";

const STANDARD_INITIAL_SFEN =
  "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

/** Result of replaying a USI move list from the standard initial position. */
export type ReplayResult = {
  /** 3-part SFEN string (board / turn / hand) — matches the format the TV SSE feed sends. */
  sfen: string;
  /** Last USI move played, or null if there were no moves. */
  lm: string | null;
};

/**
 * Replay a USI move string (space-separated tokens) from the standard initial position.
 * Returns the resulting SFEN. Stops on the first illegal move and returns whatever was
 * reached so far.
 */
export function replayUsiMoves(moves: string | null | undefined): ReplayResult | null {
  const setup = parseSfen("standard", STANDARD_INITIAL_SFEN);
  if (!setup.isOk) return null;
  const pos = setup.value;
  let lm: string | null = null;
  if (moves) {
    for (const u of moves.split(/\s+/).filter(Boolean)) {
      const md = parseUsi(u);
      if (!md) break;
      try {
        pos.play(md);
        lm = u;
      } catch {
        break;
      }
    }
  }
  // makeSfen returns a 4-part SFEN; the TV feed convention is 3 parts (no move number).
  const sfen3 = makeSfen(pos).split(/\s+/).slice(0, 3).join(" ");
  return { sfen: sfen3, lm };
}

/**
 * Fetch the game export (JSON) and replay moves to derive the current position.
 * Used to populate the board immediately on page load — without this, we'd have to wait
 * for the next SSE `sfen` event (could be 0–60s for a slow game).
 */
export async function fetchInitialPosition(
  gameId: string,
  signal?: AbortSignal,
): Promise<ReplayResult | null> {
  const res = await fetch(`https://lishogi.org/game/export/${encodeURIComponent(gameId)}`, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { moves?: string };
  return replayUsiMoves(data.moves ?? null);
}
