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
// The value must be a direct audio stream URL (mp3 or aac).
// -----------------------------------------------------------------------------
export const stations: Record<string, string> = {
  "OPB News":      "https://opb-news.streamguys1.com/opb-news-mp3",
  "KEXP":          "https://kexp-mp3-128.streamguys1.com/kexp128.mp3",
  "Golden Temple": "https://live.sgpc.net:8443/",
  // More examples (uncomment to use):
  // "WNYC FM":  "https://fm939.wnyc.org/wnycfm.aac",
  // "NPR":      "https://npr-ice.streamguys1.com/live.mp3",
  // "BBC R4":   "https://stream.live.vc.bbcmedia.co.uk/bbc_radio_fourfm",
};

// -----------------------------------------------------------------------------
// SCHEDULE
// Each entry = one alarm. Add as many as you like.
// -----------------------------------------------------------------------------
export const schedule: ScheduleEntry[] = [
  {
    cron: "0 7 * * 1-5",        // 7:00 am, Monday–Friday
    station: "OPB News",
    deviceName: "Kitchen Display",
    deviceIp: "192.168.0.5",
    volume: 60,
  },
  {
    cron: "0 9 * * 6,0",        // 9:00 am, Saturday & Sunday
    station: "KEXP",
    deviceName: "Kitchen Display",
    deviceIp: "192.168.0.5",
    volume: 50,
  },
];
