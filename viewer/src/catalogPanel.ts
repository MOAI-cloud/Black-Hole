import {
  distance, duration, eddingtonLuminosity, gravitationalRadius, horizonRadius, iscoRadius, orbitalPeriod,
  scientific, tidalAcceleration, timeUnit
} from './astro';
import { BLACK_HOLES, type BlackHoleEntry } from './blackHoles';
import { byId } from './controls';

const microArcsecond = Math.PI / 180 / 3600 / 1e6;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function factList(rows: [string, string][]): HTMLDListElement {
  const list = element('dl', 'fact-list');
  for (const [label, value] of rows) {
    const row = element('div');
    row.append(element('dt', undefined, label), element('dd', undefined, value));
    list.append(row);
  }
  return list;
}

/** Scales that follow from the mass and spin alone. */
export function physicalScales(entry: BlackHoleEntry): [string, string][] {
  const m = entry.massSolar, rg = gravitationalRadius(m), t = timeUnit(m);
  const isco = iscoRadius(entry.spin), horizon = horizonRadius(entry.spin);
  const tidal = tidalAcceleration(m, horizon, 2);
  const rows: [string, string][] = [
    ['Gravitational radius GM/c²', distance(rg)],
    ['Event horizon radius', `${horizon.toFixed(3)} M · ${distance(horizon * rg)}`],
    ['Time unit GM/c³', duration(t)],
    ['ISCO radius', `${isco.toFixed(3)} M · ${distance(isco * rg)}`],
    ['ISCO orbital period', duration(orbitalPeriod(isco, entry.spin) * t)],
    ['Eddington luminosity', `${scientific(eddingtonLuminosity(m), 3)} W`],
    ['Tidal stretch at horizon (2 m)', `${scientific(tidal, 2)} m/s² · ${scientific(tidal / 9.80665, 2)} g`]
  ];
  if (entry.distanceMeters) {
    // Shadow of a Schwarzschild hole seen from far away: diameter 2√27 GM/c².
    const shadow = 2 * Math.sqrt(27) * rg / entry.distanceMeters / microArcsecond;
    rows.push(['Shadow diameter from Earth', shadow >= 0.1 ? `${shadow.toFixed(1)} μas` : `${scientific(shadow, 2)} μas`]);
  }
  return rows;
}

export function buildCatalogStrip(onSelect: (id: string) => void): (active: string) => void {
  const strip = byId('catalogStrip');
  const cards = BLACK_HOLES.map(entry => {
    const card = element('button', 'object-card');
    card.type = 'button';
    card.setAttribute('role', 'listitem');
    card.style.setProperty('--accent', entry.accent);
    const glyph = element('i', 'object-glyph');
    glyph.setAttribute('aria-hidden', 'true');
    const text = element('span', 'object-text');
    text.append(element('strong', undefined, entry.name), element('small', undefined, entry.kind),
      element('em', undefined, scientific(entry.massSolar, 2) + ' M☉'));
    card.append(glyph, text);
    card.title = `${entry.name} · ${entry.massText}`;
    card.addEventListener('click', () => onSelect(entry.id));
    strip.append(card);
    return { id: entry.id, card };
  });
  return active => {
    for (const { id, card } of cards) card.setAttribute('aria-pressed', String(id === active));
  };
}

export function renderObjectPanel(entry: BlackHoleEntry, activeView: number, onView: (index: number) => void): void {
  const panel = byId('objectPanel');
  panel.replaceChildren();
  const intro = element('section', 'panel-section object-intro');
  intro.style.setProperty('--accent', entry.accent);
  intro.append(element('p', 'object-kind', entry.kind), element('h3', 'object-name', entry.name),
    element('p', undefined, entry.summary));
  const striking = element('section', 'panel-section');
  striking.append(element('h3', undefined, 'What makes it striking'), element('p', undefined, entry.striking));
  const views = element('section', 'panel-section');
  views.append(element('h3', undefined, 'Views'));
  const list = element('div', 'view-list');
  entry.views.forEach((view, index) => {
    const button = element('button', 'view-button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(index === activeView));
    button.append(element('strong', undefined, view.name), element('span', undefined, view.note));
    button.addEventListener('click', () => onView(index));
    list.append(button);
  });
  views.append(list);
  const facts = element('section', 'panel-section');
  facts.append(element('h3', undefined, 'Measured'), factList([
    ['Mass', entry.massText], ['Spin a/M', entry.spinText], ['Distance', entry.distanceText],
    ['Accretion', entry.accretionText], ...entry.facts
  ]));
  const scales = element('section', 'panel-section');
  scales.append(element('h3', undefined, 'Physical scales'), factList(physicalScales(entry)));
  const sources = element('section', 'panel-section references');
  sources.append(element('h3', undefined, 'Sources'));
  for (const reference of entry.references) {
    const link = element('a', undefined, reference.label);
    link.href = reference.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    sources.append(link);
  }
  panel.append(intro, views, striking, facts, scales, sources);
}
