import type { EndStatus } from "./gameExport";

export type GamePlayer = {
  user?: { id: string; name: string; title?: string };
  userId?: string;
  rating?: number;
  ai?: number;
};

export type GameClock = {
  initial: number; // seconds
  increment: number; // seconds (Fischer)
  byoyomi: number; // seconds
  periods: number;
};

export type GameInfo = {
  id: string;
  status: string;
  variant: string;
  createdAt: number; // ms epoch
  lastMoveAt: number; // ms epoch
  plies: number;
  clock?: GameClock;
  players: { sente?: GamePlayer; gote?: GamePlayer };
  /** Present on finished games where there is a winner — directly authoritative
   * (no need for the "lastPly parity" heuristic the KIF parser falls back to). */
  winner?: "sente" | "gote";
};

export async function fetchGameInfo(gameId: string, signal?: AbortSignal): Promise<GameInfo> {
  const res = await fetch(`https://lishogi.org/api/game/${gameId}`, { signal });
  if (!res.ok) throw new Error(`game/${gameId}: HTTP ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const players = (raw.players ?? {}) as Record<string, GamePlayer>;
  const w = raw.winner;
  return {
    id: String(raw.id),
    status: String(raw.status ?? "unknown"),
    variant: String(raw.variant ?? "standard"),
    createdAt: Number(raw.createdAt ?? Date.now()),
    lastMoveAt: Number(raw.lastMoveAt ?? raw.createdAt ?? Date.now()),
    plies: Number(raw.plies ?? 0),
    clock: raw.clock as GameClock | undefined,
    players: { sente: players.sente, gote: players.gote },
    winner: w === "sente" || w === "gote" ? w : undefined,
  };
}

/** Map lishogi's JSON game status to our finished/endStatus pair. Anything that
 * isn't "started"/"created" is treated as finished — even unrecognised statuses
 * fall through to "unknown" so the deferred TV switch still fires. Returns null
 * for in-progress games and a concrete pair otherwise. */
export function statusToEndStatus(status: string | undefined): {
  finished: boolean;
  endStatus: EndStatus | null;
} {
  if (!status || status === "started" || status === "created") {
    return { finished: false, endStatus: null };
  }
  switch (status) {
    case "mate":
      return { finished: true, endStatus: "mate" };
    case "resign":
      return { finished: true, endStatus: "resign" };
    case "outoftime":
    case "timeout":
      return { finished: true, endStatus: "outoftime" };
    case "draw":
      return { finished: true, endStatus: "draw" };
    case "stalemate":
      // Stalemate barely happens in shogi, but if it does it's treated as a draw.
      return { finished: true, endStatus: "draw" };
    case "aborted":
    case "noStart":
      return { finished: true, endStatus: "aborted" };
    case "perpetualCheck":
      return { finished: true, endStatus: "repetition" };
    case "impasse":
      return { finished: true, endStatus: "impasse" };
    case "cheat":
      return { finished: true, endStatus: "illegal" };
    default:
      // Includes variantEnd / tryRule / any future status we don't recognise.
      // finished=true keeps the TV from getting stuck; "unknown" surfaces as
      // "終局" in the UI so the user sees something rather than nothing.
      return { finished: true, endStatus: "unknown" };
  }
}
