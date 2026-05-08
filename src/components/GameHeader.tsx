import type { TvFeaturedPlayer } from "../feed/tvFeed";

type Props = {
  gameId: string | null;
  sente: TvFeaturedPlayer | null;
  gote: TvFeaturedPlayer | null;
  feedStatus: "connecting" | "open" | "closed";
};

function name(p: TvFeaturedPlayer | null): string {
  if (!p) return "?";
  const u = p.user;
  if (!u) return p.ai ? `AI Lv.${p.ai}` : "?";
  return u.title ? `${u.title} ${u.name}` : u.name;
}

export function GameHeader({ gameId, sente, gote, feedStatus }: Props) {
  return (
    <header className="game-header">
      <div className="players">
        <div className="player sente">
          <span className="dot" aria-hidden />
          <span className="player-name">{name(sente)}</span>
          {sente?.rating ? <span className="rating">{sente.rating}</span> : null}
        </div>
        <div className="vs">vs</div>
        <div className="player gote">
          <span className="dot" aria-hidden />
          <span className="player-name">{name(gote)}</span>
          {gote?.rating ? <span className="rating">{gote.rating}</span> : null}
        </div>
      </div>
      <div className="meta">
        <span className={`feed-status ${feedStatus}`} title={`feed: ${feedStatus}`}>
          {feedStatus === "open" ? "● live" : feedStatus === "connecting" ? "… connecting" : "○ offline"}
        </span>
        {gameId ? (
          <a className="game-link" href={`https://lishogi.org/${gameId}`} target="_blank" rel="noreferrer">
            {gameId}
          </a>
        ) : null}
      </div>
    </header>
  );
}
