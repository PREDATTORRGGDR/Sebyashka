import { createHash, createHmac } from "node:crypto";
import { Bot } from "grammy";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminNotifier } from "../src/admin/notifier.js";
import { buildServer } from "../src/api/server.js";
import type { Config } from "../src/config.js";
import type { Sql } from "../src/db/client.js";
import { buildPrompt, EMOTIONS, sanitizeWish, STYLES } from "../src/domain/catalog.js";
import { getUser } from "../src/domain/users.js";
import { PaymentService } from "../src/payments/service.js";
import { Storage, UrlSigner } from "../src/storage.js";
import { setupBot } from "../src/telegram/bot.js";
import { signInitData } from "../src/telegram/initData.js";
import { BOT_TOKEN, FakeTelegram, fakeSelfie, freshDb, silentLog, TEST_DB, testConfig } from "./helpers.js";

const ADMIN = 900001;
const USER = 900002;
const CRYPTO_TOKEN = "1234:AAcryptotesttoken";

/** Бот без сети: все вызовы Bot API перехватываются и записываются. */
function offlineBot() {
  const bot = new Bot(BOT_TOKEN, {
    botInfo: {
      id: 1, is_bot: true, first_name: "Себяшка", username: "sebyashka_test_bot",
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false,
      can_connect_to_business: false, has_main_web_app: true,
    } as never,
  });
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    const result = method === "createInvoiceLink" ? "https://t.me/$invoice_test" : true;
    return { ok: true, result } as never;
  });
  return { bot, calls };
}

function auth(id: number, name = "Тест", start?: string) {
  const fields: Record<string, string> = {
    user: JSON.stringify({ id, first_name: name, username: `u${id}` }),
    auth_date: String(Math.floor(Date.now() / 1000)),
  };
  if (start) fields.start_param = start;
  return { authorization: `tma ${signInitData(fields, BOT_TOKEN)}` };
}

describe("чистые функции", () => {
  it("пожелание: чистится, режется, запрещёнка отклоняется", () => {
    expect(sanitizeWish("  в костюме   супергероя ")).toEqual({ ok: true, wish: "в костюме супергероя" });
    expect(sanitizeWish("")).toEqual({ ok: true, wish: null });
    expect(sanitizeWish("x".repeat(500))).toMatchObject({ ok: true });
    expect((sanitizeWish("x".repeat(500)) as { wish: string }).wish.length).toBe(200);
    expect(sanitizeWish("голый").ok).toBe(false);
    expect(sanitizeWish("nsfw please").ok).toBe(false);
  });
  it("промпт про любого персонажа + пожелание", () => {
    const p = buildPrompt(STYLES[0]!, EMOTIONS[0]!, "с гитарой");
    expect(p).toContain("same character");
    expect(p).toContain("с гитарой");
    expect(STYLES.find((s) => s.id === "original")).toBeTruthy();
  });
});

describe.skipIf(!TEST_DB)("HTTP API, админка, CryptoBot, бот", () => {
  let sql: Sql;
  let cfg: Config;
  let app: FastifyInstance;
  let tg: FakeTelegram;
  let calls: { method: string; payload: Record<string, unknown> }[];
  let bot: Bot;
  let notifier: AdminNotifier;

  beforeAll(async () => {
    sql = await freshDb();
    cfg = await testConfig({ ADMIN_IDS: String(ADMIN), CRYPTOBOT_TOKEN: CRYPTO_TOKEN, ADMIN_ALERTS: "new_user,invoice,payment,pack_created,system" });
    const off = offlineBot();
    bot = off.bot;
    calls = off.calls;
    tg = new FakeTelegram();
    notifier = new AdminNotifier(bot.api, sql, cfg, silentLog, 60_000);
    const payments = new PaymentService(sql, bot.api, cfg, tg, silentLog, "sebyashka_test_bot", notifier);
    setupBot(bot, { sql, cfg, log: silentLog, payments, botUsername: "sebyashka_test_bot", notifier });
    app = await buildServer({
      sql, cfg, log: silentLog, storage: new Storage(cfg.DATA_DIR), signer: new UrlSigner(cfg.SIGNING_SECRET),
      payments, bot, botUsername: "sebyashka_test_bot", notifier,
    });
  });
  afterAll(async () => {
    await app?.close();
    await sql?.end();
  });

  it("без initData — 401, с поддельной — 401", async () => {
    expect((await app.inject({ method: "POST", url: "/api/me" })).statusCode).toBe(401);
    const bad = await app.inject({ method: "POST", url: "/api/me", headers: { authorization: "tma user=1&hash=" + "0".repeat(64) } });
    expect(bad.statusCode).toBe(401);
  });

  it("/api/me: регистрирует, отдаёт каталог, алерт о новом пользователе", async () => {
    const r = await app.inject({ method: "POST", url: "/api/me", headers: auth(USER, "Вася") });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user.freePackAvailable).toBe(true);
    expect(body.user.isAdmin).toBe(false);
    expect(body.catalog.styles.length).toBeGreaterThan(5);
    expect(body.catalog.styles[0].prompt).toBeUndefined(); // промпты не утекают клиенту
    await notifier.flush();
    const alert = calls.find((c) => c.method === "sendMessage" && String(c.payload.text).includes("Новый пользователь"));
    expect(alert?.payload.chat_id).toBe(ADMIN);
  });

  it("загрузка фото → пак с пожеланием → статус", async () => {
    const photo = await fakeSelfie();
    const boundary = "----b";
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      photo,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: "POST", url: "/api/selfie", payload,
      headers: { ...auth(USER), "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(up.statusCode).toBe(200);

    const notImage = await app.inject({
      method: "POST", url: "/api/selfie",
      payload: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="x.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot-an-image\r\n--${boundary}--\r\n`),
      ]),
      headers: { ...auth(USER), "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    expect(notImage.statusCode).toBe(422);

    const bad = await app.inject({ method: "POST", url: "/api/packs", headers: auth(USER), payload: { styleId: "anime", free: true, wish: "голый" } });
    expect(bad.statusCode).toBe(400);

    const r = await app.inject({ method: "POST", url: "/api/packs", headers: auth(USER), payload: { styleId: "original", free: true, wish: "с гитарой" } });
    expect(r.statusCode).toBe(200);
    const pack = r.json().pack;
    expect(pack.wish).toBe("с гитарой");
    expect(pack.status).toBe("queued");
    const st = await app.inject({ method: "GET", url: `/api/packs/${pack.id}`, headers: auth(USER) });
    expect(st.json().pack.queuePosition).toBeGreaterThanOrEqual(1);
    // чужой пак не отдаём
    await app.inject({ method: "POST", url: "/api/me", headers: auth(USER + 50) });
    expect((await app.inject({ method: "GET", url: `/api/packs/${pack.id}`, headers: auth(USER + 50) })).statusCode).toBe(404);
  });

  it("админка закрыта для обычных, открыта для админа", async () => {
    expect((await app.inject({ method: "GET", url: "/api/admin/overview", headers: auth(USER) })).statusCode).toBe(403);
    const me = await app.inject({ method: "POST", url: "/api/me", headers: auth(ADMIN, "Босс") });
    expect(me.json().user.isAdmin).toBe(true);
    const ov = await app.inject({ method: "GET", url: "/api/admin/overview", headers: auth(ADMIN) });
    expect(ov.statusCode).toBe(200);
    expect(ov.json().stats.users).toBeGreaterThanOrEqual(2);
    expect(ov.json().funnel[0].key).toBe("bot_start");

    const found = await app.inject({ method: "GET", url: "/api/admin/users?q=u900002", headers: auth(ADMIN) });
    expect(found.json().users[0].id).toBe(USER);
    const g = await app.inject({ method: "POST", url: `/api/admin/users/${USER}/grant`, headers: auth(ADMIN), payload: { delta: 5 } });
    expect(g.json().balance).toBe(5);
    const minus = await app.inject({ method: "POST", url: `/api/admin/users/${USER}/grant`, headers: auth(ADMIN), payload: { delta: -100 } });
    expect(minus.statusCode).toBe(402); // в минус не уходим
    expect((await app.inject({ method: "POST", url: `/api/admin/users/${ADMIN}/ban`, headers: auth(ADMIN), payload: { banned: true } })).statusCode).toBe(400);
    await app.inject({ method: "POST", url: `/api/admin/users/${USER + 50}/ban`, headers: auth(ADMIN), payload: { banned: true } });
    expect((await app.inject({ method: "POST", url: "/api/me", headers: auth(USER + 50) })).statusCode).toBe(403);
  });

  it("админ генерирует полный пак без списания", async () => {
    const photo = await sharp(await fakeSelfie()).jpeg().toBuffer();
    const boundary = "----a";
    await app.inject({
      method: "POST", url: "/api/selfie",
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), photo, Buffer.from(`\r\n--${boundary}--\r\n`)]),
      headers: { ...auth(ADMIN), "content-type": `multipart/form-data; boundary=${boundary}` },
    });
    const r = await app.inject({ method: "POST", url: "/api/packs", headers: auth(ADMIN), payload: { styleId: "cyberpunk", free: false } });
    expect(r.statusCode).toBe(200);
    expect(r.json().pack.total).toBe(cfg.STICKERS_PER_PACK);
    expect((await getUser(sql, ADMIN))!.credits).toBe(0);
  });

  it("CryptoBot: счёт → вебхук с подписью → зачисление ровно один раз", async () => {
    // Подменяем сетевой вызов createInvoice.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("crypt.bot")) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { invoice_id: 777, hash: "h", status: "active", bot_invoice_url: "https://t.me/CryptoBot?start=IV777", amount: body.amount, payload: body.payload } }));
      }
      return realFetch(url, init);
    }) as typeof fetch;
    try {
      const o = await app.inject({ method: "POST", url: "/api/orders", headers: auth(USER), payload: { productId: "pack_3", provider: "cryptobot" } });
      expect(o.statusCode).toBe(200);
      const { orderId, url } = o.json();
      expect(url).toContain("CryptoBot");

      const update = JSON.stringify({ update_id: 1, update_type: "invoice_paid", request_date: new Date().toISOString(),
        payload: { invoice_id: 777, hash: "h", status: "paid", bot_invoice_url: "", amount: "4.99", payload: orderId, paid_asset: "USDT", paid_amount: "4.99" } });
      const sig = createHmac("sha256", createHash("sha256").update(CRYPTO_TOKEN).digest()).update(update).digest("hex");

      const forged = await app.inject({ method: "POST", url: "/cryptobot/webhook", payload: update, headers: { "content-type": "application/json", "crypto-pay-api-signature": "0".repeat(64) } });
      expect(forged.statusCode).toBe(401);

      const before = (await getUser(sql, USER))!.credits;
      for (let i = 0; i < 3; i++) {
        const w = await app.inject({ method: "POST", url: "/cryptobot/webhook", payload: update, headers: { "content-type": "application/json", "crypto-pay-api-signature": sig } });
        expect(w.statusCode).toBe(200);
      }
      expect((await getUser(sql, USER))!.credits).toBe(before + 3);
      const st = await app.inject({ method: "GET", url: `/api/orders/${orderId}`, headers: auth(USER) });
      expect(st.json().status).toBe("paid");
      await notifier.flush();
      expect(calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("Оплата"))).toBe(true);
      expect(calls.some((c) => c.method === "sendMessage" && String(c.payload.text).includes("Счёт"))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("Stars: счёт создаётся с XTR, pre_checkout проверяет сумму, successful_payment зачисляет", async () => {
    const o = await app.inject({ method: "POST", url: "/api/orders", headers: auth(USER), payload: { productId: "pro_30", provider: "stars" } });
    const { orderId } = o.json();
    const inv = calls.filter((c) => c.method === "createInvoiceLink").at(-1)!;
    expect(inv.payload.currency).toBe("XTR");
    expect(inv.payload.subscription_period).toBe(2592000);
    const from = { id: USER, is_bot: false, first_name: "Вася" };

    calls.length = 0;
    await bot.handleUpdate({ update_id: 10, pre_checkout_query: { id: "q1", from, currency: "XTR", total_amount: 1, invoice_payload: `o:${orderId}` } } as never);
    expect(calls.find((c) => c.method === "answerPreCheckoutQuery")!.payload.ok).toBe(false);
    await bot.handleUpdate({ update_id: 11, pre_checkout_query: { id: "q2", from, currency: "XTR", total_amount: 500, invoice_payload: `o:${orderId}` } } as never);
    expect(calls.filter((c) => c.method === "answerPreCheckoutQuery").at(-1)!.payload.ok).toBe(true);

    const before = (await getUser(sql, USER))!.credits;
    await bot.handleUpdate({
      update_id: 12,
      message: { message_id: 1, date: 0, chat: { id: USER, type: "private", first_name: "Вася" }, from,
        successful_payment: { currency: "XTR", total_amount: 500, invoice_payload: `o:${orderId}`, telegram_payment_charge_id: "stars_ch_1", provider_payment_charge_id: "", is_recurring: true, is_first_recurring: true } },
    } as never);
    const u = (await getUser(sql, USER))!;
    expect(u.credits).toBe(before + 6);
    expect(u.pro_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it("бот: обычному — только кнопка приложения, админу — панель и переключатели алертов", async () => {
    const msg = (id: number, text: string, uid: number) => ({
      update_id: 100 + id,
      message: { message_id: id, date: 0, text, chat: { id: uid, type: "private", first_name: "X" }, from: { id: uid, is_bot: false, first_name: "X" },
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] } : {}) },
    });
    calls.length = 0;
    await bot.handleUpdate(msg(1, "привет", USER) as never);
    const r1 = calls.find((c) => c.method === "sendMessage")!;
    expect(String(r1.payload.text)).toContain("в приложении");
    expect(JSON.stringify(r1.payload.reply_markup)).toContain("web_app");

    calls.length = 0;
    await bot.handleUpdate(msg(2, "/admin", USER) as never);
    expect(calls.filter((c) => c.method === "sendMessage")).toHaveLength(0); // не админ — тишина

    calls.length = 0;
    await bot.handleUpdate(msg(3, "/admin", ADMIN) as never);
    expect(String(calls.find((c) => c.method === "sendMessage")!.payload.text)).toContain("Админ-панель");

    calls.length = 0;
    await bot.handleUpdate(msg(4, "/alerts", ADMIN) as never);
    expect(JSON.stringify(calls[0]!.payload.reply_markup)).toContain("al:payment");
    await bot.handleUpdate({ update_id: 200, callback_query: { id: "cb", chat_instance: "x", data: "al:payment", from: { id: ADMIN, is_bot: false, first_name: "B" },
      message: { message_id: 4, date: 0, chat: { id: ADMIN, type: "private", first_name: "B" } } } } as never);
    const muted = await sql<{ muted: string[] }[]>`SELECT muted FROM admin_prefs WHERE admin_id = ${ADMIN}`;
    expect(muted[0]!.muted).toContain("payment");

    // выключенный тип не приходит, системный — приходит всегда
    notifier.invalidate();
    calls.length = 0;
    notifier.notify("payment", "💰 тест");
    notifier.notify("system", "🚨 тест");
    await notifier.flush();
    const texts = calls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === ADMIN).map((c) => String(c.payload.text));
    expect(texts.join()).toContain("🚨 тест");
    expect(texts.join()).not.toContain("💰 тест");
  });

  it("алерты склеиваются в одно сообщение и режутся по лимиту Telegram", async () => {
    calls.length = 0;
    for (let i = 0; i < 300; i++) notifier.notify("new_user", `👤 пользователь номер ${i} с достаточно длинным текстом`);
    await notifier.flush();
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent.length).toBeGreaterThan(1);
    expect(sent.length).toBeLessThan(20);
    for (const s of sent) expect(String(s.payload.text).length).toBeLessThanOrEqual(4096);
  });
});
