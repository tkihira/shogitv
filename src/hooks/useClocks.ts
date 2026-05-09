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
  /** Wall-clock time of the most recent SSE-driven sfen update; used to detect SSE lag. */
  sfenAt: number | null;
  /** Called when the export pulls ahead of the SSE feed (zombie connection); the parent
   * should force-reconnect and apply the fresher position. */
  onSseLag?: (gameId: string, lastPly: number) => void;
}): UseClocksState {
  const [state, setState] = useState<UseClocksState>(INITIAL);
  const lastSeenGameSeqRef = useRef<number>(-1);
  const lastSeenPosSeqRef = useRef<number>(-1);
  const lastFetchAtRef = useRef<number>(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const gameIdRef = useRef<string | null>(null);
  const onSseLagRef = useRef(args.onSseLag);
  onSseLagRef.current = args.onSseLag;
  const sfenAtRef = useRef(args.sfenAt);
  sfenAtRef.current = args.sfenAt;

  const sync = async (gameId: string, reason: "game-change" | "sfen" | "interval") => {
    // Throttle "interval" only — every sfen event must fetch (otherwise the very last move,
    // which often carries the end-of-game line in the KIF, can be skipped if it arrives within
    // a small window of the previous sync, and the TV may switch to the next game before the
    // safety net fires).
    if (reason === "interval" && shouldThrottle(lastFetchAtRef.current, 3000)) return;
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
      let advanced = false;
      setState((s) => {
        // If no new move was played and the game hasn't ended, the export carries no fresh
        // clock authority — keep the locally-ticking clocks. Otherwise byoyomi resets to its
        // full 30s at every safety-net sync because buildFromExport always returns the
        // post-last-move state, where byoyomi is 30 by shogi rules.
        const moveAdvanced = exp.lastPly > s.plies;
        const justFinished = exp.finished && !s.finished;
        const firstSync = s.syncMs === null;
        // Track for the post-setState SSE-lag check. Don't flag firstSync — at startup the
        // export will of course be ahead of our empty state.
        if (moveAdvanced && !firstSync) advanced = true;
        if (!moveAdvanced && !justFinished && !firstSync) {
          return { ...s, loading: false };
        }
        return {
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
        };
      });
      // SSE lag detection: the export saw a new move; if the SSE feed hasn't delivered an
      // sfen recently (or hasn't delivered any since startup), it has gone zombie. Tell the
      // parent so it can force-reconnect and patch in the missed position. Threshold of
      // 12s is permissive enough to avoid false positives in blitz games (where SSE may
      // deliver shortly after our 5-second polling tick) while still catching real zombies
      // that are typically silent for 30s+.
      if (advanced && !exp.finished) {
        const sfenAt = sfenAtRef.current ?? 0;
        const sinceLastSse = sfenAt > 0 ? Date.now() - sfenAt : Infinity;
        if (sinceLastSse > 12_000) {
          onSseLagRef.current?.(gameId, exp.lastPly);
        }
      }
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

  // Trigger 3: 30s safety net — re-sync to catch slow drift / SSE going zombie. End-of-game
  // detection (切れ負け in particular) is no longer this interval's job; the clock-zero
  // trigger below handles that more cheaply. Higher interval keeps the per-viewer request
  // rate down to ~2 req/min, well inside lishogi's "reasonable" load.
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

  // Trigger 4: when the active player's clock hits 0 in our local model, do an immediate
  // sync — the server can confirm 切れ負け right away instead of waiting for the next 30s
  // safety-net tick. Fires once per zero-transition (a flag resets when the clock starts
  // ticking again on a new move).
  const ranOutFiredRef = useRef(false);
  useEffect(() => {
    if (state.finished || !state.turn) {
      ranOutFiredRef.current = false;
      return;
    }
    const active = state.turn === "sente" ? state.sente : state.gote;
    if (!active) return;
    const exhausted =
      active.mainMs <= 0 &&
      (active.byoyomiPeriodsLeft <= 0 || active.byoyomiMs <= 0);
    if (exhausted && !ranOutFiredRef.current) {
      ranOutFiredRef.current = true;
      if (gameIdRef.current) void sync(gameIdRef.current, "interval");
    } else if (!exhausted) {
      ranOutFiredRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.turn, state.finished, state.sente, state.gote]);

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
