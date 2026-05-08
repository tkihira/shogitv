import { parseSfen } from "shogiops/sfen";
import { parseUsi } from "shogiops/util";
import { makeJapaneseMoveOrDrop } from "shogiops/notation/japanese";

/**
 * Convert an engine PV (USI move strings) into Japanese kifu notation
 * (e.g. "▲７六歩 △８四歩 ▲２六歩 △８五歩 ▲２五歩 △同　角"). Falls back to the
 * raw USI tokens on any parse error.
 */
export function usiPvToJapanese(sfen: string | null, lm: string | null, pv: string[] | undefined): string[] {
  if (!sfen || !pv || pv.length === 0) return pv ?? [];
  // The TV feed omits the move number; shogiops' parseSfen requires it for "standard".
  const fullSfen = sfen.trim().split(/\s+/).length >= 4 ? sfen : `${sfen.trim()} 1`;
  const parsed = parseSfen("standard", fullSfen);
  if (!parsed.isOk) return pv;
  const pos = parsed.value;
  // Set lastMoveOrDrop from the lm field so that "同" notation works on the very first PV move.
  if (lm) {
    const lmMd = parseUsi(lm);
    if (lmMd) pos.lastMoveOrDrop = lmMd;
  }
  const out: string[] = [];
  let lastDest: number | undefined =
    pos.lastMoveOrDrop && "to" in pos.lastMoveOrDrop ? pos.lastMoveOrDrop.to : undefined;
  for (const usi of pv) {
    const md = parseUsi(usi);
    if (!md) break;
    const prefix = pos.turn === "sente" ? "▲" : "△";
    const j = makeJapaneseMoveOrDrop(pos, md, lastDest);
    if (!j) break;
    out.push(prefix + j);
    try {
      pos.play(md);
    } catch {
      break;
    }
    lastDest = md.to;
  }
  // If we couldn't produce anything useful, fall back to the raw USI tokens so the user still
  // gets *some* feedback rather than an empty PV line.
  return out.length > 0 ? out : pv;
}
