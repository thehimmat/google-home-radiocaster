import { fetchHealth, fetchStations } from './api';
import { CastController } from './cast-controller';
import { LocalPlayer } from './player';
import type { Station } from './types';
import { UI } from './ui';

const HEALTH_POLL_MS = 30_000;

let stations: Station[] = [];
let selected: Station | null = null;
let casting = false;

const ui = new UI(document.getElementById('app') as HTMLElement, {
  onSelectStation: (slug) => void selectStation(slug),
  onTogglePlay: () => void togglePlay(),
  onVolume: (level) => {
    if (casting) castController.setVolume(level);
    else localPlayer.setVolume(level);
  },
  onCast: () => void startCast(),
});

const localPlayer = new LocalPlayer(ui.audio);

const castController = new CastController({
  onAvailable: () => ui.showCastButton(),
  onCastingChange: (nowCasting) => void onCastingChange(nowCasting),
});

async function selectStation(slug: string): Promise<void> {
  const station = stations.find((s) => s.slug === slug);
  if (!station) return;
  selected = station;
  ui.setSelected(slug);

  try {
    if (casting) {
      await castController.loadStation(station);
    } else {
      await localPlayer.play(station);
      ui.setPlaying(true);
    }
  } catch (err) {
    ui.setStatus('Playback failed — the stream may be starting up, try again.');
    console.error(err);
  }
}

async function togglePlay(): Promise<void> {
  if (casting) {
    castController.playOrPause();
    return;
  }
  if (localPlayer.playing) {
    // For live radio, pause means stop: resuming should rejoin the live edge,
    // not play stale buffer.
    localPlayer.stop();
    ui.setPlaying(false);
  } else {
    await selectStation((selected ?? stations[0])?.slug ?? '');
  }
}

async function startCast(): Promise<void> {
  // Make sure a station is chosen so onCastingChange has something to load.
  if (!selected && stations.length > 0) selected = stations[0];
  try {
    // Opens the picker and triggers discovery; on success the SESSION_STARTED
    // event drives onCastingChange, which loads the station onto the device.
    await castController.requestSession();
  } catch {
    // User dismissed the picker or picked nothing — nothing to report.
  }
}

async function onCastingChange(nowCasting: boolean): Promise<void> {
  casting = nowCasting;
  ui.setCasting(nowCasting);
  if (nowCasting) {
    localPlayer.stop();
    ui.setPlaying(false);
    // Cast button pressed with nothing selected: default to the first station
    // so the device starts playing without a second click.
    if (!selected && stations.length > 0) {
      await selectStation(stations[0].slug);
    } else if (selected) {
      await castController.loadStation(selected);
    }
  }
}

async function pollHealth(): Promise<void> {
  try {
    ui.setLive(await fetchHealth());
  } catch {
    // Health endpoint unreachable — leave the last known state.
  }
}

async function init(): Promise<void> {
  try {
    stations = await fetchStations();
  } catch (err) {
    ui.setStatus('Could not reach the stream server.');
    console.error(err);
    return;
  }
  ui.renderStations(stations);
  void pollHealth();
  setInterval(() => void pollHealth(), HEALTH_POLL_MS);
}

void init();
