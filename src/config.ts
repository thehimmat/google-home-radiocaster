// =============================================================================
// CONFIGURATION — this is the only file you need to edit
// =============================================================================
//
// HOW TO FIND A STATION'S STREAM URL:
//   Search "[Station name] direct stream MP3 URL" and look for a URL that ends
//   in .mp3 or .aac (NOT .m3u or .pls — those are playlists, not streams).
//   The station's website or a site like streamurl.site can help.
//
// CRON SYNTAX — five fields, left to right:
//   ┌─── minute       (0–59)
//   │  ┌─── hour      (0–23, 24-hour clock)
//   │  │  ┌─── day of month (1–31, or * for every day)
//   │  │  │  ┌─── month    (1–12, or * for every month)
//   │  │  │  │  ┌─── day of week (0=Sun, 1=Mon, 2=Tue … 6=Sat)
//   │  │  │  │  │
//   *  *  *  *  *
//
//   Examples:
//     "0 7 * * 1-5"   → 7:00 am, Monday through Friday
//     "30 8 * * 6,0"  → 8:30 am, Saturday and Sunday
//     "0 6 * * *"     → 6:00 am, every day
//
// HOW TO FIND YOUR DEVICE NAME:
//   Open the Google Home app, tap the device, and look at the name at the top.
//   Use that exact string here (case-insensitive). Example: "Living Room display"
//
// FALLBACK — if mDNS discovery doesn't find your device, add a `deviceIp` field
//   to a schedule entry (e.g. deviceIp: "192.168.1.42") and it will skip
//   discovery and connect directly. Find the IP in your router's device list
//   or in the Google Home app under device settings.
// =============================================================================

export interface StationConfig {
  /** Direct audio stream URL */
  url: string;
  /** Display title shown on the Cast device screen */
  title?: string;
  /** Subtitle shown below the title (e.g. city or station tagline) */
  subtitle?: string;
  /** Artwork image URL shown on the Cast device screen */
  artworkUrl?: string;
}

export interface ScheduleEntry {
  /** Cron expression for when to start (e.g. "0 7 * * 1-5" = 7 am Mon–Fri) */
  cron: string;
  /** Key from the `stations` map below */
  station: string;
  /** Friendly name shown in the Google Home app (e.g. "Living Room display") */
  deviceName: string;
  /** Volume 0–100 (optional, defaults to 50) */
  volume?: number;
  /** IP address of the device — skips mDNS discovery if set (e.g. "192.168.1.42") */
  deviceIp?: string;
}

// -----------------------------------------------------------------------------
// STATIONS
// Add or remove entries here. The key is a friendly label you choose yourself.
// url must be a direct audio stream URL (mp3, aac, or m3u8).
// title, subtitle, artworkUrl are shown on the Cast device screen (all optional).
// -----------------------------------------------------------------------------
export const stations: Record<string, StationConfig> = {
  "Golden Temple": {
    url: "https://stream.atthebunga.com/golden-temple",
    title: "Golden Temple Radio",
    subtitle: "Amritsar",
    artworkUrl: "https://upload.wikimedia.org/wikipedia/commons/thumb/e/e5/Amritsar_golden_temple_night_view.JPG/1280px-Amritsar_golden_temple_night_view.JPG",
  },

  // Useful sanity-check station — plain HTTP, no SSL, reliably always up.
  "SomaFM Groove Salad": {
    url: "http://ice1.somafm.com/groovesalad-128-mp3",
  },

  // TODO: streamguys1.com has a TLS cert mismatch — find working URLs from
  // opb.org and kexp.org before adding these back to the schedule.
  // "OPB News": { url: "https://opb-news.streamguys1.com/opb-news-mp3" },
  // "KEXP":     { url: "https://kexp-mp3-128.streamguys1.com/kexp128.mp3" },
};

// -----------------------------------------------------------------------------
// SCHEDULE
// Each entry = one alarm. Add as many as you like.
// -----------------------------------------------------------------------------
export const schedule: ScheduleEntry[] = [
  // TODO: add OPB News and KEXP back once working stream URLs are found.
  {
    cron: "0 6 * * *",          // 6:00 am, every day
    station: "Golden Temple",
    deviceName: "Kitchen Display",
    deviceIp: "192.168.0.5",
    volume: 30,
  },
];
