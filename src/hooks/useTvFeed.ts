import { useEffect, useRef, useState } from "react";
import { fetchChannels, type TvChannel } from "../feed/tvChannels";
import { startTvFeed, type TvEvent, type TvFeaturedPlayer } from "../feed/tvFeed";
import { fetchInitialPosition } from "../feed/replayMoves";
import { fetchGameInfo, type GamePlayer } from "../feed/gameInfo";

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
};

export type TvControls = {
  /** Force the SSE EventSource to reconnect (recovery from zombie connections). */
  forceReconnect: () => void;
  /** Apply an externally-derived sfen+lm — used when useClocks's polling pulls ahead of
   * the SSE feed and we replay moves to catch up. */
  applyRecovery: (gameId: string, sfen: string, lm: string | null) => void;
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

  useEffect(() => {
    const ac = new AbortController();

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
          const d = ev.d as { sfen: string; lm?: string };
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
          if (d.id === lastGameIdRef.current) return;
          lastGameIdRef.current = d.id;
          // Only bump gameSeq here — bumping posSeq too would race the gameSeq-driven
          // /api/game fetch (which carries player names) against the posSeq-driven sync
          // that aborts it. Subsequent SSE sfen events will naturally bump posSeq.
          setState((s) => ({
            ...s,
            gameId: d.id,
            sfen: d.sfen ?? null,
            lm: null,
            sente: pickColor(d.players, "sente"),
            gote: pickColor(d.players, "gote"),
            gameSeq: s.gameSeq + 1,
          }));
          // Even if the featured payload doesn't carry an sfen, derive the current
          // position so the board doesn't go blank between the switch and the next move.
          if (!d.sfen) {
            void fetchInitialPosition(d.id, ac.signal)
              .then((initial) => {
                if (!initial) return;
                setState((s) => {
                  if (s.gameId !== d.id || s.sfen) return s;
                  return { ...s, sfen: initial.sfen, lm: initial.lm, sfenAt: Date.now() };
                });
              })
              .catch(() => {});
          }
          // Populate player names from /api/game/{id} in case the featured payload didn't.
          void populatePlayers(d.id);
        }
      },
    });

    feedRef.current = feed;
    return () => {
      ac.abort();
      feed.stop();
      feedRef.current = null;
    };
  }, []);

  const forceReconnect = () => {
    feedRef.current?.forceReconnect();
  };
  const applyRecovery = (gameId: string, sfen: string, lm: string | null) => {
    setState((s) => {
      // Don't overwrite if the user has already moved on to a different game.
      if (s.gameId !== gameId) return s;
      // Don't overwrite if SSE has already delivered a fresher sfen than what we're recovering.
      if (s.sfen === sfen) return s;
      return { ...s, sfen, lm, posSeq: s.posSeq + 1, sfenAt: Date.now() };
    });
  };

  return { ...state, forceReconnect, applyRecovery };
}
