import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { EMOTIONS, PRODUCTS, STYLES, styleCost, buildPrompt } from "../src/domain/catalog.js";
import { stickerSetName, stickerSetTitle } from "../src/domain/packs.js";
import { alphaBBox, normalizeSelfie, removeFlatBackground, STICKER_MAX_BYTES, toSticker } from "../src/generation/postprocess.js";
import { findImageUrl, MockGenerator, renderTemplate, ProviderConfigError } from "../src/generation/providers.js";
import { seedFor } from "../src/generation/pipeline.js";
import { verifyCryptoBotSignature } from "../src/payments/cryptobot.js";
import { PaymentService } from "../src/payments/service.js";
import { UrlSigner } from "../src/storage.js";
import { parseStartParam, signInitData, validateInitData } from "../src/telegram/initData.js";
import { classifyTelegramError } from "../src/telegram/gateway.js";
import { loadConfig } from "../src/config.js";
import { BOT_TOKEN, fakeSelfie, grammyError } from "./helpers.js";
import { createHash, createHmac } from "node:crypto";

describe("initData", () => {
  const user = JSON.stringify({ id: 42, first_name: "Иван", username: "ivan" });
  const now = Math.floor(Date.now() / 1000);

  it("принимает корректную подпись", () => {
    const raw = signInitData({ user, auth_date: String(now), start_param: "ref_abcd1234", query_id: "q1" }, BOT_TOKEN);
    const d = validateInitData(raw, BOT_TOKEN);
    expect(d.user.id).toBe(42);
    expect(d.startParam).toBe("ref_abcd1234");
  });

  it("отвергает подделку", () => {
    const raw = signInitData({ user, auth_date: String(now) }, BOT_TOKEN).replace("42", "43");
    expect(() => validateInitData(raw, BOT_TOKEN)).toThrow(/подпись/);
  });

  it("отвергает чужой токен", () => {
    const raw = signInitData({ user, auth_date: String(now) }, "999:other_token_other_token_other_token");
    expect(() => validateInitData(raw, BOT_TOKEN)).toThrow();
  });

  it("отвергает устаревшие данные", () => {
    const raw = signInitData({ user, auth_date: String(now - 2 * 86400) }, BOT_TOKEN);
    expect(() => validateInitData(raw, BOT_TOKEN)).toThrow(/устарели/);
  });

  it("отвергает мусор", () => {
    expect(() => validateInitData("", BOT_TOKEN)).toThrow();
    expect(() => validateInitData("a=b", BOT_TOKEN)).toThrow();
  });

  it("разбирает start-параметр", () => {
    expect(parseStartParam("ref_abc123")).toEqual({ ref: "abc123" });
    expect(parseStartParam("gift_xyz789ab")).toEqual({ gift: "xyz789ab" });
    expect(parseStartParam("ref_../../etc")).toEqual({});
    expect(parseStartParam(null)).toEqual({});
  });
});

describe("CryptoBot подпись", () => {
  it("проверяет HMAC по сырому телу", () => {
    const token = "12345:AAtesttoken";
    const body = JSON.stringify({ update_id: 1, update_type: "invoice_paid", payload: { invoice_id: 5 } });
    const sig = createHmac("sha256", createHash("sha256").update(token).digest()).update(body).digest("hex");
    expect(verifyCryptoBotSignature(token, body, sig)).toBe(true);
    expect(verifyCryptoBotSignature(token, body + " ", sig)).toBe(false);
    expect(verifyCryptoBotSignature(token, body, undefined)).toBe(false);
    expect(verifyCryptoBotSignature("other", body, sig)).toBe(false);
  });
});

describe("каталог и экономика", () => {
  it("у эмоций уникальные id и есть эмодзи", () => {
    expect(new Set(EMOTIONS.map((e) => e.id)).size).toBe(EMOTIONS.length);
    expect(EMOTIONS.length).toBeGreaterThanOrEqual(24);
    for (const e of EMOTIONS) expect(e.emoji.length).toBeGreaterThan(0);
  });
  it("цены согласованы: скидка растёт с объёмом", () => {
    const p = Object.fromEntries(PRODUCTS.map((x) => [x.id, x]));
    const per = (id: string) => p[id]!.stars / p[id]!.credits;
    expect(per("pack_3")).toBeLessThan(per("pack_1"));
    expect(per("pack_10")).toBeLessThan(per("pack_3"));
    for (const x of PRODUCTS) {
      expect(x.stars).toBeGreaterThan(0);
      expect(x.stars).toBeLessThanOrEqual(10000);
      expect(Number(x.usd)).toBeGreaterThan(0);
    }
  });
  it("стоимость премиум-стиля", () => {
    const prem = STYLES.find((s) => s.premium)!;
    const basic = STYLES.find((s) => !s.premium)!;
    expect(styleCost(basic, false)).toBe(1);
    expect(styleCost(prem, false)).toBe(2);
    expect(styleCost(prem, true)).toBe(1);
  });
  it("промпт содержит эмоцию и стиль", () => {
    const pr = buildPrompt(STYLES[0]!, EMOTIONS[0]!);
    expect(pr).toContain(EMOTIONS[0]!.prompt);
    expect(pr).toContain("white background");
  });
});

describe("имена наборов стикеров", () => {
  it("соответствуют правилам Telegram", () => {
    const name = stickerSetName("0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0", "sebyashka_bot");
    expect(name).toMatch(/^[a-z][a-z0-9_]*_by_sebyashka_bot$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toContain("__");
  });
  it("заголовок ≤ 64 и с @ботом", () => {
    const t = stickerSetTitle("Очень-очень длинное имя пользователя телеграм", "Киберпанк", "sebyashka_bot");
    expect(t.length).toBeLessThanOrEqual(64);
    expect(t.endsWith("@sebyashka_bot")).toBe(true);
    expect(stickerSetTitle("", "Аниме", "b0t_name")).toContain("Себяшка");
  });
});

describe("обработка изображений", () => {
  it("селфи нормализуется, маленькие отвергаются", async () => {
    const out = await normalizeSelfie(await fakeSelfie());
    const m = await sharp(out).metadata();
    expect(m.format).toBe("jpeg");
    const tiny = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#fff" } }).png().toBuffer();
    await expect(normalizeSelfie(tiny)).rejects.toThrow(/маленькое/);
    await expect(normalizeSelfie(Buffer.from("not an image"))).rejects.toThrow();
  });

  it("однотонный фон вырезается, центр остаётся", async () => {
    const img = await sharp({ create: { width: 200, height: 200, channels: 4, background: "#ffffff" } })
      .composite([{ input: Buffer.from('<svg width="200" height="200"><circle cx="100" cy="100" r="50" fill="red"/></svg>') }])
      .raw()
      .toBuffer({ resolveWithObject: true });
    const cut = removeFlatBackground({ data: img.data, width: 200, height: 200 });
    expect(cut.data[3]).toBe(0); // угол прозрачный
    expect(cut.data[(100 * 200 + 100) * 4 + 3]).toBe(255); // центр целый
    const box = alphaBBox(cut)!;
    expect(box.width).toBeGreaterThan(90);
    expect(box.width).toBeLessThan(110);
  });

  it("стикер: 512 по большей стороне, прозрачность, ≤ 512 КБ", async () => {
    const gen = new MockGenerator();
    const raw = await gen.generate({ selfie: await fakeSelfie(), prompt: "", negativePrompt: "", seed: 7, emoji: "😄", label: "Радость" });
    const { buffer, format } = await toSticker(raw, { removeBackground: true });
    const m = await sharp(buffer).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(512);
    expect(Math.min(m.width!, m.height!)).toBeLessThanOrEqual(512);
    expect(m.hasAlpha).toBe(true);
    expect(buffer.length).toBeLessThanOrEqual(STICKER_MAX_BYTES);
    expect(["png", "webp"]).toContain(format);
    const { data } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0); // левый верхний угол прозрачный
  });

  it("шумный фон не съедает картинку целиком", async () => {
    const noise = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
      .png()
      .toBuffer();
    const { buffer } = await toSticker(noise, { removeBackground: true });
    const m = await sharp(buffer).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(512);
    expect(buffer.length).toBeLessThanOrEqual(STICKER_MAX_BYTES);
  });

  it("стабильный seed", () => {
    expect(seedFor("a", 1)).toBe(seedFor("a", 1));
    expect(seedFor("a", 1)).not.toBe(seedFor("a", 2));
  });
});

describe("провайдеры", () => {
  it("шаблон входа модели", () => {
    const out = renderTemplate('{"prompt":"{{prompt}}","seed":"{{seed}}","nested":{"url":"{{image_url}}"},"arr":["x {{prompt}}"]}', {
      prompt: 'он сказал "привет"',
      seed: 123,
      image_url: "data:image/jpeg;base64,AAA",
    }) as Record<string, unknown>;
    expect(out.seed).toBe(123);
    expect(out.prompt).toBe('он сказал "привет"');
    expect((out.nested as Record<string, string>).url).toContain("data:image");
    expect(out.arr).toEqual(['x он сказал "привет"']);
    expect(() => renderTemplate("{bad", {})).toThrow(ProviderConfigError);
  });
  it("находит URL картинки в разных форматах ответа", () => {
    expect(findImageUrl({ images: [{ url: "https://a/1.png" }] })).toBe("https://a/1.png");
    expect(findImageUrl({ image: { url: "https://a/2.png" } })).toBe("https://a/2.png");
    expect(findImageUrl(["https://a/3.png"])).toBe("https://a/3.png");
    expect(findImageUrl("https://a/4.png")).toBe("https://a/4.png");
    expect(findImageUrl({ nothing: 1 })).toBeNull();
  });
});

describe("разное", () => {
  it("подписанные ссылки", () => {
    const s = new UrlSigner("x".repeat(40));
    const url = s.sign("/media/packs/a/1.png");
    const q = new URLSearchParams(url.split("?")[1]);
    expect(s.verify("/media/packs/a/1.png", q.get("exp")!, q.get("sig")!)).toBe(true);
    expect(s.verify("/media/packs/a/2.png", q.get("exp")!, q.get("sig")!)).toBe(false);
    expect(s.verify("/media/packs/a/1.png", "1", q.get("sig")!)).toBe(false);
  });
  it("payload Stars", () => {
    const id = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    expect(PaymentService.parseStarsPayload(PaymentService.starsPayload(id))).toBe(id);
    expect(PaymentService.parseStarsPayload("hack")).toBeNull();
    expect(PaymentService.starsPayload(id).length).toBeLessThanOrEqual(128);
  });
  it("классификация ошибок Telegram", () => {
    expect(classifyTelegramError(grammyError(400, "Bad Request: PEER_ID_INVALID")).kind).toBe("user_unreachable");
    expect(classifyTelegramError(grammyError(400, "Bad Request: sticker set name is already occupied")).kind).toBe("set_exists");
    expect(classifyTelegramError(grammyError(400, "Bad Request: STICKERSET_INVALID")).kind).toBe("set_missing");
    expect(classifyTelegramError(grammyError(429, "Too Many Requests")).kind).toBe("flood");
  });
  it("конфиг ловит типичные ошибки", () => {
    const base = { BOT_TOKEN, DATABASE_URL: "postgres://x", SIGNING_SECRET: "s".repeat(40) };
    expect(() => loadConfig({ ...base, BOT_TOKEN: "bad" })).toThrow(/BOT_TOKEN/);
    expect(() => loadConfig({ ...base, BOT_MODE: "webhook" })).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, GEN_PROVIDER: "fal" })).toThrow(/FAL_KEY/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", DEV_AUTH: "true" })).toThrow(/DEV_AUTH/);
    expect(loadConfig(base).WEBAPP_URL).toBe("http://localhost:3000");
  });
});
