import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyBaseLogger, type FastifyInstance, type FastifyReply } from "fastify";
import { webhookCallback, type Bot } from "grammy";
import { z } from "zod";
import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import { EMOTIONS, PRODUCTS, STYLES, WISH_MAX_LEN } from "../domain/catalog.js";
import { getOrder, redeemGift } from "../domain/orders.js";
import { activePackOf, createPack, getPack, listPacks, packStickers, queuePosition, type PackRow } from "../domain/packs.js";
import { attachReferrer, getUser, isPro, track, upsertUser, type UserRow } from "../domain/users.js";
import { AppError } from "../errors.js";
import { normalizeSelfie } from "../generation/postprocess.js";
import type { Logger } from "../logger.js";
import { verifyCryptoBotSignature, type CryptoWebhookUpdate } from "../payments/cryptobot.js";
import type { PaymentService } from "../payments/service.js";
import { paths, type Storage, type UrlSigner } from "../storage.js";
import { InitDataError, parseStartParam, validateInitData } from "../telegram/initData.js";
import { esc, failureReasonForUser, T } from "../texts.js";
import { who, type AdminNotifier } from "../admin/notifier.js";
import { findUsers, getFunnel, getStats, recentPayments, userCard } from "../admin/queries.js";
import { changeCredits, lockUser } from "../domain/users.js";

declare module "fastify" {
  interface FastifyRequest {
    user?: UserRow;
    startParam?: string | null;
  }
}

export interface ApiDeps {
  sql: Sql;
  cfg: Config;
  log: Logger;
  storage: Storage;
  signer: UrlSigner;
  payments: PaymentService;
  bot: Bot;
  botUsername: string;
  notifier?: AdminNotifier;
}

const CLIENT_EVENTS = new Set(["app_open", "paywall_view", "share", "style_view", "add_stickers_click", "gift_share", "ref_share"]);

function webappDist(): string {
  if (process.env.WEBAPP_DIST) return path.resolve(process.env.WEBAPP_DIST);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../webapp/dist");
}

export async function buildServer(d: ApiDeps): Promise<FastifyInstance> {
  const { sql, cfg, storage, signer } = d;
  const app = Fastify({
    loggerInstance: d.log as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    disableRequestLogging: cfg.NODE_ENV === "production",
  });

  await app.register(multipart, { limits: { fileSize: cfg.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 } });
  await app.register(rateLimit, {
    global: true,
    max: 180,
    timeWindow: "1 minute",
    hook: "preHandler",
    keyGenerator: (req) => (req.user ? `u${req.user.id}` : req.ip),
    errorResponseBuilder: () => ({ error: "RATE_LIMIT", message: "Слишком много запросов, подожди немного", statusCode: 429 }),
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode === 429) return reply.status(429).send({ error: "RATE_LIMIT", message: "Слишком много запросов, подожди немного" });
    if (err.code === "FST_REQ_FILE_TOO_LARGE") {
      return reply.status(413).send({ error: "BAD_IMAGE", message: `Фото больше ${cfg.MAX_UPLOAD_MB} МБ` });
    }
    if (err instanceof z.ZodError) return reply.status(400).send({ error: "BAD_REQUEST", message: "Некорректный запрос" });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: "BAD_REQUEST", message: err.message });
    req.log.error({ err: err.stack }, "необработанная ошибка API");
    return reply.status(500).send({ error: "INTERNAL", message: "Что-то сломалось, попробуй ещё раз" });
  });

  /* ------------------------ служебное ------------------------ */

  app.get("/health", async () => {
    await sql`SELECT 1`;
    return { ok: true };
  });

  /* ------------------------ вебхуки ------------------------ */

  if (cfg.BOT_MODE === "webhook") {
    const handle = webhookCallback(d.bot, "fastify", { secretToken: cfg.TELEGRAM_WEBHOOK_SECRET, timeoutMilliseconds: 55_000 });
    app.post("/telegram/webhook", { config: { rateLimit: false } }, handle);
  }

  await app.register(async (scope) => {
    // Для проверки подписи нужен сырой body.
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/cryptobot/webhook", { config: { rateLimit: false } }, async (req, reply) => {
      if (!cfg.CRYPTOBOT_TOKEN) return reply.status(404).send();
      const raw = req.body as string;
      const sig = req.headers["crypto-pay-api-signature"];
      if (!verifyCryptoBotSignature(cfg.CRYPTOBOT_TOKEN, raw, typeof sig === "string" ? sig : undefined)) {
        req.log.warn("CryptoBot webhook: неверная подпись");
        return reply.status(401).send({ ok: false });
      }
      const update = JSON.parse(raw) as CryptoWebhookUpdate;
      if (update.update_type === "invoice_paid") await d.payments.onCryptoInvoicePaid(update.payload);
      return { ok: true };
    });
  });

  /* ------------------------ картинки ------------------------ */

  app.get<{ Params: { packId: string; file: string }; Querystring: { exp?: string; sig?: string } }>(
    "/media/packs/:packId/:file",
    { config: { rateLimit: false } },
    async (req, reply) => {
      const { packId, file } = req.params;
      if (!/^[0-9a-f-]{36}$/.test(packId) || !/^\d{1,2}\.(png|webp)$/.test(file)) return reply.status(404).send();
      const pathname = `/media/packs/${packId}/${file}`;
      if (!signer.verify(pathname, req.query.exp, req.query.sig)) return reply.status(403).send();
      const rel = `packs/${packId}/${file}`;
      if (!(await storage.exists(rel))) return reply.status(404).send();
      reply.header("Cache-Control", "private, max-age=3600");
      reply.type(file.endsWith(".png") ? "image/png" : "image/webp");
      return reply.send(await storage.read(rel));
    },
  );

  /* ------------------------ API мини-приложения ------------------------ */

  await app.register(
    async (api) => {
      api.addHook("onRequest", async (req) => {
        const header = req.headers.authorization ?? "";
        if (!header.startsWith("tma ")) throw new AppError("UNAUTHORIZED", "Открой приложение из Telegram");
        const raw = header.slice(4);
        let tgUser: { id: number; first_name?: string; username?: string; language_code?: string };
        if (cfg.DEV_AUTH && raw.startsWith("dev:")) {
          tgUser = { id: Number(raw.slice(4)) || 1, first_name: "Dev" };
          req.startParam = null;
        } else {
          try {
            const data = validateInitData(raw, cfg.BOT_TOKEN);
            tgUser = data.user;
            req.startParam = data.startParam;
          } catch (e) {
            throw new AppError("UNAUTHORIZED", e instanceof InitDataError ? e.message : "Ошибка авторизации");
          }
        }
        const { user, isNew } = await upsertUser(sql, tgUser);
        if (user.is_banned) throw new AppError("BANNED", "Доступ ограничен. Напиши в поддержку.");
        req.user = user;
        if (isNew) {
          d.notifier?.notify(
            "new_user",
            `👤 <b>Новый пользователь</b> (мини-апп)\n${who(user)}${req.startParam ? ` · метка ${esc(req.startParam.slice(0, 40))}` : " · органика"}`,
          );
        }
      });

      api.post("/me", async (req) => {
        let user = req.user!;
        const sp = parseStartParam(req.startParam);
        const notices: string[] = [];
        const referrer = sp.ref ? await attachReferrer(sql, user.id, sp.ref) : null;
        if (referrer?.rewarded) await d.bot.api.sendMessage(referrer.referrerId, T.inviteReward(), { parse_mode: "HTML" }).catch(() => {});
        if (sp.gift) {
          try {
            const g = await redeemGift(sql, user.id, sp.gift);
            notices.push(`🎁 Тебе подарили ${g.credits} пак!`);
          } catch (e) {
            if (e instanceof AppError && e.code !== "GIFT_USED") notices.push(e.message);
          }
        }
        await track(sql, user.id, "app_open", { start: req.startParam ?? null });
        user = (await getUser(sql, user.id)) ?? user;
        const active = await activePackOf(sql, user.id);
        return {
          user: serializeUser(user, cfg, d.botUsername),
          active: active ? await serializePack(active, sql, signer, false) : null,
          notices,
          catalog: {
            styles: STYLES.map(({ prompt: _p, tag: _t, outfit: _o, pixelate: _x, ...s }) => s),
            wishMaxLen: WISH_MAX_LEN,
            products: PRODUCTS,
            freePackSize: cfg.FREE_PACK_SIZE,
            packSize: cfg.STICKERS_PER_PACK,
            // Названия эмоций пака по порядку: после пробы показываем, какие ещё не открыты.
            emotions: EMOTIONS.slice(0, cfg.STICKERS_PER_PACK).map((e) => e.title),
            cryptoEnabled: !!d.payments.crypto,
          },
          bot: { username: d.botUsername, support: cfg.SUPPORT_USERNAME },
        };
      });

      api.post(
        "/selfie",
        { config: { rateLimit: { max: 15, timeWindow: "10 minutes" } } },
        async (req) => {
          const user = req.user!;
          const file = await req.file();
          if (!file) throw new AppError("BAD_IMAGE", "Файл не получен");
          if (!/^image\//.test(file.mimetype)) throw new AppError("BAD_IMAGE", "Нужна картинка (JPG, PNG, HEIC)");
          const buf = await file.toBuffer();
          let jpeg: Buffer;
          try {
            jpeg = await normalizeSelfie(buf);
          } catch (e) {
            throw new AppError("BAD_IMAGE", `Не удалось обработать фото: ${(e as Error).message}`);
          }
          const rel = paths.selfie(user.id);
          await storage.write(rel, jpeg);
          const prev = user.selfie_path;
          await sql`UPDATE users SET selfie_path = ${rel}, selfie_uploaded_at = now(), updated_at = now() WHERE id = ${user.id}`;
          if (prev && prev !== rel) await storage.remove(prev).catch(() => {});
          await track(sql, user.id, "selfie_uploaded", { bytes: buf.length });
          return { ok: true };
        },
      );

      const createSchema = z.object({
        styleId: z.string().max(32),
        free: z.boolean().default(false),
        wish: z.string().max(400).optional().nullable(),
      });
      api.post("/packs", { config: { rateLimit: { max: 10, timeWindow: "10 minutes" } } }, async (req) => {
        const body = createSchema.parse(req.body);
        const user = req.user!;
        const admin = cfg.ADMIN_IDS.includes(user.id);
        const pack = await createPack(sql, storage, cfg, d.botUsername, { user, styleId: body.styleId, free: body.free, wish: body.wish, isAdmin: admin });
        d.notifier?.notify(
          "pack_created",
          `🎨 <b>Новый пак</b> · ${pack.style_id} · ${admin ? "админ" : pack.is_free ? "бесплатный" : `−${pack.credits_spent} пак.`}` +
            (pack.custom_prompt ? `\n«${esc(pack.custom_prompt.slice(0, 120))}»` : "") +
            `\n${who(user)}`,
        );
        return { pack: await serializePack(pack, sql, signer, true) };
      });

      api.get("/packs", async (req) => {
        const packs = await listPacks(sql, req.user!.id);
        return { packs: await Promise.all(packs.map((p) => serializePack(p, sql, signer, false))) };
      });

      api.get<{ Params: { id: string } }>("/packs/:id", async (req) => {
        const pack = await getPack(sql, req.params.id);
        if (!pack || pack.user_id !== req.user!.id) throw new AppError("NOT_FOUND", "Пак не найден");
        return { pack: await serializePack(pack, sql, signer, true) };
      });

      const orderSchema = z.object({ productId: z.string().max(32), provider: z.enum(["stars", "cryptobot"]) });
      api.post("/orders", { config: { rateLimit: { max: 20, timeWindow: "10 minutes" } } }, async (req) => {
        const body = orderSchema.parse(req.body);
        const { order, url } = await d.payments.createInvoice(req.user!, body.productId, body.provider);
        return { orderId: order.id, url, provider: body.provider };
      });

      api.get<{ Params: { id: string } }>("/orders/:id", async (req) => {
        const order = await getOrder(sql, req.params.id);
        if (!order || order.user_id !== req.user!.id) throw new AppError("NOT_FOUND", "Заказ не найден");
        // Пользователь вернулся из CryptoBot раньше вебхука - проверим сами.
        if (order.provider === "cryptobot" && order.status === "pending" && order.provider_invoice_id && d.payments.crypto) {
          const [inv] = await d.payments.crypto.getInvoices([Number(order.provider_invoice_id)]).catch(() => []);
          if (inv?.status === "paid") await d.payments.onCryptoInvoicePaid(inv).catch(() => null);
        }
        const fresh = (await getOrder(sql, order.id))!;
        const gift = fresh.status === "paid"
          ? (await sql<{ code: string }[]>`SELECT code FROM gifts WHERE order_id = ${fresh.id}`)[0]?.code
          : undefined;
        return {
          status: fresh.status,
          productId: fresh.product_id,
          giftLink: gift ? `https://t.me/${d.botUsername}?start=gift_${gift}` : null,
        };
      });

      api.post("/gifts/redeem", async (req) => {
        const { code } = z.object({ code: z.string().max(32) }).parse(req.body);
        const r = await redeemGift(sql, req.user!.id, code.trim().toLowerCase());
        return { credits: r.credits, balance: r.balance };
      });

      api.get("/gifts", async (req) => {
        const rows = await sql<{ code: string; redeemed_at: Date | null; created_at: Date }[]>`
          SELECT code, redeemed_at, created_at FROM gifts WHERE buyer_id = ${req.user!.id} AND NOT revoked ORDER BY created_at DESC LIMIT 20`;
        return {
          gifts: rows.map((g) => ({ link: `https://t.me/${d.botUsername}?start=gift_${g.code}`, redeemed: !!g.redeemed_at, createdAt: g.created_at })),
        };
      });

      /* ---------------- админ ---------------- */

      const requireAdmin = (req: { user?: UserRow }) => {
        if (!req.user || !cfg.ADMIN_IDS.includes(req.user.id)) throw new AppError("FORBIDDEN", "Нет доступа");
      };

      api.get("/admin/overview", async (req) => {
        requireAdmin(req);
        const [stats, funnel, payments] = await Promise.all([getStats(sql), getFunnel(sql, 7), recentPayments(sql, 15)]);
        return {
          stats,
          funnel,
          payments: payments.map((p) => ({
            id: p.id,
            userId: p.user_id,
            name: p.username ? `@${p.username}` : p.first_name,
            productId: p.product_id,
            provider: p.provider,
            stars: p.amount_stars,
            usd: p.amount_usd,
            paidAt: p.paid_at,
            recurring: p.is_recurring,
            refunded: p.status === "refunded",
          })),
        };
      });

      api.get<{ Querystring: { q?: string } }>("/admin/users", async (req) => {
        requireAdmin(req);
        const users = await findUsers(sql, String(req.query.q ?? "").slice(0, 64), 10);
        return { users: await Promise.all(users.map((u) => userCard(sql, u))) };
      });

      api.post<{ Params: { id: string } }>("/admin/users/:id/grant", async (req) => {
        requireAdmin(req);
        const id = Number(req.params.id);
        const { delta } = z.object({ delta: z.number().int().min(-1000).max(1000).refine((n) => n !== 0) }).parse(req.body);
        const r = await sql.begin(async (tx) => {
          await lockUser(tx, id);
          return changeCredits(tx, id, delta, "admin", `${req.user!.id}:${Date.now()}`);
        });
        d.log.info({ admin: req.user!.id, target: id, delta }, "админ изменил баланс");
        return { balance: r.balance };
      });

      api.post<{ Params: { id: string } }>("/admin/users/:id/ban", async (req) => {
        requireAdmin(req);
        const id = Number(req.params.id);
        if (cfg.ADMIN_IDS.includes(id)) throw new AppError("BAD_REQUEST", "Нельзя забанить админа");
        const { banned } = z.object({ banned: z.boolean() }).parse(req.body);
        await sql`UPDATE users SET is_banned = ${banned}, updated_at = now() WHERE id = ${id}`;
        d.log.info({ admin: req.user!.id, target: id, banned }, "админ изменил бан");
        return { banned };
      });

      api.post("/events", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
        const { name, props } = z
          .object({ name: z.string().max(40), props: z.record(z.string(), z.union([z.string().max(200), z.number(), z.boolean()])).default({}) })
          .parse(req.body);
        if (CLIENT_EVENTS.has(name)) await track(sql, req.user!.id, name, props);
        return { ok: true };
      });
    },
    { prefix: "/api" },
  );

  /* ------------------------ статика мини-приложения ------------------------ */

  const dist = webappDist();
  if (existsSync(path.join(dist, "index.html"))) {
    await app.register(fastifyStatic, {
      root: dist,
      prefix: "/",
      index: ["index.html"],
      setHeaders: (res, filePath) => {
        // Хешированные ассеты кешируем навсегда, index.html - никогда (иначе пользователи не увидят обновления).
        res.header("Cache-Control", filePath.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    app.setNotFoundHandler((req, reply: FastifyReply) => {
      if (req.method === "GET" && !req.url.startsWith("/api/") && !req.url.startsWith("/media/")) {
        return reply.header("Cache-Control", "no-cache").sendFile("index.html");
      }
      return reply.status(404).send({ error: "NOT_FOUND", message: "Не найдено" });
    });
  } else {
    d.log.warn({ dist }, "сборка мини-приложения не найдена - отдаю только API (выполни npm run build -w webapp)");
  }

  return app;
}

export function serializeUser(u: UserRow, cfg: Config, botUsername: string) {
  const selfieValid =
    !!u.selfie_path && !!u.selfie_uploaded_at && Date.now() - u.selfie_uploaded_at.getTime() < cfg.SELFIE_TTL_HOURS * 3_600_000;
  return {
    id: u.id,
    isAdmin: cfg.ADMIN_IDS.includes(u.id),
    firstName: u.first_name,
    credits: u.credits,
    freePackAvailable: !u.free_pack_used,
    isPro: isPro(u),
    proUntil: u.pro_until,
    hasSelfie: selfieValid,
    hasStartedBot: u.has_started_bot && !u.bot_blocked,
    referralLink: `https://t.me/${botUsername}?start=ref_${u.referral_code}`,
  };
}

export async function serializePack(p: PackRow, sql: Sql, signer: UrlSigner, withStickers: boolean) {
  const style = STYLES.find((s) => s.id === p.style_id);
  const stickers = withStickers || p.status === "ready" ? await packStickers(sql, p.id) : [];
  const done = stickers.filter((s) => s.status === "done" && s.file_path);
  return {
    id: p.id,
    styleId: p.style_id,
    styleTitle: style?.title ?? p.style_id,
    status: p.status,
    total: p.total,
    done: p.done,
    isFree: p.is_free,
    title: p.sticker_set_title,
    wish: p.custom_prompt,
    addUrl: p.status === "ready" ? `https://t.me/addstickers/${p.sticker_set_name}` : null,
    error: p.status === "failed" ? failureReasonForUser(p.error ?? "") : null,
    queuePosition: p.status === "queued" ? await queuePosition(sql, p) : 0,
    createdAt: p.created_at,
    cover: done[0] ? signer.sign(`/media/${done[0].file_path}`) : null,
    stickers: withStickers ? done.map((s) => ({ idx: s.idx, emoji: s.emoji, url: signer.sign(`/media/${s.file_path}`) })) : [],
  };
}

export type SerializedPack = Awaited<ReturnType<typeof serializePack>>;
