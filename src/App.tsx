import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Board, type KingBadge } from "./components/Board";
import { GameHeader } from "./components/GameHeader";
import { EvalBar } from "./components/EvalBar";
import { EvalScore } from "./components/EvalScore";
import { ClockRow, ClockMeta, GameResultBanner } from "./components/Clocks";
import { useTvFeed } from "./hooks/useTvFeed";
import { useEngine } from "./hooks/useEngine";
import { useClocks } from "./hooks/useClocks";
import type { TvFeaturedPlayer } from "./feed/tvFeed";
import { fetchInitialPosition } from "./feed/replayMoves";

export default function App() {
  const tv = useTvFeed();
  const clocks = useClocks({
    gameId: tv.gameId,
    gameSeq: tv.gameSeq,
    posSeq: tv.posSeq,
    sfen: tv.sfen,
    sfenAt: tv.sfenAt,
    onSseLag: (gameId) => {
      // SSE went silent while the game advanced. Force-reconnect AND patch in the missed
      // position via /game/export so the user sees the latest state without waiting for
      // the next move to wake the SSE up.
      tv.forceReconnect();
      void fetchInitialPosition(gameId)
        .then((p) => {
          if (p) tv.applyRecovery(gameId, p.sfen, p.lm);
        })
        .catch(() => {});
    },
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

  // Defer queued game switches until 5 seconds after the current game finishes, so the user
  // gets to read the result banner before the TV moves on. tv.pendingGame is the next id
  // that lishogi has sent via SSE `featured` but we haven't committed yet.
  //
  // Single effect (rather than splitting "set finishedAt" and "start timer" into two): keeps
  // the anchor and the timer in the same closure so we can never read a stale finishedAtRef
  // from a sibling effect that hasn't run yet.
  const finishedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (!clocks.finished) {
      finishedAtRef.current = null;
      return;
    }
    if (finishedAtRef.current === null) finishedAtRef.current = Date.now();
    if (!tv.pendingGame) return;
    const elapsed = Date.now() - finishedAtRef.current;
    const remaining = Math.max(0, 5000 - elapsed);
    const t = window.setTimeout(() => tv.applyPendingNow(), remaining);
    return () => window.clearTimeout(t);
  }, [clocks.finished, tv.pendingGame, tv.applyPendingNow]);

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

  // Result badges to drop on each king's square once the game is finished. Winner gets
  // a white "勝", loser a black "負"; draws (千日手 / 持将棋 / 引き分け / 中断 / etc.)
  // get a grey "=" on both sides.
  const kingBadges = useMemo<{ sente: KingBadge; gote: KingBadge } | undefined>(() => {
    if (!clocks.finished) return undefined;
    if (clocks.winner === "sente") return { sente: "win", gote: "loss" };
    if (clocks.winner === "gote") return { sente: "loss", gote: "win" };
    return { sente: "draw", gote: "draw" };
  }, [clocks.finished, clocks.winner]);

  return (
    <div className="app">
      <GameHeader gameId={tv.gameId} sente={sente} gote={gote} feedStatus={tv.status} />
      <main className="layout">
        <div className="board-stack">
          <ClockRow
            state={clocks}
            color={orientation === "sente" ? "gote" : "sente"}
            player={orientation === "sente" ? gote : sente}
          />
          <div className="board-with-bar">
            <Board sfen={tv.sfen} lm={tv.lm} orientation={orientation} kingBadges={kingBadges} />
            <EvalBar snapshot={engine.snapshot} />
          </div>
          <ClockRow
            state={clocks}
            color={orientation}
            player={orientation === "sente" ? sente : gote}
          />
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
          data: <a href="https://lishogi.org/tv" target="_blank" rel="noreferrer">lishogi TV</a>
        </span>
        <span>engine: YaneuraOu NNUE K-P (WASM, GPL-3.0)</span>
        <span>
          source: <a
            href="https://github.com/tkihira/shogitv"
            target="_blank"
            rel="noreferrer"
          >github.com/tkihira/shogitv</a> (GPL-3.0+)
        </span>
      </footer>
    </div>
  );
}
