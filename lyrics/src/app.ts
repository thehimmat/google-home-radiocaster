import http from 'http';

/** What a listener's screen should show for a station. Text is the corpus's, never ASR output. */
export interface NowPlaying {
  station: string;
  state: 'idle' | 'showing';
  reason: string;
  committed: boolean;
  /** Stream seconds (since this service started following the station) of the last change. */
  since: number;
  updatedAt: string;
  shabad: { id: string; source: string; section: string; page: number } | null;
  /** The current line: its position in the shabad and its text. */
  line: { index: number; text: string } | null;
  /** The whole shabad, so a client can show it with the current line highlighted. */
  lines: string[] | null;
}

export interface AppDeps {
  nowPlaying: (station: string) => NowPlaying | undefined;
  health: () => unknown;
}

export function createServer(deps: AppDeps): http.Server {
  return http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') return send(405, { error: 'GET only' });
    const url = new URL(req.url ?? '/', 'http://x');
    const m = url.pathname.match(/^\/now-playing\/([a-z0-9-]+)$/);
    if (m) {
      const np = deps.nowPlaying(m[1]);
      return np ? send(200, np) : send(404, { error: `not following ${m[1]}` });
    }
    if (url.pathname === '/health') return send(200, deps.health());
    send(404, { error: 'not found' });
  });
}
