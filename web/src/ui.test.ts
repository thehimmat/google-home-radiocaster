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

  it('updates live indicators from a health map', () => {
    const { ui } = makeUI();
    ui.renderStations(STATIONS);

    ui.setLive(new Map([['golden-temple', true], ['bare', false]]));

    const rows = document.querySelectorAll('.station-live');
    expect(rows[0].classList.contains('is-live')).toBe(true);
    expect(rows[0].querySelector('.live-label')?.textContent).toBe('live');
    expect(rows[1].classList.contains('is-live')).toBe(false);
    expect(rows[1].querySelector('.live-label')?.textContent).toBe('offline');
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

  it('keeps the Cast button hidden until the framework is available', () => {
    const { ui } = makeUI();
    const wrap = document.querySelector('.cast-wrap') as HTMLElement;

    expect(wrap.hidden).toBe(true);
    ui.showCastButton();
    expect(wrap.hidden).toBe(false);
    expect(wrap.querySelector('google-cast-launcher')).not.toBeNull();
  });

  it('forwards volume changes as a 0-1 level', () => {
    const { callbacks } = makeUI();
    const slider = document.querySelector('.volume') as HTMLInputElement;

    slider.value = '40';
    slider.dispatchEvent(new Event('input'));
    expect(callbacks.onVolume).toHaveBeenCalledWith(0.4);
  });
});
