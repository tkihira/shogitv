import { useEffect, useRef, useState } from "react";
import { EngineClient, type EngineSnapshot, type EngineStatus } from "../engine/engineClient";

const DEFAULT_MOVETIME_MS = 1500;

function pickThreads(): number {
  if (typeof self !== "undefined" && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated === false) {
    return 1;
  }
  const hw = navigator.hardwareConcurrency ?? 2;
  return Math.max(1, Math.min(4, hw - 1));
}

export type UseEngineState = {
  status: EngineStatus;
  snapshot: EngineSnapshot | null;
  threads: number;
  isolated: boolean;
  errorMessage: string | null;
};

export function useEngine() {
  const [state, setState] = useState<UseEngineState>({
    status: "loading",
    snapshot: null,
    threads: 0,
    isolated: typeof self !== "undefined" ? !!(self as { crossOriginIsolated?: boolean }).crossOriginIsolated : false,
    errorMessage: null,
  });
  const clientRef = useRef<EngineClient | null>(null);

  useEffect(() => {
    const threads = pickThreads();
    setState((s) => ({ ...s, threads }));
    const client = new EngineClient({
      onStatus: (status) => setState((s) => ({ ...s, status })),
      onSnapshot: (snap) => setState((s) => ({ ...s, snapshot: snap })),
      onError: (msg) => setState((s) => ({ ...s, errorMessage: msg })),
    });
    clientRef.current = client;
    client.start(threads).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, status: "error", errorMessage: msg }));
    });
    return () => {
      client.destroy();
      clientRef.current = null;
    };
  }, []);

  return {
    state,
    analyze: (sfen: string, turn: "sente" | "gote", movetime = DEFAULT_MOVETIME_MS) => {
      clientRef.current?.analyze(sfen, turn, movetime);
    },
    newGame: () => clientRef.current?.newGame(),
  };
}
