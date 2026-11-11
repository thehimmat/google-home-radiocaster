import Hls from 'hls.js';
import type { Station } from './types';

export type Transport = 'hls.js' | 'native-hls' | 'raw-aac';

/**
 * Transport priority: hls.js where MSE exists (Chrome, Firefox, Edge),
 * native HLS otherwise (Safari/iOS), and the raw ADTS stream as the last
 * resort. Split out for tests — capabilities are injected.
 */
export function pickTransport(hlsJsSupported: boolean, nativeHls: boolean): Transport {
  if (hlsJsSupported) return 'hls.js';
  if (nativeHls) return 'native-hls';
  return 'raw-aac';
}

export interface PlaybackState {
  paused: boolean;
  currentTime: number;
  /** End of the seekable range (HLS: the newest segment's end), NaN if none. */
  seekableEnd: number;
  /** End of the buffered audio, NaN if none. */
  bufferedEnd: number;
  /** hls.js's own estimate of the distance from the live edge, NaN if none. */
  hlsLatency: number;
}

/**
 * Seconds behind live the listener hears, so lyrics from the live follower can wait for them.
 * HLS players start a few segments behind the newest (hls.js: 3 x 6 s); the raw stream arrives
 * from the live edge, so whatever is buffered ahead of playback is the delay. 0 when not playing
 * or when the numbers make no sense.
 */
export function playbackLatency(transport: Transport, s: PlaybackState): number {
  if (s.paused) return 0;
  let behind: number;
  if (transport === 'hls.js' && Number.isFinite(s.hlsLatency) && s.hlsLatency > 0) behind = s.hlsLatency;
  else if (transport === 'raw-aac') behind = s.bufferedEnd - s.currentTime;
  else behind = s.seekableEnd - s.currentTime;
  return Number.isFinite(behind) && behind > 0 && behind < 120 ? behind : 0;
}

/** Wraps one <audio> element and whichever HLS transport the browser supports. */
export class LocalPlayer {
  private hls: Hls | null = null;

  constructor(private readonly audio: HTMLAudioElement) {}

  get transport(): Transport {
    return pickTransport(
      Hls.isSupported(),
      this.audio.canPlayType('application/vnd.apple.mpegurl') !== '',
    );
  }

  async play(station: Station): Promise<void> {
    this.detach();
    const transport = this.transport;

    if (transport === 'hls.js') {
      this.hls = new Hls();
      this.hls.loadSource(station.hlsUrl);
      this.hls.attachMedia(this.audio);
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || !this.hls) return;
        // Standard hls.js recovery dance; anything else falls through to a
        // fresh attach on the next user play.
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) this.hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) this.hls.recoverMediaError();
      });
    } else if (transport === 'native-hls') {
      this.audio.src = station.hlsUrl;
    } else {
      this.audio.src = station.streamUrl;
    }

    await this.audio.play();
  }

  pause(): void {
    this.audio.pause();
  }

  /** Stop playback and release the stream (pausing live HLS still downloads). */
  stop(): void {
    this.audio.pause();
    this.detach();
  }

  setVolume(level: number): void {
    this.audio.volume = Math.max(0, Math.min(1, level));
  }

  get playing(): boolean {
    return !this.audio.paused;
  }

  /** Seconds behind live the listener hears (see playbackLatency). */
  latencySec(): number {
    const a = this.audio;
    const end = (r: TimeRanges) => (r.length ? r.end(r.length - 1) : NaN);
    return playbackLatency(this.transport, {
      paused: a.paused,
      currentTime: a.currentTime,
      seekableEnd: end(a.seekable),
      bufferedEnd: end(a.buffered),
      hlsLatency: this.hls?.latency ?? NaN,
    });
  }

  private detach(): void {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.audio.removeAttribute('src');
    this.audio.load();
  }
}
