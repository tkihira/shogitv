/**
 * KIF-format game export with `clocks=1` query parameter.
 * Documented endpoint with CORS open: gives exact per-move clock consumption
 * for both ongoing and finished games, plus a result line that reveals the
 * winner and end status (resign / timeout / mate / etc.).
 *
 * Also replays the Japanese-notation move list through shogiops to reconstruct
 * a 3-part SFEN + last USI move, so a single KIF fetch covers both clocks AND
 * board state — no separate /game/export JSON moves fetch needed for periodic
 * board refresh.
 */

import { parseSfen, makeSfen } from "shogiops/sfen";
import { parseKifMoveOrDrop } from "shogiops/notation/kif";
import { makeUsi } from "shogiops/util";
import type { Square } from "shogiops/types";

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
  /** 3-part SFEN ("<board> <turn> <hand>") reconstructed by replaying the KIF
   * move list. Lets a periodic KIF poll double as a board-state refresh without
   * a separate /game/export JSON moves fetch. Undefined if move parsing failed
   * partway (we never want a wrong sfen → discard rather than corrupt). */
  sfen?: string;
  /** Last move in USI form (e.g. "9a3a+", "P*5e"), derived from the parsed
   * move list. Undefined if there were no moves or parsing failed. */
  lm?: string;
};

const STANDARD_INITIAL_SFEN =
  "lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1";

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

// "持ち時間：10分" / "持ち時間：5分+30秒" / "持ち時間：3分30秒+10秒" / "持ち時間：15秒+1秒"
// (super-bullet, no minutes at all). Both 分 and 秒 segments of the main time are
// optional and either may appear alone — without the seconds-only path the bullet
// games slip through with initial=0/byoyomi=0 and ClockRow hides itself entirely.
const RE_TIME = /持ち時間：(?:(\d+)分)?(?:(\d+)秒)?(?:\+(\d+)秒)?/;
// "  103   ４四龍(54)   (00:08/00:04:22)" — captures the move token (group 2) so
// we can replay through shogiops/notation/kif. The lazy .*? + the trailing \s+
// before the clock paren ensures the move text doesn't swallow the trailing
// whitespace.
const RE_MOVE = /^\s*(\d+)\s+(\S.*?)\s+\((\d+):(\d+)\/(\d+):(\d+):(\d+)\)\s*$/;
// "  104   投了" / "  96   切れ負け" / "詰み" / "反則勝ち" / "引き分け" / "中断" /
// "千日手" / "持将棋" / "入玉宣言勝ち" / etc. We deliberately match *any* non-clock
// label here so unrecognised endings still set finished=true and the deferred game
// switch fires — anything new lishogi adds in the future falls through to "unknown"
// rather than causing the TV to freeze on a long-finished game.
const RE_END = /^\s*(\d+)\s+(\S.*?)\s*$/;
// Summary line: "まで101手で先手の勝ち" / "まで150手で持将棋" / "まで66手で千日手" /
// "まで100手で引き分け". Some KIF outputs (notably checkmate where the mating move is
// just a normal move) only carry this trailing summary with no explicit "<ply> <label>"
// terminator, so we fall back to it when RE_END doesn't fire.
const RE_SUMMARY = /^まで(\d+)手で(.+?)\s*$/;
// English-locale terminator (lishogi sometimes emits these as KIF "comments" prefixed
// with "*"): "* Gote resigns." / "* Sente was checkmated." / "* Time forfeit by sente." /
// "* Draw by repetition." / "* Game aborted." / etc. Lishogi seems to default to this
// form for some games (e.g. m8k1T2dU has just `* Gote resigns.` and no Japanese
// terminator at all), so without this branch the parser silently treats those games as
// still ongoing and the deferred TV switch never fires.
const RE_KIF_COMMENT = /^\s*\*\s*(.+?)\s*$/;
const RE_EN_END_KEYWORD = /\b(?:resigns?|checkmated?|forfeits?|time(?:[\s-]+(?:up|forfeit|out))?|ran\s+out|jishogi|impasse|repetition|aborted?|stalemate|draw\b|wins?)\b/i;

function parseEnglishTerminator(content: string): { labelJp: string; winner?: "sente" | "gote" } | null {
  if (!RE_EN_END_KEYWORD.test(content)) return null;
  let winner: "sente" | "gote" | undefined;
  let loser: "sente" | "gote" | undefined;
  if (/\bsente\s+wins?\b/i.test(content)) winner = "sente";
  else if (/\bgote\s+wins?\b/i.test(content)) winner = "gote";
  else if (/\bsente\s+(?:resigns?|(?:was\s+|is\s+)?checkmated|forfeits?|ran\s+out|made\s+an\s+illegal)/i.test(content)) loser = "sente";
  else if (/\bgote\s+(?:resigns?|(?:was\s+|is\s+)?checkmated|forfeits?|ran\s+out|made\s+an\s+illegal)/i.test(content)) loser = "gote";
  else if (/(?:resign|checkmat|forfeit|illegal).*\bby\s+sente\b/i.test(content)) loser = "sente";
  else if (/(?:resign|checkmat|forfeit|illegal).*\bby\s+gote\b/i.test(content)) loser = "gote";
  if (!winner && loser) winner = loser === "sente" ? "gote" : "sente";

  let labelJp = "終局";
  if (/resign/i.test(content)) labelJp = "投了";
  else if (/checkmat/i.test(content)) labelJp = "詰み";
  else if (/forfeit|ran\s+out|time[\s-]*(out|up|forfeit)/i.test(content)) labelJp = "切れ負け";
  else if (/repetition/i.test(content)) labelJp = "千日手";
  else if (/impasse|jishogi/i.test(content)) labelJp = "持将棋";
  else if (/illegal/i.test(content)) labelJp = "反則";
  else if (/abort/i.test(content)) labelJp = "中断";
  else if (/stalemate/i.test(content)) labelJp = "ステイルメイト";
  else if (/\bdraw\b/i.test(content)) labelJp = "引き分け";

  return { labelJp, winner };
}

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
  // From an explicit "<ply> <label>" terminator line (RE_END).
  let endLineLabel: string | undefined;
  // From the trailing "まで<ply>手で<...>" summary line (RE_SUMMARY).
  let summaryStatus: string | undefined;
  let summaryWinner: "sente" | "gote" | undefined;
  // Move tokens collected for shogiops replay → sfen + lm reconstruction.
  const moveTokens: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const tm = line.match(RE_TIME);
    if (tm) {
      const minutes = tm[1] ? parseInt(tm[1], 10) : 0;
      const mainSec = tm[2] ? parseInt(tm[2], 10) : 0;
      initial = minutes * 60 + mainSec;
      byoyomi = tm[3] ? parseInt(tm[3], 10) : 0;
      continue;
    }
    const mm = line.match(RE_MOVE);
    if (mm) {
      const ply = parseInt(mm[1], 10);
      // Groups: 1=ply, 2=move token, 3-7=(consumed MM:SS / cumulative HH:MM:SS)
      const cumH = parseInt(mm[5], 10);
      const cumM = parseInt(mm[6], 10);
      const cumS = parseInt(mm[7], 10);
      const cumulativeMs = ((cumH * 60 + cumM) * 60 + cumS) * 1000;
      lastPly = ply;
      // Odd plies = sente moves, even = gote moves.
      if (ply % 2 === 1) senteUsedMs = cumulativeMs;
      else goteUsedMs = cumulativeMs;
      moveTokens.push(mm[2]);
      continue;
    }
    // English terminator comment (e.g. "* Gote resigns.") — check before RE_END since
    // it starts with "*" not a digit, so it'd just be ignored otherwise.
    const cm = line.match(RE_KIF_COMMENT);
    if (cm) {
      const en = parseEnglishTerminator(cm[1]);
      if (en) {
        finished = true;
        // English terminator gives us the localised label and an explicit winner —
        // both are more authoritative than a Japanese summary "X の勝ち" (which only
        // tells us the winner, not the reason), so let it override.
        summaryStatus = en.labelJp;
        if (en.winner) summaryWinner = en.winner;
        continue;
      }
      // Other "*"-prefixed commentary lines: just ignore.
    }
    // Summary check before RE_END — RE_END is permissive and could otherwise swallow it.
    const sm = line.match(RE_SUMMARY);
    if (sm) {
      const ply = parseInt(sm[1], 10);
      if (ply > lastPly) lastPly = ply;
      // Don't overwrite a more specific English terminator label.
      if (!summaryStatus || summaryStatus === sm[2]) summaryStatus = sm[2];
      if (!summaryWinner) {
        if (sm[2] === "先手の勝ち") summaryWinner = "sente";
        else if (sm[2] === "後手の勝ち") summaryWinner = "gote";
      }
      finished = true;
      continue;
    }
    const em = line.match(RE_END);
    if (em) {
      lastPly = parseInt(em[1], 10);
      endLineLabel = em[2];
      finished = true;
      continue;
    }
  }

  // Pick the most informative end label we found.
  let endStatusRaw: string | undefined;
  if (endLineLabel) {
    endStatusRaw = endLineLabel;
  } else if (summaryStatus) {
    // Synthesise "詰み" only for the Japanese summary "X の勝ち" form (which carries
    // a winner but not a reason — checkmate is the overwhelming cause, since resign
    // / outoftime / declaration always carry their own terminator). English
    // terminators set summaryStatus directly to a localised label like "投了" /
    // "詰み" / "切れ負け" / etc., so use that as-is.
    if (summaryStatus === "先手の勝ち" || summaryStatus === "後手の勝ち") {
      endStatusRaw = "詰み";
    } else {
      endStatusRaw = summaryStatus;
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
  if (finished) {
    if (endLineLabel === "投了" || endLineLabel === "切れ負け" || endLineLabel === "詰み") {
      // Explicit end-line: the lastPly is the would-be move of the side who DIDN'T
      // play (resigned / ran out / got mated). They're the loser; the other wins.
      const loser: "sente" | "gote" = lastPly % 2 === 1 ? "sente" : "gote";
      winner = loser === "sente" ? "gote" : "sente";
    } else if (endLineLabel?.startsWith("入玉宣言")) {
      // Entering-king declaration: the declarer is the side whose turn it was
      // and they win outright by declaring instead of moving.
      winner = lastPly % 2 === 1 ? "sente" : "gote";
    } else if (summaryWinner) {
      // Summary-only fallback (e.g. mate where the mating move IS the lastPly so
      // the parity heuristic above would invert): trust the explicit "X の勝ち".
      winner = summaryWinner;
    }
    // 引き分け / 中断 / 反則 / 千日手 / 持将棋 / unknown: leave winner undefined.
  }

  // Replay the KIF Japanese-notation move list through shogiops to derive a
  // 3-part SFEN + last USI move. All-or-nothing: if any token fails to parse or
  // apply (out-of-spec KIF, illegal sequence, unsupported variant move), drop
  // both sfen and lm rather than ship a corrupted intermediate position.
  let sfen: string | undefined;
  let lm: string | undefined;
  const setup = parseSfen("standard", STANDARD_INITIAL_SFEN);
  if (setup.isOk) {
    const pos = setup.value;
    let lastDest: Square | undefined;
    let parseFailed = false;
    for (const tok of moveTokens) {
      const md = parseKifMoveOrDrop(tok, lastDest);
      if (!md) {
        parseFailed = true;
        break;
      }
      try {
        pos.play(md);
        lastDest = md.to;
        lm = makeUsi(md);
      } catch {
        parseFailed = true;
        break;
      }
    }
    if (!parseFailed) {
      sfen = makeSfen(pos).split(/\s+/).slice(0, 3).join(" ");
    } else {
      lm = undefined; // discard partial result
    }
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
    sfen,
    lm,
  };
}
