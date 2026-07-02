// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Station } from './types';
import { UI, UICallbacks } from './ui';

const STATIONS: Station[] = [
  {
    slug: 'golden-temple',
    title: 'Golden Temple Radio',
    subtitle: 'Amritsar',
    artworkUrl: 'https://example.com/art.jpg',
    hlsUrl: 'https://s/golden-temple',
    streamUrl: 'https://s/golden-temple/stream',
  },
  {
    slug: 'bare',
    title: 'bare',
    subtitle: null,
    artworkUrl: null,
    hlsUrl: 'https://s/bare',
    streamUrl: 'https://s/bare/stream',
  },
];

function makeUI() {
  document.body.innerHTML = '<div id="app"></div>';
  const callbacks: UICallbacks = {
    onSelectStation: vi.fn(),
    onTogglePlay: vi.fn(),
    onVolume: vi.fn(),
    onCast: vi.fn(),
  };
  const ui = new UI(document.getElementById('app') as HTMLElement, callbacks);
  return { ui, callbacks };
}

describe('UI', () => {
  beforeEach(() => {
    document.body.className = '';
  });

  it('renders a card per station with title, subtitle, and artwork', () => {
    const { ui } = makeUI();
    ui.renderStations(STATIONS);

    const cards = document.querySelectorAll('.station-card');
    expect(cards).toHaveLength(2);
    expect(cards[0].querySelector('.station-title')?.textContent).toBe('Golden Temple Radio');
    expect(cards[0].querySelector('.station-subtitle')?.textContent).toBe('Amritsar');
    expect(cards[0].querySelector('img.station-art')).not.toBeNull();
    // No artwork → Lucide SVG placeholder, never an emoji or broken img.
    expect(cards[1].querySelector('img.station-art')).toBeNull();
    expect(cards[1].querySelector('.station-art-placeholder svg')).not.toBeNull();
  });

  it('reports station selection through the callback', () => {
    const { ui, callbacks } = makeUI();
    ui.renderStations(STATIONS);

    (document.querySelectorAll('.station-card')[1] as HTMLElement).click();
    expect(callbacks.onSelectStation).toHaveBeenCalledWith('bare');
  });

  it('marks exactly one card as selected', () => {
    const { ui } = makeUI();
    ui.renderStations(STATIONS);

    ui.setSelected('golden-temple');
    expect(document.querySelectorAll('.station-card.selected')).toHaveLength(1);
    ui.setSelected('bare');
    const selected = document.querySelector('.station-card.selected');
    expect(selected?.getAttribute('data-slug')).toBe('bare');
  });

  it('updates live indicators from a status map', () => {
    const { ui } = makeUI();
    ui.renderStations(STATIONS);

    ui.setLive(new Map([['golden-temple', 'live'], ['bare', 'error']]));

    const rows = document.querySelectorAll('.station-live');
    expect(rows[0].classList.contains('is-live')).toBe(true);
    expect(rows[0].querySelector('.live-label')?.textContent).toBe('live');
    expect(rows[1].classList.contains('is-live')).toBe(false);
    expect(rows[1].querySelector('.live-label')?.textContent).toBe('offline');
  });

  it('shows a "not us" note when a station source is down, and clears it on recovery', () => {
    const { ui } = makeUI();
    ui.renderStations(STATIONS);

    ui.setLive(new Map([['golden-temple', 'source-down'], ['bare', 'live']]));

    const cards = document.querySelectorAll('.station-card');
    const gtRow = cards[0].querySelector('.station-live') as HTMLElement;
    const gtNote = cards[0].querySelector('.station-note') as HTMLElement;
    expect(gtRow.classList.contains('is-source-down')).toBe(true);
    expect(gtRow.querySelector('.live-label')?.textContent).toBe('source offline');
    expect(gtNote.hidden).toBe(false);
    // Message names the station and makes clear the outage is upstream.
    expect(gtNote.textContent).toContain('Golden Temple Radio');
    expect(gtNote.textContent?.toLowerCase()).toContain('not us');

    // The healthy station shows no note.
    expect((cards[1].querySelector('.station-note') as HTMLElement).hidden).toBe(true);

    // Source recovers → note is hidden and the dot goes live again.
    ui.setLive(new Map([['golden-temple', 'live']]));
    expect(gtNote.hidden).toBe(true);
    expect(gtRow.classList.contains('is-source-down')).toBe(false);
    expect(gtRow.classList.contains('is-live')).toBe(true);
  });

  it('swaps the play control between play and pause states', () => {
    const { ui, callbacks } = makeUI();
    const button = document.querySelector('.play-button') as HTMLButtonElement;

    expect(button.getAttribute('aria-label')).toBe('Play');
    expect(button.querySelector('svg')).not.toBeNull();

    ui.setPlaying(true);
    expect(button.getAttribute('aria-label')).toBe('Pause');

    button.click();
    expect(callbacks.onTogglePlay).toHaveBeenCalled();
  });

  it('keeps the Cast button hidden until the framework is available, then shows our own button', () => {
    const { ui, callbacks } = makeUI();
    const wrap = document.querySelector('.cast-wrap') as HTMLElement;
    const button = wrap.querySelector('.cast-button') as HTMLButtonElement;

    // Our own always-visible button, not the auto-hiding <google-cast-launcher>.
    expect(button).not.toBeNull();
    expect(wrap.querySelector('google-cast-launcher')).toBeNull();

    expect(wrap.hidden).toBe(true);
    ui.showCastButton();
    expect(wrap.hidden).toBe(false);

    // Clicking it asks main.ts to open the picker (which triggers discovery).
    button.click();
    expect(callbacks.onCast).toHaveBeenCalled();
  });

  it('marks the Cast button while a session is active', () => {
    const { ui } = makeUI();
    const button = document.querySelector('.cast-button') as HTMLButtonElement;

    ui.setCasting(true);
    expect(button.classList.contains('is-casting')).toBe(true);
    ui.setCasting(false);
    expect(button.classList.contains('is-casting')).toBe(false);
  });

  it('forwards volume changes as a 0-1 level', () => {
    const { callbacks } = makeUI();
    const slider = document.querySelector('.volume') as HTMLInputElement;

    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    expect(callbacks.onVolume).toHaveBeenCalledWith(0.4);
  });
});
