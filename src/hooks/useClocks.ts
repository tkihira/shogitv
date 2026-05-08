import { useEffect, useRef, useState } from "react";
import { fetchGameInfo, type GameInfo } from "../feed/gameInfo";
import { fetchGameExport, type EndStatus, type GameExport } from "../feed/gameExport";

export type Color = "sente" | "gote";

export type ClockState = {
  /** Estimated remaining main-time (ms). 0 if exhausted. */
  mainMs: number;
  /** Remaining byoyomi periods (lishogi snapshot has a single combined "byoyomi" pool here). */
  byoyomiPeriodsLeft: number;
  /** ms left in the current byoyomi period (only meaningful if byoyomiPeriodsLeft > 0). */
  byoyomiMs: number;
};

export type UseClocksState = {
  loading: boolean;
  /** Main time, seconds (for display formatting). */
  initial: number;
  byoyomi: number;
  periods: number;
  plies: number;
  turn: Color | null;
  /** Wall-clock time of our most recent authoritative sync, used as the anchor for live ticking. */
  syncMs: number | null;
  sente: ClockState | null;
  gote: ClockState | null;
  /** From /api/game/{id} — has both player names with rating. */
  game: GameInfo | null;
  /** True once the game has finished (resign/timeout/mate/etc.). */
  finished: boolean;
  endStatus: EndStatus | null;
  winner: Color | null;
};

const INITIAL: UseClocksState = {
  loading: false,
  initial: 0,
  byoyomi: 0,
  periods: 0,
  plies: 0,
  turn: null,
  syncMs: null,
  sente: null,
  gote: null,
  game: null,
  finished: false,
  endStatus: null,
  winner: null,
};

/** Convert a fresh KIF export + game-info snapshot into our ClockState pair. */
function buildFromExport(exp: GameExport, info: GameInfo | null): {
  sente: ClockState;
  gote: ClockState;
  initial: number;
  byoyomi: number;
  periods: number;
} {
  const initialMs = exp.initial * 1000;
  const byoyomiMs = exp.byoyomi * 1000;
  const periods = info?.clock?.periods ?? (exp.byoyomi > 0 ? 1 : 0);

  const make = (usedMs: number): ClockState => {
    const mainMs = Math.max(0, initialMs - usedMs);
    if (mainMs > 0 || byoyomiMs === 0 || periods === 0) {
      return { mainMs, byoyomiPeriodsLeft: periods, byoyomiMs };
    }
    // Spilled into byoyomi. We don't get per-period detail from KIF, so assume periods are
    // intact and the current byoyomi clock is full at last move.
    return { mainMs: 0, byoyomiPeriodsLeft: periods, byoyomiMs };
  };

  return {
    sente: make(exp.senteUsedMs),
    gote: make(exp.goteUsedMs),
    initial: exp.initial,
    byoyomi: exp.byoyomi,
    periods,
  };
}

/** Hybrid trigger: fetch export at most once per `minIntervalMs`. */
function shouldThrottle(lastFetchAt: number, minIntervalMs: number): boolean {
  return Date.now() - lastFetchAt < minIntervalMs;
}

export function useClocks(args: {
  gameId: string | null;
  gameSeq: number;
  posSeq: number;
  sfen: string | null;
}): UseClocksState {
  const [state, setState] = useState<UseClocksState>(INITIAL);
  const lastSeenGameSeqRef = useRef<number>(-1);
  const lastSeenPosSeqRef = useRef<number>(-1);
  const lastFetchAtRef = useRef<number>(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const gameIdRef = useRef<string | null>(null);

  const sync = async (gameId: string, reason: "game-change" | "sfen" | "interval") => {
    // Throttle "interval" only — every sfen event must fetch (otherwise the very last move,
    // which often carries the end-of-game line in the KIF, can be skipped if it arrives within
    // a small window of the previous sync, and the TV may switch to the next game before the
    // 30 s safety net fires).
    if (reason === "interval" && shouldThrottle(lastFetchAtRef.current, 5000)) return;
    if (inFlightRef.current) inFlightRef.current.abort();
    const ac = new AbortController();
    inFlightRef.current = ac;
    lastFetchAtRef.current = Date.now();
    try {
      const [exp, info] = await Promise.all([
        fetchGameExport(gameId, ac.signal),
        // Only re-fetch /api/game on game-change; export already reveals end status.
        reason === "game-change" ? fetchGameInfo(gameId, ac.signal).catch(() => null) : Promise.resolve(null),
      ]);
      if (gameIdRef.current !== gameId) return; // game switched while in flight
      const built = buildFromExport(exp, info);
      setState((s) => ({
        ...s,
        loading: false,
        initial: built.initial,
        byoyomi: built.byoyomi,
        periods: built.periods,
        plies: exp.lastPly,
        turn: exp.finished ? null : exp.turn,
        syncMs: Date.now(),
        sente: built.sente,
        gote: built.gote,
        game: info ?? s.game,
        finished: exp.finished,
        endStatus: exp.endStatus ?? null,
        winner: exp.winner ?? null,
      }));
    } catch (err) {
      if ((err as { name?: string }).name === "AbortError") return;
      // Soft-fail: keep showing previous state.
    } finally {
      if (inFlightRef.current === ac) inFlightRef.current = null;
    }
  };

  // Trigger 1: featured game changed.
  useEffect(() => {
    if (!args.gameId) return;
    if (lastSeenGameSeqRef.current === args.gameSeq && gameIdRef.current === args.gameId) return;
    lastSeenGameSeqRef.current = args.gameSeq;
    gameIdRef.current = args.gameId;
    setState(() => ({ ...INITIAL, loading: true }));
    void sync(args.gameId, "game-change");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.gameId, args.gameSeq]);

  // Trigger 2: SSE delivered a new sfen — re-fetch to capture exact per-move clock.
  useEffect(() => {
    if (lastSeenPosSeqRef.current === args.posSeq) return;
    lastSeenPosSeqRef.current = args.posSeq;
    if (!gameIdRef.current) return;
    void sync(gameIdRef.current, "sfen");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.posSeq]);

  // Trigger 3: 30s safety net — re-sync to catch end-of-game when no further sfen will arrive.
  useEffect(() => {
    if (!args.gameId) return;
    const id = window.setInterval(() => {
      if (gameIdRef.current) void sync(gameIdRef.current, "interval");
    }, 30_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.gameId]);

  // Live ticking on the side-to-move so the UI counts down between server syncs.
  // The 30s safety-net sync (and SSE-triggered syncs) correct any drift.
  useEffect(() => {
    if (!state.turn || state.finished) return;
    const id = window.setInterval(() => {
      setState((s) => {
        if (!s.turn || s.finished || !s.sente || !s.gote) return s;
        const apply = (c: ClockState) => {
          if (c.mainMs > 0) return { ...c, mainMs: Math.max(0, c.mainMs - 1000) };
          if (c.byoyomiPeriodsLeft > 0 && c.byoyomiMs > 0) {
            return { ...c, byoyomiMs: Math.max(0, c.byoyomiMs - 1000) };
          }
          return c;
        };
        return s.turn === "sente"
          ? { ...s, sente: apply(s.sente) }
          : { ...s, gote: apply(s.gote) };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.turn, state.finished]);

  return state;
}

export function formatClockSetting(initial: number, byoyomi: number, periods: number): string {
  const minutes = Math.floor(initial / 60);
  const seconds = initial % 60;
  const main = seconds === 0 ? `${minutes}分` : `${minutes}:${String(seconds).padStart(2, "0")}`;
  if (byoyomi > 0) {
    return periods > 1
      ? `${main} + 秒読み${byoyomi}秒×${periods}`
      : `${main} + 秒読み${byoyomi}秒`;
  }
  return main;
}

export function formatRemaining(c: ClockState | null): string {
  if (!c) return "—";
  if (c.mainMs > 0) {
    const totalSec = Math.floor(c.mainMs / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  if (c.byoyomiPeriodsLeft > 0 && c.byoyomiMs > 0) {
    const sec = Math.ceil(c.byoyomiMs / 1000);
    return c.byoyomiPeriodsLeft > 1 ? `秒${sec} (×${c.byoyomiPeriodsLeft})` : `秒${sec}`;
  }
  return "0:00";
}
