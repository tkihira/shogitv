import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Board } from "./components/Board";
import { GameHeader } from "./components/GameHeader";
import { EvalBar } from "./components/EvalBar";
import { EvalScore } from "./components/EvalScore";
import { ClockRow, ClockMeta, GameResultBanner } from "./components/Clocks";
import { useTvFeed } from "./hooks/useTvFeed";
import { useEngine } from "./hooks/useEngine";
import { useClocks } from "./hooks/useClocks";
import type { TvFeaturedPlayer } from "./feed/tvFeed";

export default function App() {
  const tv = useTvFeed();
  const clocks = useClocks({
    gameId: tv.gameId,
    gameSeq: tv.gameSeq,
    posSeq: tv.posSeq,
    sfen: tv.sfen,
  });
  const { state: engine, analyze, newGame } = useEngine();
  const [orientation, setOrientation] = useState<"sente" | "gote">("sente");
  const lastAnalyzedRef = useRef<string | null>(null);
  const lastGameSeqRef = useRef<number>(0);

  // Prefer the /api/game/{id} snapshot for both player names — the TV channels endpoint
  // only carries one side and the TV feed's featured event payload is sparse.
  const sente = useMemo<TvFeaturedPlayer | null>(() => {
    const g = clocks.game?.players.sente;
    if (g) {
      const userId = g.user?.id ?? g.userId;
      const name = g.user?.name ?? userId;
      return userId && name
        ? { user: { id: userId, name, title: g.user?.title }, rating: g.rating, ai: g.ai }
        : tv.sente;
    }
    return tv.sente;
  }, [clocks.game, tv.sente]);

  const gote = useMemo<TvFeaturedPlayer | null>(() => {
    const g = clocks.game?.players.gote;
    if (g) {
      const userId = g.user?.id ?? g.userId;
      const name = g.user?.name ?? userId;
      return userId && name
        ? { user: { id: userId, name, title: g.user?.title }, rating: g.rating, ai: g.ai }
        : tv.gote;
    }
    return tv.gote;
  }, [clocks.game, tv.gote]);

  // When the featured game changes, reset the engine TT.
  useEffect(() => {
    if (tv.gameSeq !== lastGameSeqRef.current) {
      lastGameSeqRef.current = tv.gameSeq;
      newGame();
    }
  }, [tv.gameSeq, newGame]);

  // Preserve the user's scroll position across game changes. The TV switch causes a layout
  // shrink that cascades through several React commits (gameSeq → INITIAL clocks → empty
  // engine snapshot → eventually the new game's data lands). On short viewports — iPhone
  // landscape especially — the shrink can drop total content below the viewport so the
  // browser clamps scrollY to 0 ("returns to top"). The cleanup captures pre-change scroll,
  // and the body re-asserts it across several rAFs to outlast the transient settling.
  const savedScrollRef = useRef(0);
  useLayoutEffect(() => {
    const targetY = savedScrollRef.current;
    savedScrollRef.current = 0;
    let cancelled = false;
    const restoreFor = [0, 50, 150, 350, 700];
    const timers = targetY > 0
      ? restoreFor.map((dt) =>
          window.setTimeout(() => {
            if (cancelled) return;
            if (window.scrollY < targetY) window.scrollTo(0, targetY);
          }, dt),
        )
      : [];
    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
      savedScrollRef.current = window.scrollY;
    };
  }, [tv.gameSeq]);

  // Submit each new SFEN to the engine once it's ready.
  useEffect(() => {
    if (engine.status === "loading" || engine.status === "error") return;
    if (!tv.sfen) return;
    if (tv.sfen === lastAnalyzedRef.current) return;
    lastAnalyzedRef.current = tv.sfen;
    const turn = tv.sfen.split(/\s+/)[1] === "w" ? "gote" : "sente";
    analyze(tv.sfen, turn);
  }, [tv.sfen, engine.status, analyze]);

  return (
    <div className="app">
      <GameHeader gameId={tv.gameId} sente={sente} gote={gote} feedStatus={tv.status} />
      <main className="layout">
        <div className="board-stack">
          <ClockRow state={clocks} color={orientation === "sente" ? "gote" : "sente"} />
          <Board sfen={tv.sfen} lm={tv.lm} orientation={orientation} />
          <ClockRow state={clocks} color={orientation} />
          <ClockMeta state={clocks} />
          <GameResultBanner state={clocks} />
          <button
            type="button"
            className="flip-btn"
            onClick={() => setOrientation((o) => (o === "sente" ? "gote" : "sente"))}
            aria-label="盤を反転"
          >
            盤を反転
          </button>
        </div>
        <aside className="side-panel">
          <EvalBar snapshot={engine.snapshot} />
          <EvalScore
            snapshot={engine.snapshot}
            status={engine.status}
            threads={engine.threads}
            isolated={engine.isolated}
            sfen={tv.sfen}
            lm={tv.lm}
          />
          {engine.errorMessage ? (
            <div className="error-banner">
              <strong>engine error:</strong> {engine.errorMessage}
            </div>
          ) : null}
        </aside>
      </main>
      <footer className="app-footer">
        <span>
          source: <a href="https://lishogi.org/tv" target="_blank" rel="noreferrer">lishogi TV</a>
        </span>
        <span>engine: YaneuraOu NNUE K-P (WASM, GPL-3.0)</span>
      </footer>
    </div>
  );
}
