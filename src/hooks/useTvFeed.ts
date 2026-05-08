import { useEffect, useRef, useState } from "react";
import { fetchChannels, type TvChannel } from "../feed/tvChannels";
import { startTvFeed, type TvEvent, type TvFeaturedPlayer } from "../feed/tvFeed";

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
};

function pickColor(players: TvFeaturedPlayer[] | undefined, color: "sente" | "gote"): TvFeaturedPlayer | null {
  if (!players) return null;
  return players.find((p) => p.color === color) ?? null;
}

function fromChannel(ch: TvChannel): TvFeaturedPlayer {
  return { user: { id: ch.user.id, name: ch.user.name, title: ch.user.title }, rating: ch.rating };
}

export function useTvFeed(): TvState {
  const [state, setState] = useState<TvState>(INITIAL);
  const lastGameIdRef = useRef<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();

    // Best-effort initial channel fetch to populate player names before the first
    // featured event arrives.
    fetchChannels(ac.signal)
      .then((channels) => {
        const std = channels.standard;
        if (!std) return;
        setState((s) => {
          if (s.gameId) return s; // featured event already arrived
          lastGameIdRef.current = std.gameId;
          return {
            ...s,
            gameId: std.gameId,
            // We have only one player from this endpoint; render best-effort as sente.
            sente: fromChannel(std),
          };
        });
      })
      .catch(() => {
        // Non-fatal; the SSE feed will eventually carry a featured event.
      });

    const stop = startTvFeed({
      onStatus: (status) => setState((s) => ({ ...s, status })),
      onEvent: (ev: TvEvent) => {
        if (ev.t === "sfen") {
          const d = ev.d as { sfen: string; lm?: string };
          setState((s) => ({ ...s, sfen: d.sfen, lm: d.lm ?? null, posSeq: s.posSeq + 1 }));
        } else if (ev.t === "featured") {
          const d = ev.d as {
            id: string;
            sfen?: string;
            players?: TvFeaturedPlayer[];
          };
          if (d.id === lastGameIdRef.current) return;
          lastGameIdRef.current = d.id;
          setState((s) => ({
            ...s,
            gameId: d.id,
            sfen: d.sfen ?? s.sfen,
            lm: null,
            sente: pickColor(d.players, "sente"),
            gote: pickColor(d.players, "gote"),
            gameSeq: s.gameSeq + 1,
            posSeq: s.posSeq + 1,
          }));
        }
      },
    });

    return () => {
      ac.abort();
      stop();
    };
  }, []);

  return state;
}
