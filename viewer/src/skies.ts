import { DataTexture, RGBAFormat, SRGBColorSpace, TextureLoader, type Texture } from 'three';

export type SkyId = 'milky-way' | 'star-field' | 'infrared' | 'gamma-ray' | 'dark';

interface Sky {
  id: SkyId;
  label: string;
  credit: string;
  source?: string;
  thumbnail: string;
}

export const SKIES: readonly Sky[] = [
  { id: 'milky-way', label: 'Milky Way', credit: 'Visible light · ESO / Serge Brunier / Frédéric Tapissier',
    source: 'https://www.eso.org/public/news/eso0932/', thumbnail: '/skies/milky-way-preview.webp' },
  { id: 'star-field', label: 'Deep star field', credit: 'Bundled star-field panorama', thumbnail: '/skies/star-field-preview.webp' },
  { id: 'infrared', label: 'WISE infrared', credit: 'False-color infrared · NASA / JPL-Caltech / UCLA',
    source: 'https://science.nasa.gov/photojournal/mapping-the-infrared-universe-the-entire-wise-sky-rectangular-format/',
    thumbnail: '/skies/infrared-preview.webp' },
  { id: 'gamma-ray', label: 'Fermi gamma rays', credit: 'False-color gamma rays · NASA / DOE / Fermi LAT Collaboration',
    source: 'https://svs.gsfc.nasa.gov/11342/', thumbnail: '/skies/gamma-ray-preview.webp' },
  { id: 'dark', label: 'Dark sky', credit: 'Isolated disk emission', thumbnail: '/skies/dark-preview.webp' }
];

const textures: Record<Exclude<SkyId, 'dark'>, string> = {
  'milky-way': new URL('./assets/milky-way.webp', import.meta.url).href,
  'star-field': new URL('./assets/skies/star-field.webp', import.meta.url).href,
  infrared: new URL('./assets/skies/infrared.webp', import.meta.url).href,
  'gamma-ray': new URL('./assets/skies/gamma-ray.webp', import.meta.url).href
};

export async function loadSkyTexture(id: SkyId): Promise<Texture> {
  const texture = id === 'dark'
    ? new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat)
    : await new TextureLoader().loadAsync(textures[id]);
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}
