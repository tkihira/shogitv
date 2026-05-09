export type TvSfenEvent = {
  t: "sfen";
  d: { sfen: string; lm?: string };
};

export type TvFeaturedPlayer = {
  color?: "sente" | "gote";
  user?: { id: string; name: string; title?: string };
  rating?: number;
  ai?: number;
};

export type TvFeaturedEvent = {
  t: "featured";
  d: {
    id: string;
    sfen?: string;
    orientation?: "sente" | "gote";
    players?: TvFeaturedPlayer[];
  };
};

export type TvEvent = TvSfenEvent | TvFeaturedEvent | { t: string; d: unknown };

export type TvFeedHandlers = {
  onEvent: (ev: TvEvent) => void;
  onStatus?: (status: "connecting" | "open" | "closed") => void;
};

export type TvFeedHandle = {
  stop: () => void;
  /** Close the current EventSource and immediately reconnect — used to recover from
   * "zombie" SSE connections that go silent without firing onerror. */
  forceReconnect: () => void;
};

const FEED_URL = "https://lishogi.org/api/tv/feed";

export function startTvFeed(handlers: TvFeedHandlers): TvFeedHandle {
  let es: EventSource | null = null;
  let stopped = false;
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (stopped) return;
    handlers.onStatus?.("connecting");
    es = new EventSource(FEED_URL);
    es.onopen = () => {
      backoffMs = 1000;
      handlers.onStatus?.("open");
    };
    es.onmessage = (msg) => {
      try {
        const ev = JSON.parse(msg.data) as TvEvent;
        handlers.onEvent(ev);
      } catch {
        // ignore malformed lines
      }
    };
    es.onerror = () => {
      handlers.onStatus?.("closed");
      es?.close();
      es = null;
      if (stopped) return;
      reconnectTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    };
  };

  connect();
  return {
    stop: () => {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      es = null;
    },
    forceReconnect: () => {
      if (stopped) return;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      es?.close();
      es = null;
      backoffMs = 1000; // recovery attempt — start fresh, don't punish with backoff
      connect();
    },
  };
}
