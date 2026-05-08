import type { EngineSnapshot } from "../engine/engineClient";
import type { EngineStatus } from "../engine/engineClient";

type Props = {
  snapshot: EngineSnapshot | null;
  status: EngineStatus;
  threads: number;
  isolated: boolean;
};

function formatScore(s: EngineSnapshot): { value: string; sub: string } {
  const senteSign = s.turn === "sente" ? 1 : -1;
  if (s.mate !== undefined) {
    const senteWinning = s.mate > 0 ? s.turn === "sente" : s.turn === "gote";
    return {
      value: `${senteWinning ? "+" : "-"}M${Math.abs(s.mate)}`,
      sub: senteWinning ? "先手勝勢" : "後手勝勢",
    };
  }
  if (s.cp !== undefined) {
    const senteCp = s.cp * senteSign;
    const sign = senteCp >= 0 ? "+" : "";
    return {
      value: `${sign}${(senteCp / 100).toFixed(2)}`,
      sub: senteCp > 0 ? "先手有利" : senteCp < 0 ? "後手有利" : "互角",
    };
  }
  return { value: "—", sub: "" };
}

export function EvalScore({ snapshot, status, threads, isolated }: Props) {
  const score = snapshot ? formatScore(snapshot) : null;
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
        {snapshot?.depth !== undefined ? <span className="depth">depth {snapshot.depth}</span> : null}
        <span className="threads">{threads}T{isolated ? "" : " (no SAB)"}</span>
      </div>
      {snapshot?.pv && snapshot.pv.length > 0 ? (
        <div className="pv">
          <span className="pv-label">読み筋</span>
          <code className="pv-line">{snapshot.pv.slice(0, 12).join(" ")}</code>
        </div>
      ) : null}
    </section>
  );
}
