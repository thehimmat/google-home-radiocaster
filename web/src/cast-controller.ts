import type { Station } from './types';

// Google Cast Web Sender integration. Chrome (desktop/Android) injects the
// framework via the gstatic script in index.html and does device discovery
// itself; this module only manages the session and what plays on it.
// On browsers without Cast (iOS, Firefox) onAvailable simply never fires and
// the Cast UI stays hidden — local playback is unaffected.

// Receiver app: the custom "Stream atTheBunga" receiver (branded now-playing
// screen, registered in the Cast console). While unpublished it only works on
// devices registered there as test devices — set VITE_CAST_APP_ID=CC1AD845 to
// fall back to the stock Default Media Receiver.
const CAST_APP_ID: string = import.meta.env?.VITE_CAST_APP_ID ?? '85E83F4E';

declare global {
  interface Window {
    /**
     * Resolved by the inline script in index.html, which must define
     * __onGCastApiAvailable BEFORE the async gstatic script executes —
     * a module script here would lose that race.
     */
    castApiReady?: Promise<boolean>;
  }
}

export interface CastCallbacks {
  /** Fired once the framework is ready — reveal the Cast button. */
  onAvailable: () => void;
  /** Fired when a session starts or ends. */
  onCastingChange: (casting: boolean) => void;
}

export class CastController {
  private remotePlayer: cast.framework.RemotePlayer | null = null;
  private remoteController: cast.framework.RemotePlayerController | null = null;

  constructor(private readonly callbacks: CastCallbacks) {
    // No castApiReady (Firefox/iOS/tests) → Cast UI just never appears.
    void window.castApiReady?.then((available) => {
      if (available) this.init();
    });
  }

  get casting(): boolean {
    return cast.framework.CastContext.getInstance().getCurrentSession() !== null;
  }

  /**
   * Opens the Cast device picker. Crucially, this is also what kicks off
   * Chrome's device discovery: Chrome will not scan the network for Cast
   * devices until a user gesture requests it, so an always-visible button that
   * calls this on click is far more reliable than <google-cast-launcher>, which
   * stays invisible until devices happen to be discovered (a catch-22 that left
   * users with no button to click). Rejects if the user dismisses the picker.
   */
  async requestSession(): Promise<void> {
    if (!window.cast?.framework) return;
    await cast.framework.CastContext.getInstance().requestSession();
  }

  /** Load (or switch) the station playing on the connected device. */
  async loadStation(station: Station): Promise<void> {
    const session = cast.framework.CastContext.getInstance().getCurrentSession();
    if (!session) return;

    // Cast devices get the raw AAC stream — proven more reliable than HLS on
    // Nest Hub, and the same URL the CLI casts.
    const mediaInfo = new chrome.cast.media.MediaInfo(station.streamUrl, 'audio/aac');
    mediaInfo.streamType = chrome.cast.media.StreamType.LIVE;

    const metadata = new chrome.cast.media.MusicTrackMediaMetadata();
    metadata.title = station.title;
    metadata.artist = station.subtitle ?? 'Gurbani Radio';
    if (station.artworkUrl) metadata.images = [new chrome.cast.Image(station.artworkUrl)];
    mediaInfo.metadata = metadata;

    await session.loadMedia(new chrome.cast.media.LoadRequest(mediaInfo));
  }

  playOrPause(): void {
    this.remoteController?.playOrPause();
  }

  setVolume(level: number): void {
    if (!this.remotePlayer || !this.remoteController) return;
    this.remotePlayer.volumeLevel = Math.max(0, Math.min(1, level));
    this.remoteController.setVolumeLevel();
  }

  stop(): void {
    cast.framework.CastContext.getInstance().endCurrentSession(true);
  }

  private init(): void {
    const context = cast.framework.CastContext.getInstance();
    context.setOptions({
      receiverApplicationId: CAST_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    this.remotePlayer = new cast.framework.RemotePlayer();
    this.remoteController = new cast.framework.RemotePlayerController(this.remotePlayer);

    context.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (event) => {
        const started =
          event.sessionState === cast.framework.SessionState.SESSION_STARTED ||
          event.sessionState === cast.framework.SessionState.SESSION_RESUMED;
        const ended = event.sessionState === cast.framework.SessionState.SESSION_ENDED;
        if (started) this.callbacks.onCastingChange(true);
        if (ended) this.callbacks.onCastingChange(false);
      },
    );

    this.callbacks.onAvailable();
  }
}
