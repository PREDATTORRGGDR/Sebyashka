import sharp from "sharp";

/** Требования Telegram к статичному стикеру: PNG/WEBP, одна сторона ровно 512, вторая ≤ 512, ≤ 512 КБ. */
export const STICKER_SIZE = 512;
export const STICKER_MAX_BYTES = 512 * 1024;
const PAD = 14;

interface Raw {
  data: Buffer;
  width: number;
  height: number;
}

async function toRaw(input: Buffer, maxSide = 1024): Promise<Raw> {
  const { data, info } = await sharp(input, { failOn: "error" })
    .rotate()
    .resize({ width: maxSide, height: maxSide, fit: "inside", withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function fromRaw(r: Raw) {
  return sharp(r.data, { raw: { width: r.width, height: r.height, channels: 4 } });
}

/** Доля полностью непрозрачных пикселей. Если фон уже прозрачный — вырезать его не нужно. */
export function opaqueRatio(r: Raw): number {
  let opaque = 0;
  const total = r.width * r.height;
  for (let i = 3; i < r.data.length; i += 4) if (r.data[i]! > 250) opaque++;
  return opaque / total;
}

/**
 * Удаление однотонного фона заливкой от краёв (бесплатно, без нейросети).
 * Промпт просит «plain white background», поэтому в 95% случаев этого достаточно.
 */
export function removeFlatBackground(r: Raw, tolerance = 42): Raw {
  const { width: w, height: h } = r;
  const data = Buffer.from(r.data);
  // Цвет фона — медиана пикселей рамки.
  const border: number[][] = [];
  for (let x = 0; x < w; x++) border.push(px(data, w, x, 0), px(data, w, x, h - 1));
  for (let y = 0; y < h; y++) border.push(px(data, w, 0, y), px(data, w, w - 1, y));
  const bg = [0, 1, 2].map((c) => median(border.map((p) => p[c]!)));
  const tol2 = tolerance * tolerance;
  const isBg = (i: number) => {
    const dr = data[i]! - bg[0]!;
    const dg = data[i + 1]! - bg[1]!;
    const db = data[i + 2]! - bg[2]!;
    return dr * dr + dg * dg + db * db <= tol2;
  };

  const visited = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const p = y * w + x;
    if (visited[p]) return;
    visited[p] = 1;
    if (isBg(p * 4)) stack.push(p);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const p = stack.pop()!;
    data[p * 4 + 3] = 0;
    const x = p % w;
    const y = (p - x) / w;
    if (x > 0) push(x - 1, y);
    if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < h - 1) push(x, y + 1);
  }
  return { data, width: w, height: h };
}

function px(d: Buffer, w: number, x: number, y: number): number[] {
  const i = (y * w + x) * 4;
  return [d[i]!, d[i + 1]!, d[i + 2]!];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 255;
}

/** Рамка непрозрачного содержимого. null — картинка пустая. */
export function alphaBBox(r: Raw, threshold = 16): { left: number; top: number; width: number; height: number } | null {
  let minX = r.width,
    minY = r.height,
    maxX = -1,
    maxY = -1;
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      if (r.data[(y * r.width + x) * 4 + 3]! > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export interface PostprocessOptions {
  /** Вырезать однотонный фон локально. false — если фон уже удалён нейросетью. */
  removeBackground: boolean;
}

/**
 * Превращает картинку от генератора в готовый стикер Telegram:
 * вырезка фона → обрезка по содержимому → белая обводка → 512 px → PNG (или WEBP, если PNG > 512 КБ).
 */
export async function toSticker(input: Buffer, opts: PostprocessOptions): Promise<{ buffer: Buffer; format: "png" | "webp" }> {
  let raw = await toRaw(input);
  const alreadyTransparent = opaqueRatio(raw) < 0.9;
  if (opts.removeBackground && !alreadyTransparent) {
    const cut = removeFlatBackground(raw);
    const box = alphaBBox(cut);
    const area = box ? (box.width * box.height) / (raw.width * raw.height) : 0;
    // Если заливка «съела» персонажа (фон не однотонный) — оставляем как есть, но скругляем углы.
    raw = box && area > 0.05 && opaqueRatio(cut) > 0.03 ? cut : await roundCorners(raw);
  }

  const box = alphaBBox(raw);
  if (!box) throw new Error("пустое изображение после обработки");
  const inner = STICKER_SIZE - PAD * 2;
  const content = await fromRaw(raw)
    .extract(box)
    .resize({ width: inner, height: inner, fit: "inside" })
    .png()
    .toBuffer({ resolveWithObject: true });

  const W = content.info.width + PAD * 2;
  const H = content.info.height + PAD * 2;
  const padded = await sharp(content.data)
    .extend({ top: PAD, bottom: PAD, left: PAD, right: PAD, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Обводка: размываем альфу и режем порогом — получаем «раздутый» силуэт.
  const outlineAlpha = await sharp(padded).extractChannel("alpha").blur(5).threshold(6).raw().toBuffer();
  const outline = await sharp({ create: { width: W, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(outlineAlpha, { raw: { width: W, height: H, channels: 1 } })
    .png()
    .toBuffer();

  const composed = sharp(outline).composite([{ input: padded }]);
  const png = await composed.clone().png({ compressionLevel: 9, palette: false }).toBuffer();
  if (png.length <= STICKER_MAX_BYTES) return { buffer: png, format: "png" };
  for (const quality of [92, 85, 75, 60]) {
    const webp = await composed.clone().webp({ quality, alphaQuality: 90 }).toBuffer();
    if (webp.length <= STICKER_MAX_BYTES) return { buffer: webp, format: "webp" };
  }
  throw new Error("стикер больше 512 КБ даже после сжатия");
}

async function roundCorners(r: Raw): Promise<Raw> {
  const radius = Math.round(Math.min(r.width, r.height) * 0.12);
  const mask = Buffer.from(
    `<svg width="${r.width}" height="${r.height}"><rect x="0" y="0" width="${r.width}" height="${r.height}" rx="${radius}" ry="${radius}"/></svg>`,
  );
  const { data, info } = await fromRaw(r)
    .composite([{ input: mask, blend: "dest-in" }])
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/** Нормализация загруженного фото (человек, питомец, персонаж): EXIF-поворот, ≤1024 px, JPEG без метаданных (GPS и т.п. удаляются). */
export async function normalizeSelfie(input: Buffer): Promise<Buffer> {
  const img = sharp(input, { failOn: "error", limitInputPixels: 50_000_000 });
  const meta = await img.metadata();
  if (!meta.width || !meta.height) throw new Error("не удалось прочитать изображение");
  if (Math.min(meta.width, meta.height) < 256) throw new Error("слишком маленькое фото (нужно от 256 px)");
  return img
    .rotate()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer();
}
