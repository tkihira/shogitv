import { useEffect, useRef, useState } from "react";
import { fetchChannels, type TvChannel } from "../feed/tvChannels";
import { startTvFeed, type TvEvent, type TvFeaturedPlayer } from "../feed/tvFeed";
import { fetchInitialPosition } from "../feed/replayMoves";
import { fetchGameExport } from "../feed/gameExport";
import { fetchGameInfo, type GamePlayer } from "../feed/gameInfo";

export type PendingGame = {
  id: string;
  sfen: string | null;
  lm: string | null;
  sente: TvFeaturedPlayer | null;
  gote: TvFeaturedPlayer | null;
};

export type TvState = {
  status: "connecting" | "open" | "closed";
  gameId: string | null;
  sfen: string | null;
  lm: string | null;
  sente: TvFeaturedPlayer | null;
  gote: TvFeaturedPlayer | null;
  /** Monotonic counter that increments whenever the featured game changes. */
  gameSeq: number;
  /** Monotonic counter that increments on every position update. */
  posSeq: number;
  /** Wall-clock time of the most recent SSE-driven sfen update, used by useClocks to
   * detect "zombie" SSE connections (export shows new moves that SSE hasn't delivered). */
  sfenAt: number | null;
  /** Next game queued by an SSE `featured` event but not yet swapped in. The owner of this
   * hook decides when to commit it (e.g. App.tsx waits 5s after the current game finishes
   * so the user has time to read the result banner). */
  pendingGame: PendingGame | null;
};

export type TvControls = {
  /** Force the SSE EventSource to reconnect (recovery from zombie connections). */
  forceReconnect: () => void;
  /** Apply an externally-derived sfen+lm — used when useClocks's polling pulls ahead of
   * the SSE feed and we replay moves to catch up. */
  applyRecovery: (gameId: string, sfen: string, lm: string | null) => void;
  /** Commit the pending game switch (if any). Idempotent; no-op when nothing is pending. */
  applyPendingNow: () => void;
};

const INITIAL: TvState = {
  status: "connecting",
  gameId: null,
  sfen: null,
  lm: null,
  sente: null,
  gote: null,
  gameSeq: 0,
  posSeq: 0,
  sfenAt: null,
  pendingGame: null,
};

function pickColor(players: TvFeaturedPlayer[] | undefined, color: "sente" | "gote"): TvFeaturedPlayer | null {
  if (!players) return null;
  return players.find((p) => p.color === color) ?? null;
}

function fromChannel(ch: TvChannel): TvFeaturedPlayer {
  return { user: { id: ch.user.id, name: ch.user.name, title: ch.user.title }, rating: ch.rating };
}

function fromGameInfo(p: GamePlayer | undefined): TvFeaturedPlayer | null {
  if (!p) return null;
  const id = p.user?.id ?? p.userId;
  const name = p.user?.name ?? id;
  if (!id || !name) return null;
  return { user: { id, name, title: p.user?.title }, rating: p.rating, ai: p.ai };
}

export function useTvFeed(): TvState & TvControls {
  const [state, setState] = useState<TvState>(INITIAL);
  const lastGameIdRef = useRef<string | null>(null);
  const feedRef = useRef<{ forceReconnect: () => void } | null>(null);
  // Side-effect helpers (player + initial position fetch) need an AbortController scoped to
  // the hook lifetime; expose it via ref so applyPendingNow (defined below the effect) can use it.
  const acRef = useRef<AbortController | null>(null);
  const commitGameSwitchRef = useRef<((g: PendingGame) => void) | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    const ac = new AbortController();
    acRef.current = ac;

    // Fetch /api/game/{id} for both player names + ratings; populate state if we still
    // have nothing for that color (don't clobber a featured event payload that did carry
    // player info).
    const populatePlayers = async (gameId: string) => {
      const info = await fetchGameInfo(gameId, ac.signal).catch(() => null);
      if (!info) return;
      setState((s) => {
        if (s.gameId !== gameId) return s;
        return {
          ...s,
          sente: s.sente ?? fromGameInfo(info.players.sente),
          gote: s.gote ?? fromGameInfo(info.players.gote),
        };
      });
    };

    // Apply a queued PendingGame to the live state. Used both immediately on the very first
    // game (no current game to defer behind) and later when applyPendingNow is invoked.
    const commitGameSwitch = (g: PendingGame) => {
      lastGameIdRef.current = g.id;
      const commitAt = Date.now();
      setState((s) => ({
        ...s,
        gameId: g.id,
        sfen: g.sfen,
        lm: g.lm,
        sente: g.sente,
        gote: g.gote,
        gameSeq: s.gameSeq + 1,
        pendingGame: null,
      }));
      // Always refresh from /game/export on commit: during the deferred 5s wait we drop
      // SSE sfen events (see the t === "sfen" handler) to keep the board from jumping
      // ahead of the rest of the UI, so g.sfen — which came from the featured payload at
      // queue time — may be several moves stale by the time we actually switch.
      void fetchInitialPosition(g.id, ac.signal)
        .then((initial) => {
          if (!initial) return;
          setState((s) => {
            if (s.gameId !== g.id) return s;
            // Defer to a fresh post-commit SSE update if one has already landed: any
            // sfen event delivered after commitAt is newer than the export snapshot.
            if ((s.sfenAt ?? 0) > commitAt) return s;
            return { ...s, sfen: initial.sfen, lm: initial.lm, sfenAt: Date.now() };
          });
        })
        .catch(() => {});
      // Populate player names from /api/game/{id} in case the featured payload didn't.
      void populatePlayers(g.id);
    };
    commitGameSwitchRef.current = commitGameSwitch;

    // Best-effort initial channel fetch to populate player names + a snapshot of the
    // current position by replaying the move list — without this, the board stays empty
    // until the next move is broadcast over SSE (which can take 0-60s).
    fetchChannels(ac.signal)
      .then(async (channels) => {
        const std = channels.standard;
        if (!std) return;
        setState((s) => {
          if (s.gameId) return s; // featured event already arrived
          lastGameIdRef.current = std.gameId;
          return { ...s, gameId: std.gameId, sente: fromChannel(std) };
        });
        await Promise.all([
          fetchInitialPosition(std.gameId, ac.signal)
            .then((initial) => {
              if (!initial) return;
              setState((s) =>
                s.sfen ? s : { ...s, sfen: initial.sfen, lm: initial.lm, sfenAt: Date.now() },
              );
            })
            .catch(() => {}),
          populatePlayers(std.gameId),
        ]);
      })
      .catch(() => {
        // Non-fatal; the SSE feed will eventually carry a featured event.
      });

    const feed = startTvFeed({
      onStatus: (status) => setState((s) => ({ ...s, status })),
      onEvent: (ev: TvEvent) => {
        if (ev.t === "sfen") {
          // While a pending game switch is queued, the lishogi TV channel has already
          // rotated to the next game on its end, so subsequent sfen events most likely
          // describe the *next* game rather than the one we're still showing. Drop
          // them — commitGameSwitch will refresh the board from /game/export so we
          // pick up the latest position when the deferred switch actually fires.
          if (stateRef.current.pendingGame) {
            console.log("[shogitv:sse] sfen dropped (pendingGame)", { lm: (ev.d as { lm?: string }).lm });
            return;
          }
          const d = ev.d as { sfen: string; lm?: string };
          console.log("[shogitv:sse] sfen", { sfen: d.sfen.slice(-30), lm: d.lm });
          setState((s) => ({
            ...s,
            sfen: d.sfen,
            lm: d.lm ?? null,
            posSeq: s.posSeq + 1,
            sfenAt: Date.now(),
          }));
        } else if (ev.t === "featured") {
          const d = ev.d as {
            id: string;
            sfen?: string;
            players?: TvFeaturedPlayer[];
          };
          if (d.id === lastGameIdRef.current) {
            console.log("[shogitv:sse] featured (same id, skip)", { id: d.id });
            return;
          }
          if (stateRef.current.pendingGame?.id === d.id) {
            console.log("[shogitv:sse] featured (already pending, skip)", { id: d.id });
            return;
          }
          console.log("[shogitv:sse] featured", { id: d.id, hasSfen: !!d.sfen });
          const incoming: PendingGame = {
            id: d.id,
            sfen: d.sfen ?? null,
            lm: null,
            sente: pickColor(d.players, "sente"),
            gote: pickColor(d.players, "gote"),
          };
          // First-ever game (initial load via SSE alone) → apply immediately. Subsequent
          // featured events stock the next game as pending; the consumer (App.tsx) commits
          // it via applyPendingNow once the current game has been finished long enough for
          // the user to read the result banner.
          if (lastGameIdRef.current === null) {
            commitGameSwitchRef.current?.(incoming);
          } else {
            setState((s) => ({ ...s, pendingGame: incoming }));
          }
        }
      },
    });

    feedRef.current = feed;

    // When the tab returns to visible after being backgrounded, audit the current
    // state against the lishogi server: the SSE connection may have been throttled
    // or silently dropped while hidden, so we may have missed a featured rotation
    // and/or sfen events for the current game. If we find a divergence, force the
    // SSE to reconnect so the live stream is healthy again.
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      const gameId = stateRef.current.gameId;
      if (!gameId) {
        feed.forceReconnect();
        return;
      }
      let needsReconnect = false;
      // Has lishogi rotated the featured game while we were hidden?
      try {
        const channels = await fetchChannels(ac.signal);
        const std = channels.standard;
        if (
          std &&
          std.gameId !== gameId &&
          stateRef.current.pendingGame?.id !== std.gameId
        ) {
          setState((s) => ({
            ...s,
            pendingGame: {
              id: std.gameId,
              sfen: null,
              lm: null,
              sente: fromChannel(std),
              gote: null,
            },
          }));
          needsReconnect = true;
        }
      } catch {
        // Network blip; keep going.
      }
      // Has the current game advanced beyond what we last saw via SSE? Skip during
      // a deferred switch — sfen events are dropped on purpose then, and
      // commitGameSwitch will refresh from export when it actually fires.
      //
      // Uses /game/export?clocks=1 (KIF) rather than /game/export (JSON moves) for
      // the position check: the KIF parser already reconstructs sfen via shogiops
      // (see gameExport.ts), and the periodic poll path is on KIF anyway — using
      // it here too keeps the visibility audit consistent and avoids carrying the
      // JSON-moves endpoint just for this one comparison.
      if (!stateRef.current.pendingGame) {
        try {
          const exp = await fetchGameExport(gameId, ac.signal);
          const sfen = exp.sfen;
          const lm = exp.lm ?? null;
          if (sfen && sfen !== stateRef.current.sfen) {
            setState((s) => {
              if (s.gameId !== gameId) return s;
              if (s.sfen === sfen) return s;
              return {
                ...s,
                sfen,
                lm,
                posSeq: s.posSeq + 1,
                sfenAt: Date.now(),
              };
            });
            needsReconnect = true;
          }
        } catch {
          // Same.
        }
      }
      if (needsReconnect) feed.forceReconnect();
    };
    document.addEventListener("visibilitychange", onVisible);

    return () => {
      ac.abort();
      feed.stop();
      feedRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const forceReconnect = () => {
    feedRef.current?.forceReconnect();
  };
  const applyRecovery = (gameId: string, sfen: string, lm: string | null) => {
    setState((s) => {
      // Don't overwrite if the user has already moved on to a different game.
      if (s.gameId !== gameId) {
        console.log("[shogitv:recov] gameId mismatch, skip", { wanted: gameId, current: s.gameId });
        return s;
      }
      // Don't overwrite if SSE has already delivered a fresher sfen than what we're recovering.
      if (s.sfen === sfen) {
        console.log("[shogitv:recov] dedup (same sfen)", { tail: sfen.slice(-30) });
        return s;
      }
      console.log("[shogitv:recov] UPDATE", { from: s.sfen?.slice(-30), to: sfen.slice(-30), lm });
      return { ...s, sfen, lm, posSeq: s.posSeq + 1, sfenAt: Date.now() };
    });
  };
  const applyPendingNow = () => {
    const pending = stateRef.current.pendingGame;
    if (!pending) return;
    commitGameSwitchRef.current?.(pending);
  };

  return { ...state, forceReconnect, applyRecovery, applyPendingNow };
}
