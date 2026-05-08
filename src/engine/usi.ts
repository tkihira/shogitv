export type EngineEval = {
  cp?: number;
  mate?: number;
  depth?: number;
  pv?: string[];
  /** Side-to-move sign convention. true = sente was to move when this score was emitted. */
  senteToMove: boolean;
};

export type ParsedInfo = {
  /** USI MultiPV rank (1 = best). Defaults to 1 if the engine omits the field. */
  multipv: number;
  depth?: number;
  cp?: number;
  mate?: number;
  pv?: string[];
};

/**
 * Parse a single USI `info ...` line into a partial eval. Returns undefined for
 * lines that don't carry a score.
 */
export function parseInfoLine(line: string): ParsedInfo | undefined {
  if (!line.startsWith("info")) return undefined;
  const tokens = line.split(/\s+/);
  let multipv = 1;
  let depth: number | undefined;
  let cp: number | undefined;
  let mate: number | undefined;
  let pv: string[] | undefined;
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "multipv") {
      multipv = parseInt(tokens[++i], 10);
    } else if (tok === "depth") {
      depth = parseInt(tokens[++i], 10);
    } else if (tok === "score") {
      const kind = tokens[++i];
      const val = parseInt(tokens[++i], 10);
      if (kind === "cp") cp = val;
      else if (kind === "mate") mate = val;
    } else if (tok === "pv") {
      pv = tokens.slice(i + 1);
      break;
    } else if (tok === "string") {
      // ignore string-style info
      return undefined;
    }
  }
  if (cp === undefined && mate === undefined && pv === undefined && depth === undefined) {
    return undefined;
  }
  return { multipv, depth, cp, mate, pv };
}

export function isBestmoveLine(line: string): boolean {
  return line.startsWith("bestmove");
}
