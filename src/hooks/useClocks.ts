import { useEffect, useRef, useState } from "react";
import { fetchGameInfo, statusToEndStatus, type GameInfo } from "../feed/gameInfo";
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
      // Fetch policy:
      // - "interval" (10s safety net + clock-zero trigger): JSON only. We only want to
      //   know "did the game end?" and the early-return below drops KIF data anyway when
      //   no move advanced — fetching it would be pure waste.
      // - "sfen" / "game-change": KIF + JSON. KIF gives per-move clock anchors that JSON
      //   doesn't expose; JSON gives authoritative finished / winner.
      const wantsKif = reason !== "interval";
      const [exp, info] = await Promise.all([
        wantsKif ? fetchGameExport(gameId, ac.signal) : Promise.resolve(null),
        fetchGameInfo(gameId, ac.signal).catch(() => null),
      ]);
      if (gameIdRef.current !== gameId) return; // game switched while in flight

      // Pick the most authoritative finished/endStatus/winner trio. JSON wins when
      // available; KIF parser output is the fallback for the rare case where the
      // /api/game request failed (and we have a KIF to fall back on).
      const fromJson = info ? statusToEndStatus(info.status) : null;
      const finished = fromJson ? fromJson.finished : exp?.finished ?? false;
      const endStatus: EndStatus | null = fromJson
        ? fromJson.endStatus
        : exp?.endStatus ?? null;
      const winner: Color | null = info?.winner ?? exp?.winner ?? null;

      // SSE-lag detection: a ply count past ours means SSE missed the move(s).
      // KIF gives lastPly directly; JSON-only ticks expose `plies`. Capture the
      // advance amount inside setState so we can read it against pre-setState
      // s.plies, then run the side effect afterwards.
      let advancedToPly: number | null = null;
      setState((s) => {
        // If no new move was played and the game hasn't ended, the export carries no fresh
        // clock authority — keep the locally-ticking clocks. Otherwise byoyomi resets to its
        // full 30s at every safety-net sync because buildFromExport always returns the
        // post-last-move state, where byoyomi is 30 by shogi rules.
        const moveAdvanced = exp ? exp.lastPly > s.plies : false;
        const jsonPlyAdvance = info && info.plies > s.plies ? info.plies : null;
        const justFinished = finished && !s.finished;
        const firstSync = s.syncMs === null;
        if (!firstSync) {
          if (moveAdvanced) advancedToPly = exp!.lastPly;
          else if (!exp && jsonPlyAdvance !== null) advancedToPly = jsonPlyAdvance;
        }
        if (!moveAdvanced && !justFinished && !firstSync) {
          return { ...s, loading: false };
        }
        // Status-only path (interval polling that detected just-finished). Don't touch
        // clocks — the local ticker has them at the right value already.
        if (!exp) {
          return {
            ...s,
            loading: false,
            game: info ?? s.game,
            finished,
            endStatus,
            winner,
            turn: finished ? null : s.turn,
          };
        }
        const built = buildFromExport(exp, info);
        return {
          ...s,
          loading: false,
          initial: built.initial,
          byoyomi: built.byoyomi,
          periods: built.periods,
          plies: exp.lastPly,
          turn: finished ? null : exp.turn,
          syncMs: Date.now(),
          sente: built.sente,
          gote: built.gote,
          game: info ?? s.game,
          finished,
          endStatus,
          winner,
        };
      });
      // 12s threshold is permissive enough to avoid false positives in blitz games while
      // still catching real zombies (which tend to be silent for 30s+).
      if (advancedToPly !== null && !finished) {
        const sfenAt = sfenAtRef.current ?? 0;
        const sinceLastSse = sfenAt > 0 ? Date.now() - sfenAt : Infinity;
        if (sinceLastSse > 12_000) {
          onSseLagRef.current?.(gameId, advancedToPly);
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

  // Trigger 3: 10s safety net — re-sync to catch slow drift / SSE going zombie / non-time
  // forfeitures (resign / mate / 千日手 / etc.) that the clock-zero trigger below misses.
  // Suspend the interval entirely while the tab is hidden: nobody's watching the clock,
  // and the visibility-return listener above already re-anchors and force-syncs the
  // moment the user comes back. This drops idle background load to zero (browsers also
  // throttle hidden setInterval anyway, but explicit is cheaper than throttled).
  useEffect(() => {
    if (!args.gameId) return;
    let intervalId: number | null = null;
    const start = () => {
      if (intervalId !== null) return;
      intervalId = window.setInterval(() => {
        if (gameIdRef.current) void sync(gameIdRef.current, "interval");
      }, 10_000);
    };
    const stop = () => {
      if (intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") start();
      else stop();
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
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

  // Visibility re-anchor: while the tab is hidden the 1Hz live ticker is throttled
  // (Chrome) or paused entirely (Safari minimised), so on return the active player's
  // clock is stale by ~hiddenMs. Snap forward by that amount as a one-shot, then
  // force a fresh export sync to catch any moves / ending that happened in the gap.
  // The sync's setState early-returns when nothing advanced, so it doesn't clobber
  // the local snap; if a move *did* happen during the gap, the move-driven update
  // overrides the snap with the true post-move anchor.
  const hiddenAtRef = useRef<number | null>(null);
  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "hidden") {
        hiddenAtRef.current = Date.now();
        return;
      }
      if (document.visibilityState !== "visible") return;
      const hiddenAt = hiddenAtRef.current;
      hiddenAtRef.current = null;
      if (hiddenAt !== null) {
        const hiddenMs = Date.now() - hiddenAt;
        setState((s) => {
          if (!s.turn || s.finished) return s;
          const apply = (c: ClockState | null): ClockState | null => {
            if (!c) return c;
            if (c.mainMs > hiddenMs) return { ...c, mainMs: c.mainMs - hiddenMs };
            const overflow = hiddenMs - c.mainMs;
            return { ...c, mainMs: 0, byoyomiMs: Math.max(0, c.byoyomiMs - overflow) };
          };
          return s.turn === "sente"
            ? { ...s, sente: apply(s.sente) }
            : { ...s, gote: apply(s.gote) };
        });
      }
      if (gameIdRef.current) void sync(gameIdRef.current, "sfen");
    };
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const main =
    minutes === 0
      ? `${seconds}秒`
      : seconds === 0
      ? `${minutes}分`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
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
