import type { EngineSnapshot } from "../engine/engineClient";

type Props = {
  snapshot: EngineSnapshot | null;
};

/**
 * Map a centipawn value (sente-positive) to a 0..1 ratio for the bar fill.
 * Uses a soft squashing so big numbers don't visually clip too hard.
 */
function cpToRatio(cp: number): number {
  const clamped = Math.max(-2000, Math.min(2000, cp));
  const sign = Math.sign(clamped);
  const k = 0.0035;
  const t = sign * (1 - Math.exp(-Math.abs(clamped) * k));
  return 0.5 + t * 0.5;
}

export function EvalBar({ snapshot }: Props) {
  if (!snapshot) {
    return <div className="eval-bar idle" aria-label="評価値なし" />;
  }
  // Snapshot is from side-to-move's POV. Convert to sente-positive.
  const senteSign = snapshot.turn === "sente" ? 1 : -1;
  let ratio = 0.5;
  let label = "0";
  if (snapshot.mate !== undefined) {
    const senteWinning = snapshot.mate > 0 ? snapshot.turn === "sente" : snapshot.turn === "gote";
    ratio = senteWinning ? 1 : 0;
    label = `${senteWinning ? "+" : "-"}M${Math.abs(snapshot.mate)}`;
  } else if (snapshot.cp !== undefined) {
    const senteCp = snapshot.cp * senteSign;
    ratio = cpToRatio(senteCp);
    label = (senteCp >= 0 ? "+" : "") + (senteCp / 100).toFixed(1);
  }
  const sentePct = `${(ratio * 100).toFixed(2)}%`;
  return (
    <div className="eval-bar" aria-label={`評価値 ${label}`}>
      <div className="bar-track">
        <div className="bar-fill sente" style={{ height: sentePct }} />
      </div>
      <div className="bar-label">{label}</div>
    </div>
  );
}
