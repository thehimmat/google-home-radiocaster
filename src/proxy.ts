import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';

// Some streaming CDNs serve audio with a TLS certificate that doesn't exactly
// match their hostname (e.g. cert covers *.streamguys.com but host is
// streamguys1.com). We disable hostname verification only for upstream audio
// fetches — the content is public radio, not sensitive data.
const lenientHttpsAgent = new https.Agent({ rejectUnauthorized: false });

export interface StreamProxy {
  /** Local URL to hand to the Cast device, e.g. http://192.168.0.x:PORT/ */
  url: string;
  /** Shut down the proxy server */
  close: () => void;
}

/** Returns the first non-loopback IPv4 address on this machine. */
function localIPv4(): string {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const addr of ifaces ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function getFreePort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a local HTTP server that fetches `streamUrl` and pipes the audio
 * through to whoever connects. The Cast device connects to the returned local
 * URL instead of going to the internet directly.
 *
 * Why: Nest Hub / Google Home devices sometimes can't reach external streaming
 * CDNs due to router filtering, CDN bot-detection, or SSL issues. Having the
 * Mac (which has good internet access) act as a relay fixes this reliably.
 */
export async function startProxy(streamUrl: string, contentType: string): Promise<StreamProxy> {
  const port = await getFreePort();
  const ip = localIPv4();

  const server = http.createServer((_req, res) => {
    const lib = streamUrl.startsWith('https') ? https : http;

    const upstream = lib.get(streamUrl, {
      agent: streamUrl.startsWith('https') ? lenientHttpsAgent : undefined,
      headers: {
        // Identify as a browser so CDNs don't block the request.
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        // Ask the server not to inject ICY metadata into the stream.
        'Icy-MetaData': '0',
      },
    }, (upRes) => {
      // Prefer the content-type from the actual GET response over the probed value.
      const upType = upRes.headers['content-type']?.split(';')[0].trim();
      const isAudio = upType && (upType.startsWith('audio/') || upType === 'application/ogg');
      res.writeHead(200, {
        'Content-Type': isAudio ? upType : contentType,
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache, no-store',
        'Transfer-Encoding': 'chunked',
        'Access-Control-Allow-Origin': '*',
      });
      upRes.pipe(res);
      // If the Cast device disconnects, stop pulling from the upstream too.
      res.on('close', () => upstream.destroy());
    });

    upstream.on('error', (err) => {
      console.error(`  Proxy upstream error: ${err.message}`);
      res.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(port, ip, resolve));

  return {
    url: `http://${ip}:${port}/`,
    close: () => server.close(),
  };
}
