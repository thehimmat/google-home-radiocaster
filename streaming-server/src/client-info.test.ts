import type { Request } from 'express';
import { describeClient } from './client-info';

function fakeReq(headers: Record<string, string>, remoteAddress?: string): Request {
  return {
    header: (name: string) => headers[name.toLowerCase()],
    socket: { remoteAddress },
  } as unknown as Request;
}

describe('describeClient', () => {
  it('prefers the Fly-Client-IP header over the socket address', () => {
    const req = fakeReq({ 'fly-client-ip': '203.0.113.7', 'user-agent': 'CrKey/1.56' }, '172.16.0.2');
    expect(describeClient(req)).toBe('ip=203.0.113.7 ua="CrKey/1.56"');
  });

  it('falls back to the socket address when not behind Fly', () => {
    const req = fakeReq({ 'user-agent': 'curl/8.0' }, '127.0.0.1');
    expect(describeClient(req)).toBe('ip=127.0.0.1 ua="curl/8.0"');
  });

  it('marks missing values as unknown', () => {
    expect(describeClient(fakeReq({}))).toBe('ip=unknown ua="unknown"');
  });

  it('strips quotes and newlines from the user-agent so one client stays one log line', () => {
    const req = fakeReq({ 'user-agent': 'evil"\nfake log line' }, '127.0.0.1');
    expect(describeClient(req)).toBe('ip=127.0.0.1 ua="evil fake log line"');
  });
});
