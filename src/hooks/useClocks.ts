import { useEffect, useRef, useState } from "react";
import { fetchGameInfo, type GameClock, type GameInfo } from "../feed/gameInfo";

export type Color = "sente" | "gote";

export type ClockState = {
  /** Estimated remaining main-time (ms). Negative means we've spilled into byoyomi. */
  mainMs: number;
  /** Remaining byoyomi periods (0..periods). Once >0 we're in byoyomi mode. */
  byoyomiPeriodsLeft: number;
  /** ms left in the *current* byoyomi period (only meaningful if byoyomiPeriodsLeft > 0). */
  byoyomiMs: number;
};

export type UseClocksState = {
  loading: boolean;
  clock: GameClock | null;
  /** True if our initial main-time was estimated by halving (gameElapsed/2) instead of being exact. */
  estimated: boolean;
  plies: number;
  turn: Color | null;
  /** Wall-clock time when we observed the most recent move arrive, used to compute live "thinking" tick. */
  lastMoveTickerMs: number | null;
  sente: ClockState | null;
  gote: ClockState | null;
  /** Players from the snapshot — fills in gote name that the TV channel endpoint doesn't carry. */
  game: GameInfo | null;
};

const INITIAL: UseClocksState = {
  loading: false,
  clock: null,
  estimated: false,
  plies: 0,
  turn: null,
  lastMoveTickerMs: null,
  sente: null,
  gote: null,
  game: null,
};

function turnFromSfen(sfen: string | null): Color | null {
  if (!sfen) return null;
  const parts = sfen.trim().split(/\s+/);
  if (parts[1] === "w") return "gote";
  if (parts[1] === "b") return "sente";
  return null;
}

function decrementClock(c: ClockState, deltaMs: number): ClockState {
  if (deltaMs <= 0) return c;
  if (c.mainMs > 0) {
    const newMain = c.mainMs - deltaMs;
    return { ...c, mainMs: newMain };
  }
  // already in byoyomi
  if (c.byoyomiPeriodsLeft > 0) {
    let periods = c.byoyomiPeriodsLeft;
    let bms = c.byoyomiMs - deltaMs;
    while (bms < 0 && periods > 1) {
      periods -= 1;
      bms += c.byoyomiMs > 0 ? c.byoyomiMs : 0;
    }
    return { ...c, byoyomiPeriodsLeft: periods, byoyomiMs: Math.max(0, bms) };
  }
  return c;
}

function tickByoyomiOnMove(c: ClockState, byoyomiMs: number, periods: number): ClockState {
  // After a move completes, if we were in byoyomi (mainMs <= 0), the byoyomi clock resets to full
  // for the *next* move and we don't lose a period unless this byoyomi was exhausted (handled above).
  if (c.mainMs <= 0 && byoyomiMs > 0 && periods > 0) {
    return { ...c, byoyomiMs };
  }
  return c;
}

/**
 * Estimate clock state from a fresh snapshot. Splits elapsed game time evenly between players —
 * good enough as a starting point; future moves we observe will be measured exactly.
 */
function initFromSnapshot(info: GameInfo, nowMs: number): { sente: ClockState; gote: ClockState; estimated: boolean } {
  const c = info.clock ?? { initial: 0, increment: 0, byoyomi: 0, periods: 0 };
  const initialMs = c.initial * 1000;
  const byoyomiMs = c.byoyomi * 1000;
  const periods = c.periods;

  const elapsedSinceLastMove = Math.max(0, nowMs - info.lastMoveAt);
  // Crude even split of (createdAt → lastMoveAt). The side-to-move's still-ticking thinking time
  // since lastMoveAt is added on top.
  const usedTotalEachMs = Math.max(0, (info.lastMoveAt - info.createdAt) / 2);

  const turn = info.plies % 2 === 0 ? "sente" : "gote";
  const make = (color: Color): ClockState => {
    let mainMs = initialMs - usedTotalEachMs;
    if (color === turn) mainMs -= elapsedSinceLastMove;
    if (mainMs > 0) {
      return { mainMs, byoyomiPeriodsLeft: periods, byoyomiMs };
    }
    // We've spilled into byoyomi territory. Approximate byoyomi as fresh; we don't know how many
    // periods have already been burnt, so be generous and assume 1 period gone if mainMs is very negative.
    const overrunMs = -mainMs;
    let leftPeriods = periods;
    let leftMs = byoyomiMs;
    if (color === turn) {
      leftMs = Math.max(0, byoyomiMs - overrunMs);
    }
    if (leftMs <= 0 && leftPeriods > 1) {
      leftPeriods -= 1;
      leftMs = byoyomiMs;
    }
    return { mainMs: 0, byoyomiPeriodsLeft: leftPeriods, byoyomiMs: leftMs };
  };

  return {
    sente: make("sente"),
    gote: make("gote"),
    estimated: usedTotalEachMs > 0,
  };
}

/**
 * Track estimated clocks for the featured TV game.
 *
 * Inputs:
 *   gameId — current featured game id (changes on featured event)
 *   gameSeq — increments when gameId changes (so we know to re-fetch)
 *   posSeq — increments on every sfen event (so we know when a move just arrived)
 *   sfen — current sfen string (used to know whose turn it is now)
 */
export function useClocks(args: {
  gameId: string | null;
  gameSeq: number;
  posSeq: number;
  sfen: string | null;
}): UseClocksState {
  const [state, setState] = useState<UseClocksState>(INITIAL);
  const lastSeenGameSeqRef = useRef<number>(-1);
  const lastSeenPosSeqRef = useRef<number>(-1);
  const turnRef = useRef<Color | null>(null);

  // Fetch snapshot whenever the featured game changes.
  useEffect(() => {
    if (!args.gameId) return;
    if (lastSeenGameSeqRef.current === args.gameSeq) return;
    lastSeenGameSeqRef.current = args.gameSeq;

    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true }));
    fetchGameInfo(args.gameId, ac.signal)
      .then((info) => {
        const now = Date.now();
        const init = initFromSnapshot(info, now);
        const turn: Color = info.plies % 2 === 0 ? "sente" : "gote";
        turnRef.current = turn;
        setState({
          loading: false,
          clock: info.clock ?? null,
          estimated: init.estimated,
          plies: info.plies,
          turn,
          lastMoveTickerMs: now,
          sente: init.sente,
          gote: init.gote,
          game: info,
        });
      })
      .catch(() => {
        setState((s) => ({ ...s, loading: false }));
      });

    return () => ac.abort();
  }, [args.gameId, args.gameSeq]);

  // Apply each new sfen update — measure elapsed since previous sfen, charge it to whoever
  // was on the move, then flip the turn.
  useEffect(() => {
    if (lastSeenPosSeqRef.current === args.posSeq) return;
    lastSeenPosSeqRef.current = args.posSeq;
    const newTurn = turnFromSfen(args.sfen);
    if (!newTurn) return;

    setState((s) => {
      if (!s.clock || !s.sente || !s.gote || s.lastMoveTickerMs === null) {
        // Snapshot not loaded yet — just remember the turn.
        return { ...s, turn: newTurn, lastMoveTickerMs: Date.now() };
      }
      const now = Date.now();
      const dt = Math.max(0, now - s.lastMoveTickerMs);
      const moverColor: Color = newTurn === "sente" ? "gote" : "sente";
      const byoyomiMs = s.clock.byoyomi * 1000;
      let sente = s.sente;
      let gote = s.gote;
      if (moverColor === "sente") {
        sente = decrementClock(sente, dt);
        sente = tickByoyomiOnMove(sente, byoyomiMs, s.clock.periods);
      } else {
        gote = decrementClock(gote, dt);
        gote = tickByoyomiOnMove(gote, byoyomiMs, s.clock.periods);
      }
      turnRef.current = newTurn;
      return {
        ...s,
        sente,
        gote,
        turn: newTurn,
        plies: s.plies + 1,
        lastMoveTickerMs: now,
      };
    });
  }, [args.posSeq, args.sfen]);

  // Live ticking once a second on the side-to-move so the displayed remaining counts down visually.
  useEffect(() => {
    if (!state.clock || !state.turn) return;
    const id = window.setInterval(() => {
      setState((s) => {
        if (!s.clock || !s.turn || !s.sente || !s.gote || s.lastMoveTickerMs === null) return s;
        const now = Date.now();
        const dt = now - s.lastMoveTickerMs;
        if (dt < 250) return s;
        const byoyomiMs = s.clock.byoyomi * 1000;
        const apply = (c: ClockState) => {
          // Re-derive remaining from the anchor lastMoveTickerMs to keep tick precise (avoids drift).
          if (c.mainMs > 0) {
            return { ...c, mainMs: Math.max(0, c.mainMs - 1000) };
          }
          if (byoyomiMs > 0 && c.byoyomiMs > 0) {
            return { ...c, byoyomiMs: Math.max(0, c.byoyomiMs - 1000) };
          }
          return c;
        };
        return s.turn === "sente"
          ? { ...s, sente: apply(s.sente), lastMoveTickerMs: now }
          : { ...s, gote: apply(s.gote), lastMoveTickerMs: now };
      });
    }, 1000);
    return () => window.clearInterval(id);
  }, [state.clock, state.turn]);

  return state;
}

export function formatClockSetting(c: GameClock): string {
  const minutes = Math.floor(c.initial / 60);
  const seconds = c.initial % 60;
  const main = seconds === 0 ? `${minutes}分` : `${minutes}:${String(seconds).padStart(2, "0")}`;
  if (c.byoyomi > 0) {
    return c.periods > 1
      ? `${main} + 秒読み${c.byoyomi}秒×${c.periods}`
      : `${main} + 秒読み${c.byoyomi}秒`;
  }
  if (c.increment > 0) {
    return `${main} + ${c.increment}秒`;
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
