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
};

export async function fetchGameInfo(gameId: string, signal?: AbortSignal): Promise<GameInfo> {
  const res = await fetch(`https://lishogi.org/api/game/${gameId}`, { signal });
  if (!res.ok) throw new Error(`game/${gameId}: HTTP ${res.status}`);
  const raw = (await res.json()) as Record<string, unknown>;
  const players = (raw.players ?? {}) as Record<string, GamePlayer>;
  return {
    id: String(raw.id),
    status: String(raw.status ?? "unknown"),
    variant: String(raw.variant ?? "standard"),
    createdAt: Number(raw.createdAt ?? Date.now()),
    lastMoveAt: Number(raw.lastMoveAt ?? raw.createdAt ?? Date.now()),
    plies: Number(raw.plies ?? 0),
    clock: raw.clock as GameClock | undefined,
    players: { sente: players.sente, gote: players.gote },
  };
}
