export type TvUser = {
  id: string;
  name: string;
  title?: string;
};

export type TvChannel = {
  user: TvUser;
  rating?: number;
  gameId: string;
};

export type TvChannels = Record<string, TvChannel>;

const URL = "https://lishogi.org/api/tv/channels";

export async function fetchChannels(signal?: AbortSignal): Promise<TvChannels> {
  const res = await fetch(URL, { signal });
  if (!res.ok) throw new Error(`tv/channels HTTP ${res.status}`);
  return (await res.json()) as TvChannels;
}
