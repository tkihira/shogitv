import { isBestmoveLine, parseInfoLine, type ParsedInfo } from "./usi";

export type EngineSnapshot = {
  cp?: number;
  mate?: number;
  depth?: number;
  pv?: string[];
  /** "sente" | "gote" — whose turn it was when this score was reported. */
  turn: "sente" | "gote";
  /** monotonic counter incremented on each new search */
  jobId: number;
};

export type EngineStatus = "loading" | "idle" | "searching" | "error";

export type EngineEvents = {
  onSnapshot: (s: EngineSnapshot) => void;
  onStatus: (s: EngineStatus) => void;
  onError?: (err: string) => void;
};

const WORKER_URL = "/engine/worker-host.js";

export class EngineClient {
  private worker: Worker | null = null;
  private ready = false;
  private currentTurn: "sente" | "gote" = "sente";
  private jobId = 0;
  private pendingStop = false;
  private hasActiveSearch = false;
  private queued: { sfen: string; turn: "sente" | "gote"; movetime: number } | null = null;
  private readonly events: EngineEvents;

  constructor(events: EngineEvents) {
    this.events = events;
  }

  async start(threads: number) {
    this.events.onStatus("loading");
    const w = new Worker(WORKER_URL);
    this.worker = w;
    w.addEventListener("message", (ev) => this.onWorkerMessage(ev.data));
    w.onerror = (err) => {
      this.events.onError?.(err.message || "worker error");
      this.events.onStatus("error");
    };

    await new Promise<void>((resolve, reject) => {
      const listener = (ev: MessageEvent) => {
        const data = ev.data as { kind: string; message?: string };
        if (data.kind === "ready") {
          w.removeEventListener("message", listener);
          resolve();
        } else if (data.kind === "error") {
          w.removeEventListener("message", listener);
          reject(new Error(data.message ?? "engine init failed"));
        }
      };
      w.addEventListener("message", listener);
      w.postMessage({ kind: "init" });
    });

    await this.sendUntil("usi", (line) => line === "usiok");
    this.send(`setoption name Threads value ${Math.max(1, threads)}`);
    this.send("setoption name USI_Hash value 64");
    this.send("setoption name PvInterval value 0");
    this.send("setoption name MultiPV value 1");
    await this.sendUntil("isready", (line) => line === "readyok");
    this.send("usinewgame");
    this.ready = true;
    this.events.onStatus("idle");
  }

  /** Reset transposition table for a brand new game. */
  newGame() {
    if (!this.ready) return;
    if (this.hasActiveSearch) {
      this.send("stop");
    }
    this.send("usinewgame");
  }

  /**
   * Analyze a SFEN. If a search is in progress, stop it first and queue this one.
   * `movetime` is the search budget in milliseconds.
   */
  analyze(sfen: string, turn: "sente" | "gote", movetime: number) {
    if (!this.ready) return;
    this.queued = { sfen, turn, movetime };
    if (this.hasActiveSearch) {
      if (!this.pendingStop) {
        this.pendingStop = true;
        this.send("stop");
      }
    } else {
      this.kickQueued();
    }
  }

  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.ready = false;
  }

  private kickQueued() {
    if (!this.queued || !this.ready) return;
    const { sfen, turn, movetime } = this.queued;
    this.queued = null;
    this.currentTurn = turn;
    this.jobId++;
    this.hasActiveSearch = true;
    this.pendingStop = false;
    // Append a move counter (1) — lishogi TV SFEN omits it.
    this.send(`position sfen ${sfen} 1`);
    this.send(`go movetime ${movetime}`);
    this.events.onStatus("searching");
  }

  private onWorkerMessage(data: { kind: string; line?: string; message?: string }) {
    if (data.kind === "usi" && typeof data.line === "string") {
      const line = data.line;
      if (isBestmoveLine(line)) {
        this.hasActiveSearch = false;
        if (this.queued) {
          this.kickQueued();
        } else {
          this.events.onStatus("idle");
        }
        return;
      }
      const info: ParsedInfo | undefined = parseInfoLine(line);
      if (info && (info.cp !== undefined || info.mate !== undefined)) {
        this.events.onSnapshot({
          cp: info.cp,
          mate: info.mate,
          depth: info.depth,
          pv: info.pv,
          turn: this.currentTurn,
          jobId: this.jobId,
        });
      }
    } else if (data.kind === "error") {
      this.events.onError?.(data.message ?? "unknown engine error");
      this.events.onStatus("error");
    }
  }

  private send(line: string) {
    this.worker?.postMessage({ kind: "usi", line });
  }

  private sendUntil(line: string, predicate: (l: string) => boolean): Promise<void> {
    if (!this.worker) return Promise.reject(new Error("worker not started"));
    return new Promise((resolve) => {
      const w = this.worker!;
      const handler = (ev: MessageEvent) => {
        const d = ev.data as { kind: string; line?: string };
        if (d.kind === "usi" && typeof d.line === "string" && predicate(d.line)) {
          w.removeEventListener("message", handler);
          resolve();
        }
      };
      w.addEventListener("message", handler);
      this.send(line);
    });
  }
}
