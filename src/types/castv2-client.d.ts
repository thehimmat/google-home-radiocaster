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
      app: typeof DefaultMediaReceiver,
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

  // Launchable receiver application. castv2-client reads the static APP_ID off
  // the class passed to launch() and instantiates it for the session, so custom
  // receivers are subclasses that override APP_ID (keeping the media channel).
  export class DefaultMediaReceiver {
    static APP_ID: string;
    constructor(client: unknown, session: unknown);
  }
}
