import type { Request } from 'express';

/**
 * One-line "who is this" label for stream logs, e.g. `ip=203.0.113.7 ua="CrKey/1.56"`.
 *
 * On Fly, the socket address is Fly's internal proxy, so the real caller comes
 * from the Fly-Client-IP header. The user-agent is sanitized because it's
 * client-controlled and ends up in our logs verbatim.
 */
export function describeClient(req: Request): string {
  const ip = req.header('fly-client-ip') ?? req.socket.remoteAddress ?? 'unknown';
  const ua = (req.header('user-agent') ?? 'unknown').replace(/["\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  return `ip=${ip} ua="${ua}"`;
}
