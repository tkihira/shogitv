import { useEffect, useRef, useState } from "react";
import { fetchGameInfo, statusToEndStatus, type GameInfo } from "../feed/gameInfo";
import { fetchGameExport, type EndStatus, type GameExport } from "../feed/gameExport";
import { dlog } from "../debug";

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

/** Pull the side-to-move out of an SFEN string. Lishogi's TV feed sends 3-part SFEN
 * ("<board> <turn> <hand>") where the turn token is "b" (sente) or "w" (gote). */
function parseTurnFromSfen(sfen: string | null): Color | null {
  if (!sfen) return null;
  const parts = sfen.trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (parts[1] === "b") return "sente";
  if (parts[1] === "w") return "gote";
  return null;
}

/** Inter-event delay for the graduated interval JSON poll. After a move, the first
 * status check fires 3s later (most quick resigns / declarations happen within seconds
 * of the opponent's last move). The second check 5s after that. From there on, settle
 * into a steady 10s rhythm. Each move resets the counter. */
function interFireDelayMs(tickCount: number): number {
  if (tickCount === 0) return 3_000;
  if (tickCount === 1) return 5_000;
  return 10_000;
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
  /** Called when a KIF sync yielded a sfen worth applying to the board — typically
   * the first sync of a game (firstSync) or when KIF's lastPly advanced past our
   * state.plies (catching missed SSE events). The parent should route this to
   * applyRecovery so the board catches up without a separate /game/export JSON
   * moves fetch. */
  onPosition?: (gameId: string, sfen: string, lm: string | null) => void;
}): UseClocksState {
  const [state, setState] = useState<UseClocksState>(INITIAL);
  // Mirror state to a ref so async-after-await code can read the pre-setState
  // snapshot without relying on the setState callback running synchronously
  // (which it doesn't — React 18's auto-batching defers the updater to the next
  // render, so any side-effect writes to closure variables from inside the
  // updater are NOT visible immediately after the setState call).
  const stateRef = useRef(state);
  stateRef.current = state;
  // Mirror args.sfen so async sync() callbacks (which may have been scheduled
  // when args.sfen was older) can read the freshest SSE-delivered sfen.
  const argsSfenRef = useRef(args.sfen);
  argsSfenRef.current = args.sfen;
  const lastSeenGameSeqRef = useRef<number>(-1);
  const lastSeenPosSeqRef = useRef<number>(-1);
  const lastFetchAtRef = useRef<number>(0);
  // Separate from lastFetchAtRef: tracks only KIF-fetching syncs (sfen / game-change /
  // visibility). The sfen throttle below is gated on this so that an interval JSON-only
  // sync doesn't extend the sfen throttle window (the interval doesn't help anchor
  // clocks, so a recent interval shouldn't suppress a needed KIF fetch).
  const lastKifFetchAtRef = useRef<number>(0);
  const inFlightRef = useRef<AbortController | null>(null);
  const gameIdRef = useRef<string | null>(null);
  const onSseLagRef = useRef(args.onSseLag);
  onSseLagRef.current = args.onSseLag;
  const onPositionRef = useRef(args.onPosition);
  onPositionRef.current = args.onPosition;
  const sfenAtRef = useRef(args.sfenAt);
  sfenAtRef.current = args.sfenAt;
  // Graduated interval JSON: anchor is updated on every event in the schedule (move
  // events reset tickCount to 0; interval fires increment it). The next fire target
  // is `intervalAnchorAtRef + interFireDelayMs(intervalTickRef)`.
  const intervalAnchorAtRef = useRef<number>(0);
  const intervalTickRef = useRef<number>(0);
  // Hoisted so Trigger 1 / Trigger 2 / visibility re-anchor can reschedule the timer
  // when they reset the graduated state.
  const armNextIntervalRef = useRef<(() => void) | null>(null);

  const sync = async (
    gameId: string,
    reason: "game-change" | "sfen" | "interval" | "visibility",
  ) => {
    // Throttle "interval" only — every other reason represents a discrete event we
    // don't want to suppress (sfen = move just played, game-change = switch, visibility
    // = user just came back from a backgrounded tab).
    if (reason === "interval" && shouldThrottle(lastFetchAtRef.current, 3000)) return;
    if (inFlightRef.current) inFlightRef.current.abort();
    const ac = new AbortController();
    inFlightRef.current = ac;
    const now = Date.now();
    lastFetchAtRef.current = now;
    // Every reason now pulls KIF (interval included since 7099db4), so the sfen
    // throttle gate's last-KIF timestamp tracks all reasons too.
    lastKifFetchAtRef.current = now;
    try {
      // Fetch policy: minimise per-viewer load by only pulling each endpoint when it
      // actually adds information for that trigger.
      //
      //   reason          KIF  JSON  rationale
      //   ──────────────  ───  ────  ────────────────────────────────────────────────
      //   game-change     ✓    ✓     Fresh game needs both initial clocks AND status.
      //   sfen (per move) ✓    ✗     Only KIF carries per-move clock anchors. JSON
      //                              would only be informative if the move ended the
      //                              game (mate); KIF's summary line catches that and
      //                              the 10s interval JSON catches anything KIF missed.
      //   interval        ✓    ✓     Status check AND board catch-up: the KIF now
      //                              also replays into a sfen via shogiops, so any
      //                              SSE-missed move gets picked up here without
      //                              needing the onSseLag → fetchInitialPosition
      //                              roundtrip. Costs +1 fetch per interval but
      //                              fills the "JSON plies is CDN-cached" gap in
      //                              SSE-lag detection.
      //   visibility      ✓    ✓     User just came back; might have missed an end
      //                              event, want both for an immediate catch-up.
      const wantsKif = true;
      const wantsJson = reason !== "sfen";
      const [exp, info] = await Promise.all([
        wantsKif ? fetchGameExport(gameId, ac.signal) : Promise.resolve(null),
        wantsJson ? fetchGameInfo(gameId, ac.signal).catch(() => null) : Promise.resolve(null),
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

      // Pre-compute everything that depends on pre-setState state via stateRef.
      // setState's updater callback runs at the NEXT render (React 18 auto-batches
      // async setStates), not synchronously here, so writing to closure variables
      // from inside the updater wouldn't be visible until later. Use stateRef as
      // the snapshot source instead.
      const sBefore = stateRef.current;
      const moveAdvanced = exp ? exp.lastPly > sBefore.plies : false;
      const jsonPlyAdvance = info && info.plies > sBefore.plies ? info.plies : null;
      const justFinished = finished && !sBefore.finished;
      const firstSync = sBefore.syncMs === null;
      // SSE-lag detection: a ply count past ours means SSE missed the move(s).
      let advancedToPly: number | null = null;
      if (!firstSync) {
        if (moveAdvanced) advancedToPly = exp!.lastPly;
        else if (!exp && jsonPlyAdvance !== null) advancedToPly = jsonPlyAdvance;
      }
      // KIF replays moves through shogiops to derive a sfen + lm. Hand it back to
      // the parent for board update — but ONLY when SSE has been silent long enough
      // that we suspect the SSE-delivered tv.sfen is stale (12s threshold, matching
      // onSseLag), or it's the very first sync of a game (no SSE data yet at all).
      // Otherwise SSE is the authoritative source for the latest position, and KIF
      // can lag SSE by a few plies (CDN cache or lishogi's anti-cheat omission), so
      // applying KIF here would *regress* the board.
      const sfenAtForLag = sfenAtRef.current ?? 0;
      const sseSilent = sfenAtForLag === 0 || Date.now() - sfenAtForLag > 12_000;
      const trustKifPosition = firstSync || sseSilent;
      const posSnapshot: { sfen: string; lm: string | null } | null =
        exp && exp.sfen && (moveAdvanced || firstSync) && trustKifPosition
          ? { sfen: exp.sfen, lm: exp.lm ?? null }
          : null;
      dlog("[shogitv:sync]", {
        reason,
        kifLastPly: exp?.lastPly,
        kifSfen: exp?.sfen?.slice(-30) ?? null,
        kifLm: exp?.lm ?? null,
        jsonStatus: info?.status,
        jsonPlies: info?.plies,
        sPlies: sBefore.plies,
        moveAdvanced,
        justFinished,
        firstSync,
        sseSilent,
        trustKifPosition,
        posSnapshotSet: !!posSnapshot,
        earlyReturn: !moveAdvanced && !justFinished && !firstSync,
      });

      setState((s) => {
        // If no new move was played and the game hasn't ended, the export carries no fresh
        // clock authority — keep the locally-ticking clocks. Otherwise byoyomi resets to its
        // full 30s at every safety-net sync because buildFromExport always returns the
        // post-last-move state, where byoyomi is 30 by shogi rules. Re-derive flags from
        // s here (rather than reusing the sBefore-based values) because another setState
        // could have run between sBefore capture and this updater firing.
        const ma = exp ? exp.lastPly > s.plies : false;
        const jf = finished && !s.finished;
        const fs = s.syncMs === null;
        if (!ma && !jf && !fs) {
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
        // Prefer SSE's sfen for the side-to-move when one is available — KIF can lag
        // SSE by a few plies (CDN / anti-cheat) so exp.turn might be wrong relative
        // to what the user is actually watching on the board. parseTurnFromSfen()
        // reads the turn token directly out of the freshest SSE-delivered SFEN.
        const sseTurn = parseTurnFromSfen(argsSfenRef.current);
        return {
          ...s,
          loading: false,
          initial: built.initial,
          byoyomi: built.byoyomi,
          periods: built.periods,
          plies: exp.lastPly,
          turn: finished ? null : sseTurn ?? exp.turn,
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
      // Board refresh: KIF-derived sfen takes the place of a separate /game/export
      // JSON moves fetch. applyRecovery (the typical destination of this callback)
      // has its own "if (s.sfen === sfen) return s" dedup, so this is a no-op when
      // SSE already had the latest position.
      if (posSnapshot) onPositionRef.current?.(gameId, posSnapshot.sfen, posSnapshot.lm);
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
    intervalAnchorAtRef.current = Date.now();
    intervalTickRef.current = 0;
    armNextIntervalRef.current?.();
    void sync(args.gameId, "game-change");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.gameId, args.gameSeq]);

  // Trigger 2: SSE delivered a new sfen.
  //
  // Two-step update: ALWAYS flip state.turn from the new sfen (so the local 1Hz ticker
  // decrements the correct side starting now), but rate-limit the KIF fetch to once per
  // 3s — gated on lastKifFetchAtRef specifically (not lastFetchAtRef), so that interval
  // JSON-only syncs don't extend the sfen throttle window. Ultra-fast bullet games are
  // capped at ~20 KIF fetches/min regardless of move rate; for typical mid-tempo games
  // the throttle never fires (moves are spaced > 3s apart). Trade-off is up to ~3s of
  // clock-anchor drift between fetches, but the local ticker keeps wall-clock so the
  // displayed countdown tracks reality closely — KIF re-anchoring just confirms.
  useEffect(() => {
    if (lastSeenPosSeqRef.current === args.posSeq) return;
    lastSeenPosSeqRef.current = args.posSeq;
    if (!gameIdRef.current) return;
    const turn = parseTurnFromSfen(args.sfen);
    if (turn) {
      setState((s) => {
        if (s.turn === turn) return s;
        // The player who just moved is the side whose turn it WAS before this sfen.
        // Byoyomi refreshes per move, so if they were in byoyomi (mainMs ran out),
        // restore their byoyomi pool to full. Without this, throttled sfen-driven
        // syncs would leave the mover's byoyomi at the partial remnant the local
        // ticker had decremented to, and on their next turn it would count down
        // from there → premature 切れ負け in the local display.
        const mover = s.turn;
        let next: UseClocksState = { ...s, turn };
        if (mover && s.byoyomi > 0) {
          const moverClock = mover === "sente" ? s.sente : s.gote;
          if (
            moverClock &&
            moverClock.mainMs <= 0 &&
            moverClock.byoyomiPeriodsLeft > 0
          ) {
            const refreshed: ClockState = {
              ...moverClock,
              byoyomiMs: s.byoyomi * 1000,
            };
            next =
              mover === "sente"
                ? { ...next, sente: refreshed }
                : { ...next, gote: refreshed };
          }
        }
        return next;
      });
    }
    // Reset the graduated interval schedule on every move event (whether or not we end
    // up actually fetching KIF below — a throttled-skipped move still represents the
    // "just moved → quick status check might be valuable" trigger we want to anchor on).
    intervalAnchorAtRef.current = Date.now();
    intervalTickRef.current = 0;
    armNextIntervalRef.current?.();
    if (shouldThrottle(lastKifFetchAtRef.current, 3000)) return;
    void sync(gameIdRef.current, "sfen");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.posSeq]);

  // Trigger 3: graduated interval JSON poll, anchored on each "schedule event" in
  // intervalAnchorAtRef. After a move, we want a quick first status check (catches
  // a quick resign/declaration), then ramp down to a steady-state cadence:
  //
  //   move                  → tickCount = 0, target = anchor + 3s
  //   first interval fires  → tickCount = 1, target = anchor + 5s
  //   second interval fires → tickCount = 2, target = anchor + 10s
  //   third+ fires          → tickCount = 3+, target = anchor + 10s (steady state)
  //
  // Move events (Trigger 1 / Trigger 2) reset tickCount to 0 and re-arm via the
  // hoisted ref. Suspend entirely while hidden — the visibility-return listener above
  // force-syncs on return so there's nothing for the interval to do in the background.
  useEffect(() => {
    if (!args.gameId) return;
    let timeoutId: number | null = null;
    let stopped = true;
    const armNext = () => {
      if (stopped) return;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      const targetTime =
        intervalAnchorAtRef.current + interFireDelayMs(intervalTickRef.current);
      const delay = Math.max(100, targetTime - Date.now());
      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        if (stopped) return;
        // Re-check at fire time: a move event between scheduling and now would have
        // reset both the anchor and tickCount, so the target may now be in the future.
        const now = Date.now();
        if (now >= intervalAnchorAtRef.current + interFireDelayMs(intervalTickRef.current)) {
          if (gameIdRef.current) void sync(gameIdRef.current, "interval");
          intervalAnchorAtRef.current = now;
          intervalTickRef.current += 1;
        }
        armNext();
      }, delay);
    };
    armNextIntervalRef.current = armNext;
    const stop = () => {
      stopped = true;
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        stopped = false;
        armNext();
      } else {
        stop();
      }
    };
    onVis();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      armNextIntervalRef.current = null;
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
      if (gameIdRef.current) {
        // Reset the graduated schedule but skip the 3s/5s burst — the visibility
        // sync below already pulls JSON, so re-polling status 3s later would be
        // wasteful. Setting tickCount=2 lands the next interval at +10s.
        intervalAnchorAtRef.current = Date.now();
        intervalTickRef.current = 2;
        armNextIntervalRef.current?.();
        void sync(gameIdRef.current, "visibility");
      }
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
