import sharp from "sharp";
import type { Config } from "../config.js";

export interface GenerateInput {
  selfie: Buffer;
  prompt: string;
  negativePrompt: string;
  seed: number;
  /** Для mock-генератора: подпись на стикере. */
  emoji: string;
  label: string;
  /** Уровень пака - провайдер может выбирать качество/модель под экономику. */
  tier?: "free" | "paid" | "premium";
}

export interface ImageGenerator {
  readonly name: string;
  /** Возвращает сгенерированную картинку (PNG/JPEG/WEBP). */
  generate(input: GenerateInput, signal?: AbortSignal): Promise<Buffer>;
  /** Удаление фона нейросетью (опционально). */
  removeBackground?(image: Buffer, signal?: AbortSignal): Promise<Buffer>;
}

/** Ошибка настройки провайдера (неверный ключ, модель, нет денег на счету) - ретраи бесполезны. */
export class ProviderConfigError extends Error {
  override name = "ProviderConfigError";
}

/** Временная ошибка (таймаут, 5xx, 429) - стоит повторить. */
export class ProviderTransientError extends Error {
  override name = "ProviderTransientError";
}

export function toDataUri(buf: Buffer, mime = "image/jpeg"): string {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

/**
 * Подстановка в JSON-шаблон входа модели. Плейсхолдеры: {{prompt}}, {{negative_prompt}}, {{image_url}}, {{seed}}.
 * Если строка целиком равна плейсхолдеру {{seed}} - подставляется число.
 */
export function renderTemplate(template: string, vars: Record<string, string | number>): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(template);
  } catch (e) {
    throw new ProviderConfigError(`шаблон входа модели - невалидный JSON: ${(e as Error).message}`);
  }
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const whole = /^\{\{(\w+)\}\}$/.exec(v);
      if (whole && whole[1]! in vars) return vars[whole[1]!];
      return v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(parsed);
}

/** Ищет первый URL картинки в ответе модели любого формата. */
export function findImageUrl(output: unknown): string | null {
  if (typeof output === "string") return /^(https?:|data:image)/.test(output) ? output : null;
  if (Array.isArray(output)) {
    for (const x of output) {
      const u = findImageUrl(x);
      if (u) return u;
    }
    return null;
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    for (const key of ["images", "image", "output", "url", "data"]) {
      if (key in o) {
        const u = findImageUrl(o[key]);
        if (u) return u;
      }
    }
  }
  return null;
}

async function http(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
  const ctrl = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: ctrl });
  } catch (e) {
    throw new ProviderTransientError(`сеть: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403 || res.status === 402 || res.status === 404 || res.status === 422) {
    const body = await res.text().catch(() => "");
    throw new ProviderConfigError(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new ProviderTransientError(`HTTP ${res.status}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderTransientError(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function download(url: string, timeoutMs: number, signal?: AbortSignal): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const b64 = url.slice(url.indexOf(",") + 1);
    return Buffer.from(b64, "base64");
  }
  const res = await http(url, {}, timeoutMs, signal);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new ProviderTransientError("ответ модели слишком большой");
  return buf;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

/* ------------------------------------------------------------------ */
/* fal.ai - queue API                                                  */
/* ------------------------------------------------------------------ */

const FAL_DEFAULT_TEMPLATE = JSON.stringify({
  prompt: "{{prompt}}",
  reference_image_url: "{{image_url}}",
  negative_prompt: "{{negative_prompt}}",
  seed: "{{seed}}",
  image_size: "square",
  num_inference_steps: 20,
  guidance_scale: 4,
  id_weight: 1,
  true_cfg: 1,
});

export class FalGenerator implements ImageGenerator {
  readonly name = "fal";
  constructor(
    private readonly key: string,
    private readonly model: string,
    private readonly template: string,
    private readonly bgModel: string,
    private readonly timeoutMs: number,
  ) {}

  private async run(model: string, input: unknown, signal?: AbortSignal): Promise<unknown> {
    const headers = { Authorization: `Key ${this.key}`, "Content-Type": "application/json" };
    const submit = await http(`https://queue.fal.run/${model}`, { method: "POST", headers, body: JSON.stringify(input) }, 30_000, signal);
    const job = (await submit.json()) as { request_id?: string; status_url?: string; response_url?: string };
    if (!job.status_url || !job.response_url) throw new ProviderTransientError("fal: нет status_url в ответе");
    const deadline = Date.now() + this.timeoutMs;
    let delay = 1000;
    while (Date.now() < deadline) {
      await sleep(delay, signal);
      delay = Math.min(delay * 1.5, 5000);
      const st = (await (await http(job.status_url, { headers }, 15_000, signal)).json()) as { status?: string };
      if (st.status === "COMPLETED") {
        const out = await http(job.response_url, { headers }, 30_000, signal);
        return out.json();
      }
      if (st.status && !["IN_QUEUE", "IN_PROGRESS"].includes(st.status)) {
        throw new ProviderTransientError(`fal: статус ${st.status}`);
      }
    }
    throw new ProviderTransientError("fal: таймаут генерации");
  }

  async generate(input: GenerateInput, signal?: AbortSignal): Promise<Buffer> {
    const body = renderTemplate(this.template || FAL_DEFAULT_TEMPLATE, {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      image_url: toDataUri(input.selfie),
      seed: input.seed,
    });
    const out = await this.run(this.model, body, signal);
    const url = findImageUrl(out);
    if (!url) throw new ProviderTransientError("fal: в ответе нет картинки (возможно, сработал NSFW-фильтр)");
    return download(url, 60_000, signal);
  }

  async removeBackground(image: Buffer, signal?: AbortSignal): Promise<Buffer> {
    const out = await this.run(this.bgModel, { image_url: toDataUri(image, "image/png") }, signal);
    const url = findImageUrl(out);
    if (!url) throw new ProviderTransientError("fal bg: в ответе нет картинки");
    return download(url, 60_000, signal);
  }
}

/* ------------------------------------------------------------------ */
/* Replicate - predictions API                                         */
/* ------------------------------------------------------------------ */

const REPLICATE_DEFAULT_TEMPLATE = JSON.stringify({
  prompt: "{{prompt}}",
  negative_prompt: "{{negative_prompt}}",
  image: "{{image_url}}",
  seed: "{{seed}}",
});

export class ReplicateGenerator implements ImageGenerator {
  readonly name = "replicate";
  constructor(
    private readonly token: string,
    private readonly model: string,
    private readonly template: string,
    private readonly timeoutMs: number,
  ) {}

  async generate(input: GenerateInput, signal?: AbortSignal): Promise<Buffer> {
    const headers = { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json", Prefer: "wait=30" };
    const body = renderTemplate(this.template || REPLICATE_DEFAULT_TEMPLATE, {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      image_url: toDataUri(input.selfie),
      seed: input.seed,
    });
    const [ownerName, version] = this.model.split(":");
    const url = version
      ? "https://api.replicate.com/v1/predictions"
      : `https://api.replicate.com/v1/models/${ownerName}/predictions`;
    const payload = version ? { version, input: body } : { input: body };
    let pred = (await (await http(url, { method: "POST", headers, body: JSON.stringify(payload) }, 60_000, signal)).json()) as {
      status?: string;
      output?: unknown;
      error?: string;
      urls?: { get?: string };
    };
    const deadline = Date.now() + this.timeoutMs;
    let delay = 1000;
    while (pred.status !== "succeeded") {
      if (pred.status === "failed" || pred.status === "canceled") {
        throw new ProviderTransientError(`replicate: ${pred.status} ${pred.error ?? ""}`);
      }
      if (!pred.urls?.get) throw new ProviderTransientError("replicate: нет urls.get");
      if (Date.now() > deadline) throw new ProviderTransientError("replicate: таймаут генерации");
      await sleep(delay, signal);
      delay = Math.min(delay * 1.5, 5000);
      pred = (await (await http(pred.urls.get, { headers: { Authorization: headers.Authorization } }, 15_000, signal)).json()) as typeof pred;
    }
    const out = findImageUrl(pred.output);
    if (!out) throw new ProviderTransientError("replicate: в ответе нет картинки");
    return download(out, 60_000, signal);
  }
}

/* ------------------------------------------------------------------ */
/* Mock - без ИИ, для разработки, тестов и демо                        */
/* ------------------------------------------------------------------ */

const PALETTE = ["#FFD166", "#06D6A0", "#118AB2", "#EF476F", "#8338EC", "#FF9F1C", "#2EC4B6", "#E71D36"];

export class MockGenerator implements ImageGenerator {
  readonly name = "mock";
  constructor(private readonly delayMs = 0) {}

  async generate(input: GenerateInput, signal?: AbortSignal): Promise<Buffer> {
    if (this.delayMs) await sleep(this.delayMs, signal);
    const size = 768;
    const face = 520;
    const color = PALETTE[Math.abs(input.seed) % PALETTE.length]!;
    const circle = Buffer.from(`<svg width="${face}" height="${face}"><circle cx="${face / 2}" cy="${face / 2}" r="${face / 2}"/></svg>`);
    const faceImg = await sharp(input.selfie)
      .resize(face, face, { fit: "cover", position: "attention" })
      .modulate({ saturation: 1.3 })
      .composite([{ input: circle, blend: "dest-in" }])
      .png()
      .toBuffer();
    const overlay = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size / 2}" cy="${size / 2}" r="${face / 2 + 16}" fill="${color}"/>
      </svg>`,
    );
    return sharp({ create: { width: size, height: size, channels: 3, background: "#ffffff" } })
      .composite([
        { input: overlay, top: 0, left: 0 },
        { input: faceImg, top: (size - face) / 2, left: (size - face) / 2 },
      ])
      .png()
      .toBuffer();
  }
}

export function createGenerator(c: Config): ImageGenerator {
  const timeout = c.GEN_TIMEOUT_SEC * 1000;
  switch (c.GEN_PROVIDER) {
    case "fal":
      return new FalGenerator(c.FAL_KEY!, c.FAL_MODEL, c.FAL_INPUT_TEMPLATE ?? "", c.FAL_BG_MODEL, timeout);
    case "replicate":
      return new ReplicateGenerator(c.REPLICATE_TOKEN!, c.REPLICATE_MODEL!, c.REPLICATE_INPUT_TEMPLATE ?? "", timeout);
    case "mock":
      return new MockGenerator(c.NODE_ENV === "test" ? 0 : 400);
  }
}

/** Отдельный генератор для удаления фона (только fal). */
export function createBgRemover(c: Config): ImageGenerator | null {
  if (c.BG_REMOVAL !== "fal") return null;
  return new FalGenerator(c.FAL_KEY!, c.FAL_MODEL, "", c.FAL_BG_MODEL, c.GEN_TIMEOUT_SEC * 1000);
}
