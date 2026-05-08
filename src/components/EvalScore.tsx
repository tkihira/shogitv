import { useMemo } from "react";
import type { EnginePvLine, EngineSnapshot, EngineStatus } from "../engine/engineClient";
import { usiPvToJapanese } from "../engine/pvNotation";

type Props = {
  snapshot: EngineSnapshot | null;
  status: EngineStatus;
  threads: number;
  isolated: boolean;
  sfen: string | null;
  lm: string | null;
};

/**
 * Categorize a sente-positive cp value (or mate) into a Japanese descriptor.
 * Thresholds: ≤300 互角 / ≤800 有利 / ≤1500 優勢 / それ以上(と詰み) 勝勢.
 */
function categorize(senteCp: number, isMate: boolean): string {
  if (isMate) return senteCp > 0 ? "先手勝勢" : "後手勝勢";
  const abs = Math.abs(senteCp);
  if (abs <= 300) return "互角";
  const prefix = senteCp > 0 ? "先手" : "後手";
  if (abs <= 800) return `${prefix}有利`;
  if (abs <= 1500) return `${prefix}優勢`;
  return `${prefix}勝勢`;
}

function formatScore(line: EnginePvLine, turn: "sente" | "gote"): { value: string; sub: string } {
  const senteSign = turn === "sente" ? 1 : -1;
  if (line.mate !== undefined) {
    const senteWinning = line.mate > 0 ? turn === "sente" : turn === "gote";
    const senteSignedCp = senteWinning ? 1 : -1; // sign only — feeds the categorizer
    return {
      value: `${senteWinning ? "+" : "-"}M${Math.abs(line.mate)}`,
      sub: categorize(senteSignedCp, true),
    };
  }
  if (line.cp !== undefined) {
    const senteCp = line.cp * senteSign;
    const sign = senteCp >= 0 ? "+" : "";
    return {
      value: `${sign}${senteCp}`,
      sub: categorize(senteCp, false),
    };
  }
  return { value: "—", sub: "" };
}

function formatScoreShort(line: EnginePvLine, turn: "sente" | "gote"): string {
  const senteSign = turn === "sente" ? 1 : -1;
  if (line.mate !== undefined) {
    const senteWinning = line.mate > 0 ? turn === "sente" : turn === "gote";
    return `${senteWinning ? "+" : "-"}M${Math.abs(line.mate)}`;
  }
  if (line.cp !== undefined) {
    const senteCp = line.cp * senteSign;
    return (senteCp >= 0 ? "+" : "") + senteCp;
  }
  return "—";
}

export function EvalScore({ snapshot, status, threads, isolated, sfen, lm }: Props) {
  const best = snapshot?.lines[0] ?? null;
  const score = snapshot && best ? formatScore(best, snapshot.turn) : null;

  // Convert each PV line to Japanese once per snapshot/sfen change.
  const lineDisplays = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.lines.map((ln) => ({
      multipv: ln.multipv,
      score: formatScoreShort(ln, snapshot.turn),
      pv: usiPvToJapanese(sfen, lm, ln.pv).slice(0, 10).join(" "),
    }));
  }, [snapshot, sfen, lm]);

  return (
    <section className="eval-score">
      <div className="row primary">
        <div className="value">{score?.value ?? "—"}</div>
        <div className="caption">{score?.sub ?? "評価待ち"}</div>
      </div>
      <div className="row meta">
        <span className={`engine-status ${status}`}>
          {status === "loading"
            ? "engine 起動中…"
            : status === "searching"
              ? "探索中"
              : status === "idle"
                ? "待機中"
                : "エラー"}
        </span>
        {best?.depth !== undefined ? <span className="depth">depth {best.depth}</span> : null}
        <span className="threads">{threads}T{isolated ? "" : " (no SAB)"}</span>
      </div>
      {lineDisplays.length > 0 ? (
        <div className="pv-list">
          <span className="pv-label">読み筋</span>
          <ol className="pv-lines">
            {lineDisplays.map((d) => (
              <li key={d.multipv} className={d.multipv === 1 ? "pv-row best" : "pv-row"}>
                <span className="pv-score">{d.score}</span>
                <span className="pv-line">{d.pv}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
    </section>
  );
}
