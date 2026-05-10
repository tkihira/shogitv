import { useEffect, useMemo, useRef } from "react";
import { Shogiground } from "shogiground";
import { standardToForsyth } from "shogiground/sfen";
import type { Api } from "shogiground/api";
import type { Color, Key, RoleString } from "shogiground/types";

export type KingBadge = "win" | "loss" | "draw";
const BADGE_TEXT: Record<KingBadge, string> = { win: "勝", loss: "負", draw: "=" };

const ROLES: RoleString[] = [
  "rook",
  "bishop",
  "gold",
  "silver",
  "knight",
  "lance",
  "pawn",
];

function forsythToRole(s: string): RoleString | undefined {
  const lc = s.toLowerCase();
  switch (lc) {
    case "p":
      return "pawn";
    case "+p":
      return "tokin";
    case "l":
      return "lance";
    case "+l":
      return "promotedlance";
    case "n":
      return "knight";
    case "+n":
      return "promotedknight";
    case "s":
      return "silver";
    case "+s":
      return "promotedsilver";
    case "g":
      return "gold";
    case "b":
      return "bishop";
    case "+b":
      return "horse";
    case "r":
      return "rook";
    case "+r":
      return "dragon";
    case "k":
      return "king";
    default:
      return undefined;
  }
}

function splitSfen(sfen: string | null): { board?: string; hands?: string; turn: Color } {
  if (!sfen) return { turn: "sente" };
  const parts = sfen.trim().split(/\s+/);
  const board = parts[0];
  const turn = parts[1] === "w" ? "gote" : "sente";
  const hands = parts[2] && parts[2] !== "-" ? parts[2] : "";
  return { board, hands, turn };
}

function parseUsiSquares(usi: string | null | undefined): Key[] {
  if (!usi) return [];
  // Promotion suffix '+'
  const move = usi.endsWith("+") ? usi.slice(0, -1) : usi;
  // Drop notation: "P*5e" — only one square
  if (move.length >= 3 && move[1] === "*") {
    return [parseUsiSquare(move.slice(2)) ?? ""].filter(Boolean) as Key[];
  }
  if (move.length >= 4) {
    const a = parseUsiSquare(move.slice(0, 2));
    const b = parseUsiSquare(move.slice(2, 4));
    return [a, b].filter(Boolean) as Key[];
  }
  return [];
}

// USI uses files as digits (1-9, sente right) and ranks as letters a-i (sente bottom).
// Shogiground keys are `${file}${rank}` where file is 1-9 and rank is 'a'..'i'.
function parseUsiSquare(s: string): Key | null {
  if (s.length < 2) return null;
  const file = s[0];
  const rank = s[1];
  if (!/^[1-9]$/.test(file)) return null;
  if (!/^[a-i]$/.test(rank)) return null;
  return `${file}${rank}` as Key;
}

/** Walk the board portion of an SFEN ("lnsgkgsnl/1r5b1/...") and return the squares
 * that hold each side's king. Ranks run a→i (top→bottom from sente's POV); within a
 * rank the SFEN reads file 9 → file 1 (left → right when shown sente-up). */
function findKingSquares(boardSfen: string | undefined): { sente?: Key; gote?: Key } {
  if (!boardSfen) return {};
  const ranks = boardSfen.split("/");
  if (ranks.length !== 9) return {};
  let sente: Key | undefined;
  let gote: Key | undefined;
  for (let r = 0; r < 9; r++) {
    let file = 9;
    for (let i = 0; i < ranks[r].length; i++) {
      const c = ranks[r][i];
      if (c >= "1" && c <= "9") {
        file -= parseInt(c, 10);
        continue;
      }
      if (c === "+") continue; // promotion prefix doesn't consume a file slot
      if (c === "K" || c === "k") {
        const rank = String.fromCharCode("a".charCodeAt(0) + r);
        const key = `${file}${rank}` as Key;
        if (c === "K") sente = key;
        else gote = key;
      }
      file -= 1;
    }
  }
  return { sente, gote };
}

/** Map a shogi square (file/rank) to a 1-based 9×9 grid cell, accounting for the
 * viewer's orientation so the badge lands on the right square visually. */
function squareToGridCell(key: Key, orientation: Color): { col: number; row: number } {
  const file = parseInt(key[0], 10);
  const rankIdx = key.charCodeAt(1) - "a".charCodeAt(0);
  if (orientation === "sente") {
    // file 1 (sente's right) on the right; rank a (gote's back) on the top.
    return { col: 10 - file, row: rankIdx + 1 };
  }
  // gote orientation flips both axes 180°.
  return { col: file, row: 9 - rankIdx };
}

type Props = {
  sfen: string | null;
  lm: string | null;
  orientation: Color;
  /** When set, draws a badge in the top-right corner of each king's square so the
   * winner / loser is obvious at a glance from the board alone. */
  kingBadges?: { sente: KingBadge; gote: KingBadge };
};

export function Board({ sfen, lm, orientation, kingBadges }: Props) {
  const boardRef = useRef<HTMLDivElement>(null);
  const handTopRef = useRef<HTMLDivElement>(null);
  const handBottomRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);
  const kingSquares = useMemo(() => findKingSquares(splitSfen(sfen).board), [sfen]);

  // Initialize once.
  useEffect(() => {
    if (!boardRef.current || !handTopRef.current || !handBottomRef.current) return;
    const api = Shogiground(
      {
        viewOnly: true,
        coordinates: { enabled: true, files: "numeric", ranks: "japanese" },
        hands: { inlined: false, roles: ROLES },
        highlight: { lastDests: true, check: true },
        forsyth: { fromForsyth: forsythToRole, toForsyth: standardToForsyth },
        animation: { enabled: true, duration: 200 },
        movable: { free: false },
        droppable: { free: false },
        draggable: { enabled: false },
        selectable: { enabled: false },
        drawable: { enabled: false },
      },
      {
        board: boardRef.current,
        hands: { top: handTopRef.current, bottom: handBottomRef.current },
      },
    );
    apiRef.current = api;
    return () => {
      api.destroy();
      apiRef.current = null;
    };
  }, []);

  // Sync SFEN, last move, orientation.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    const { board, hands } = splitSfen(sfen);
    api.set({
      sfen: { board, hands },
      orientation,
      lastDests: parseUsiSquares(lm),
    });
  }, [sfen, lm, orientation]);

  return (
    <div className={`board-area orientation-${orientation}`}>
      <div ref={handTopRef} className="hand hand-top" />
      <div className="sg-wrap">
        <div ref={boardRef} />
        {kingBadges && (kingSquares.sente || kingSquares.gote) ? (
          <div className="king-badges" aria-hidden="true">
            {kingSquares.sente ? (
              <div
                className={`king-badge-cell corner-${badgeCorner("sente", orientation)}`}
                style={cellStyle(kingSquares.sente, orientation)}
              >
                <span className={`king-badge ${kingBadges.sente}`}>
                  {BADGE_TEXT[kingBadges.sente]}
                </span>
              </div>
            ) : null}
            {kingSquares.gote ? (
              <div
                className={`king-badge-cell corner-${badgeCorner("gote", orientation)}`}
                style={cellStyle(kingSquares.gote, orientation)}
              >
                <span className={`king-badge ${kingBadges.gote}`}>
                  {BADGE_TEXT[kingBadges.gote]}
                </span>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div ref={handBottomRef} className="hand hand-bottom" />
    </div>
  );
}

function cellStyle(key: Key, orientation: Color): React.CSSProperties {
  const { col, row } = squareToGridCell(key, orientation);
  return { gridColumn: col, gridRow: row };
}

/** Pick which corner of the king's square the badge sits in. The near-side king
 * (whose color matches the viewer's orientation) gets top-right; the far-side king
 * (drawn upside-down by shogiground) gets bottom-left so the badge feels "above the
 * piece's head" from the opposing player's POV — matches the rotated piece naturally
 * even though we don't rotate the badge glyph itself. Reactive on `orientation`, so
 * pressing the flip-board button mid-result swaps both badges to the right corner. */
function badgeCorner(kingColor: Color, orientation: Color): "tr" | "bl" {
  return kingColor === orientation ? "tr" : "bl";
}
