import { useEffect, useRef } from "react";
import { Shogiground } from "shogiground";
import { standardToForsyth } from "shogiground/sfen";
import type { Api } from "shogiground/api";
import type { Color, Key, RoleString } from "shogiground/types";

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

type Props = {
  sfen: string | null;
  lm: string | null;
  orientation: Color;
};

export function Board({ sfen, lm, orientation }: Props) {
  const boardRef = useRef<HTMLDivElement>(null);
  const handTopRef = useRef<HTMLDivElement>(null);
  const handBottomRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<Api | null>(null);

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
      </div>
      <div ref={handBottomRef} className="hand hand-bottom" />
    </div>
  );
}
