import { createElement, Pause, Play, RadioTower } from 'lucide';
import type { Station } from './types';

export interface UICallbacks {
  onSelectStation: (slug: string) => void;
  onTogglePlay: () => void;
  onVolume: (level: number) => void;
}

/**
 * All DOM construction and updates. No playback logic lives here — main.ts
 * wires callbacks to the local player and cast controller.
 */
export class UI {
  readonly audio: HTMLAudioElement;
  private readonly stationList: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private readonly volumeSlider: HTMLInputElement;
  private readonly castWrap: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly liveDots = new Map<string, HTMLElement>();
  private readonly cards = new Map<string, HTMLElement>();

  constructor(root: HTMLElement, private readonly callbacks: UICallbacks) {
    root.innerHTML = '';

    const header = el('header', 'header');
    const logo = document.createElement('img');
    logo.className = 'logo';
    logo.alt = 'atTheBunga';
    logo.src = 'https://stream.atthebunga.com/logos/atthebunga-logo-1A.png';
    const heading = el('h1', 'title');
    heading.textContent = 'Gurbani Radio';
    header.append(logo, heading);

    this.stationList = el('main', 'stations');

    this.audio = document.createElement('audio');
    this.audio.hidden = true;

    // Controls bar: play/pause, volume, cast.
    const controls = el('footer', 'controls');

    this.playButton = document.createElement('button');
    this.playButton.className = 'play-button';
    this.playButton.setAttribute('aria-label', 'Play');
    this.playButton.addEventListener('click', () => this.callbacks.onTogglePlay());

    this.volumeSlider = document.createElement('input');
    this.volumeSlider.type = 'range';
    this.volumeSlider.min = '0';
    this.volumeSlider.max = '100';
    this.volumeSlider.value = '100';
    this.volumeSlider.className = 'volume';
    this.volumeSlider.setAttribute('aria-label', 'Volume');
    this.volumeSlider.addEventListener('input', () => {
      this.callbacks.onVolume(Number(this.volumeSlider.value) / 100);
    });

    // Hidden until the Cast framework reports availability (Chrome only).
    this.castWrap = el('div', 'cast-wrap');
    this.castWrap.hidden = true;
    this.castWrap.innerHTML = '<google-cast-launcher></google-cast-launcher>';

    this.statusLine = el('div', 'status');

    controls.append(this.playButton, this.volumeSlider, this.castWrap);
    root.append(header, this.stationList, controls, this.statusLine, this.audio);
    this.setPlaying(false);
  }

  renderStations(stations: Station[]): void {
    this.stationList.innerHTML = '';
    this.liveDots.clear();
    this.cards.clear();

    for (const station of stations) {
      const card = el('button', 'station-card');
      card.setAttribute('data-slug', station.slug);

      if (station.artworkUrl) {
        const art = document.createElement('img');
        art.className = 'station-art';
        art.src = station.artworkUrl;
        art.alt = '';
        card.append(art);
      } else {
        const placeholder = el('div', 'station-art station-art-placeholder');
        placeholder.append(createElement(RadioTower));
        card.append(placeholder);
      }

      const meta = el('div', 'station-meta');
      const title = el('div', 'station-title');
      title.textContent = station.title;
      meta.append(title);
      if (station.subtitle) {
        const subtitle = el('div', 'station-subtitle');
        subtitle.textContent = station.subtitle;
        meta.append(subtitle);
      }
      const live = el('span', 'live-dot');
      live.title = 'Stream status';
      const liveRow = el('div', 'station-live');
      const liveLabel = el('span', 'live-label');
      liveLabel.textContent = 'checking';
      liveRow.append(live, liveLabel);
      meta.append(liveRow);

      card.append(meta);
      card.addEventListener('click', () => this.callbacks.onSelectStation(station.slug));

      this.liveDots.set(station.slug, liveRow);
      this.cards.set(station.slug, card);
      this.stationList.append(card);
    }
  }

  setSelected(slug: string | null): void {
    for (const [cardSlug, card] of this.cards) {
      card.classList.toggle('selected', cardSlug === slug);
    }
  }

  setLive(bySlug: Map<string, boolean>): void {
    for (const [slug, row] of this.liveDots) {
      const live = bySlug.get(slug);
      if (live === undefined) continue;
      row.classList.toggle('is-live', live);
      const label = row.querySelector('.live-label');
      if (label) label.textContent = live ? 'live' : 'offline';
    }
  }

  setPlaying(playing: boolean): void {
    this.playButton.innerHTML = '';
    this.playButton.append(createElement(playing ? Pause : Play));
    this.playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }

  showCastButton(): void {
    this.castWrap.hidden = false;
  }

  setCasting(casting: boolean): void {
    document.body.classList.toggle('casting', casting);
    this.setStatus(casting ? 'Casting to your speaker' : '');
  }

  setStatus(text: string): void {
    this.statusLine.textContent = text;
  }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}
