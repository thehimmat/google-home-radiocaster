// Minimal type declarations for the castv2-client package (no official @types exist).
declare module 'castv2-client' {
  export interface MediaInfo {
    contentId: string;
    contentType: string;
    streamType?: 'LIVE' | 'BUFFERED' | 'NONE';
    metadata?: {
      type: number;
      metadataType: number;
      title?: string;
    };
  }

  export interface VolumeRequest {
    level: number; // 0.0–1.0
  }

  export interface MediaStatus {
    playerState: 'IDLE' | 'PLAYING' | 'BUFFERING' | 'PAUSED';
    idleReason?: 'CANCELLED' | 'INTERRUPTED' | 'FINISHED' | 'ERROR';
  }

  export interface Player {
    load(
      media: MediaInfo,
      options: { autoplay: boolean },
      callback: (err: Error | null, status: MediaStatus) => void
    ): void;
    on(event: 'status', handler: (status: MediaStatus) => void): this;
  }

  export interface Application {
    appId: string;
    sessionId: string;
    displayName: string;
  }

  export interface DeviceStatus {
    applications?: Application[];
    volume: VolumeRequest;
  }

  export class Client {
    connect(host: string, callback: () => void): void;
    launch(
      app: unknown,
      callback: (err: Error | null, player: Player) => void
    ): void;
    stop(
      app: Application,
      callback: (err: Error | null) => void
    ): void;
    getStatus(callback: (err: Error | null, status: DeviceStatus) => void): void;
    setVolume(
      volume: VolumeRequest,
      callback: (err: Error | null, volume: VolumeRequest) => void
    ): void;
    close(): void;
    on(event: 'error', handler: (err: Error) => void): this;
  }

  // The Default Media Receiver app — plays audio/video without a custom receiver app.
  export const DefaultMediaReceiver: unknown;
}
