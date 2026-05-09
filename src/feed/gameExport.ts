/**
 * KIF-format game export with `clocks=1` query parameter.
 * Documented endpoint with CORS open: gives exact per-move clock consumption
 * for both ongoing and finished games, plus a result line that reveals the
 * winner and end status (resign / timeout / mate / etc.).
 */

export type EndStatus =
  | "resign"
  | "outoftime"
  | "mate"
  | "draw"
  | "aborted"
  | "illegal"
  | "repetition" // 千日手
  | "impasse" // 持将棋
  | "entering" // 入玉宣言勝ち
  | "unknown";

export type GameExport = {
  /** Main time, seconds. */
  initial: number;
  /** Byoyomi seconds (per period). 0 if sudden death or Fischer-only. */
  byoyomi: number;
  /** Total accumulated time used by sente up to and including their last move (ms). */
  senteUsedMs: number;
  /** Total accumulated time used by gote up to and including their last move (ms). */
  goteUsedMs: number;
  /** Number of plies played. 0 if no moves yet. */
  lastPly: number;
  /** Whose turn it is now (after lastPly). */
  turn: "sente" | "gote";
  finished: boolean;
  endStatus?: EndStatus;
  endStatusRaw?: string;
  winner?: "sente" | "gote";
};

const URL_BASE = "https://lishogi.org/game/export/";

export async function fetchGameExport(gameId: string, signal?: AbortSignal): Promise<GameExport> {
  const res = await fetch(`${URL_BASE}${encodeURIComponent(gameId)}?clocks=1`, {
    signal,
    // KIF is text/plain; no Accept needed
  });
  if (!res.ok) throw new Error(`game/export/${gameId}: HTTP ${res.status}`);
  const text = await res.text();
  return parseKif(text);
}

const RE_TIME = /持ち時間：(\d+)分(?:\+(\d+)秒)?/;
// "  103   ４四龍(54)   (00:08/00:04:22)"
const RE_MOVE = /^\s*(\d+)\s+\S.*?\((\d+):(\d+)\/(\d+):(\d+):(\d+)\)\s*$/;
// "  104   投了" / "  96   切れ負け" / "詰み" / "反則勝ち" / "引き分け" / "中断" /
// "千日手" / "持将棋" / "入玉宣言勝ち" / etc. We deliberately match *any* non-clock
// label here so unrecognised endings still set finished=true and the deferred game
// switch fires — anything new lishogi adds in the future falls through to "unknown"
// rather than causing the TV to freeze on a long-finished game.
const RE_END = /^\s*(\d+)\s+(\S.*?)\s*$/;

function parseEndStatus(raw: string): EndStatus {
  if (raw === "投了") return "resign";
  if (raw === "切れ負け") return "outoftime";
  if (raw === "詰み") return "mate";
  if (raw === "引き分け") return "draw";
  if (raw === "中断") return "aborted";
  if (raw === "千日手" || raw.includes("千日手")) return "repetition";
  if (raw === "持将棋") return "impasse";
  if (raw.startsWith("入玉宣言")) return "entering";
  if (raw.startsWith("反則")) return "illegal";
  return "unknown";
}

export function parseKif(text: string): GameExport {
  let initial = 0;
  let byoyomi = 0;
  let senteUsedMs = 0;
  let goteUsedMs = 0;
  let lastPly = 0;
  let finished = false;
  let endStatusRaw: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const tm = line.match(RE_TIME);
    if (tm) {
      initial = parseInt(tm[1], 10) * 60;
      byoyomi = tm[2] ? parseInt(tm[2], 10) : 0;
      continue;
    }
    const mm = line.match(RE_MOVE);
    if (mm) {
      const ply = parseInt(mm[1], 10);
      // (consumed-MM:SS / cumulative-HH:MM:SS)
      const cumH = parseInt(mm[4], 10);
      const cumM = parseInt(mm[5], 10);
      const cumS = parseInt(mm[6], 10);
      const cumulativeMs = ((cumH * 60 + cumM) * 60 + cumS) * 1000;
      lastPly = ply;
      // Odd plies = sente moves, even = gote moves.
      if (ply % 2 === 1) senteUsedMs = cumulativeMs;
      else goteUsedMs = cumulativeMs;
      continue;
    }
    const em = line.match(RE_END);
    if (em) {
      lastPly = parseInt(em[1], 10);
      endStatusRaw = em[2];
      finished = true;
      continue;
    }
  }

  // Sente plays odd plies (1, 3, 5, …); gote plays even plies (2, 4, 6, …).
  // For ongoing games: after `lastPly` actual moves, the *next* mover is the opposite side.
  //   lastPly even → sente to move; odd → gote to move.
  // For finished games: the end-line uses `lastPly` for the *would-be* ply that became
  //   "投了" / "切れ負け" / "詰み" instead of a move. The player associated with that ply
  //   is the loser. lastPly odd → sente was due to move (sente lost); even → gote.
  const turnAfterMoves: "sente" | "gote" = lastPly % 2 === 0 ? "sente" : "gote";

  let winner: "sente" | "gote" | undefined;
  if (finished && endStatusRaw) {
    if (endStatusRaw === "投了" || endStatusRaw === "切れ負け" || endStatusRaw === "詰み") {
      // The lastPly is the would-be move of the side who DIDN'T play (resigned /
      // ran out / got mated). They're the loser; the other side wins.
      const loser: "sente" | "gote" = lastPly % 2 === 1 ? "sente" : "gote";
      winner = loser === "sente" ? "gote" : "sente";
    } else if (endStatusRaw.startsWith("入玉宣言")) {
      // Entering-king declaration: the declarer is the side whose turn it was
      // and they win outright by declaring instead of moving.
      winner = lastPly % 2 === 1 ? "sente" : "gote";
    }
    // 引き分け / 中断 / 反則 / 千日手 / 持将棋 / unknown: leave winner undefined.
  }

  return {
    initial,
    byoyomi,
    senteUsedMs,
    goteUsedMs,
    lastPly,
    turn: turnAfterMoves,
    finished,
    endStatus: endStatusRaw ? parseEndStatus(endStatusRaw) : undefined,
    endStatusRaw,
    winner,
  };
}
