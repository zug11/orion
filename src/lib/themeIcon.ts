import type { ThemePalette } from "./theme";

type RGB = readonly [number, number, number];
export interface IconPalette {
  shadow: RGB;
  body: RGB;
  highlight: RGB;
  background: string;
}

const rgb = (hex: string): RGB => [1, 3, 5].map((offset) =>
  Number.parseInt(hex.slice(offset, offset + 2), 16)) as unknown as RGB;
const mix = (a: RGB, b: RGB, amount: number): RGB =>
  a.map((value, index) => Math.round(value + (b[index] - value) * amount)) as unknown as RGB;

export function resolveIconPalette(palette: ThemePalette): IconPalette {
  const light = palette.mode === "light";
  // The theme accent is already mode-clamped. Give the body a deeper finish
  // at night and a lighter one in daylight, without losing its coloured edges.
  const body = mix(rgb(palette.accent), rgb(light ? "#ffffff" : "#000000"), light ? 0.22 : 0.26);
  return {
    body,
    shadow: mix(body, rgb("#111624"), light ? 0.48 : 0.62),
    highlight: mix(body, rgb("#e8f0f2"), light ? 0.38 : 0.55),
    background: palette.surface1,
  };
}

/** Map the approved artwork's lighting, never its alpha or silhouette. */
export function recolorIconPixels(source: Uint8ClampedArray, palette: IconPalette): Uint8ClampedArray {
  const output = new Uint8ClampedArray(source.length);
  const lookup = Array.from({ length: 256 }, (_, luminance) => {
    const tone = Math.max(0, Math.min(1, (luminance / 255 - 0.1) / 0.8));
    const lower = tone < 0.52;
    const amount = lower ? tone / 0.52 : (tone - 0.52) / 0.48;
    const eased = amount * amount * (3 - 2 * amount);
    return mix(lower ? palette.shadow : palette.body, lower ? palette.body : palette.highlight, eased);
  });
  for (let index = 0; index < source.length; index += 4) {
    const luminance = Math.round(source[index] * 0.2126 + source[index + 1] * 0.7152 + source[index + 2] * 0.0722);
    const color = lookup[luminance];
    output[index] = color[0];
    output[index + 1] = color[1];
    output[index + 2] = color[2];
    output[index + 3] = source[index + 3];
  }
  return output;
}

export interface ThemeIconImages { mark: string; dock: string }
let sourcePixels: Promise<ImageData> | undefined;
const cache = new Map<string, Promise<ThemeIconImages>>();

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const result = canvas.getContext("2d");
  if (!result) throw new Error("Icon drawing is unavailable.");
  return result;
}

function loadSource(): Promise<ImageData> {
  if (!sourcePixels) {
    sourcePixels = new Promise<ImageData>((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          canvas.width = canvas.height = 512;
          const drawing = context(canvas);
          drawing.drawImage(image, 0, 0, 512, 512);
          resolve(drawing.getImageData(0, 0, 512, 512));
        } catch (error) { reject(error); }
      };
      image.onerror = () => reject(new Error("Orion's icon could not be loaded."));
      image.src = "/orion-symbol-source.png";
    }).catch((error) => { sourcePixels = undefined; throw error; });
  }
  return sourcePixels;
}

export function renderThemeIcon(palette: IconPalette): Promise<ThemeIconImages> {
  const key = JSON.stringify(palette);
  const cached = cache.get(key);
  if (cached) return cached;
  const result = loadSource().then((source) => {
    const mark = document.createElement("canvas");
    mark.width = mark.height = 512;
    const drawing = context(mark);
    drawing.putImageData(new ImageData(recolorIconPixels(source.data, palette), 512, 512), 0, 0);
    const dock = document.createElement("canvas");
    dock.width = dock.height = 512;
    const tile = context(dock);
    // A native-sized tile, with transparent padding. The in-app mark above
    // remains completely freestanding, including the hole through its centre.
    tile.fillStyle = palette.background;
    tile.beginPath();
    tile.roundRect(28, 28, 456, 456, 102);
    tile.fill();
    tile.drawImage(mark, 46, 40, 420, 420);
    return { mark: mark.toDataURL("image/png"), dock: dock.toDataURL("image/png").split(",")[1] };
  }).catch((error) => { cache.delete(key); throw error; });
  cache.set(key, result);
  // Colour-picker drags must not retain an unbounded collection of PNGs.
  while (cache.size > 4) cache.delete(cache.keys().next().value!);
  return result;
}
