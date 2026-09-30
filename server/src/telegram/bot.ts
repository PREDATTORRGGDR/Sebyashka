import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import { redeemGift, refundOrderByCharge } from "../domain/orders.js";
import { requeueNeedsStart } from "../domain/packs.js";
import { attachReferrer, changeCredits, getUser, isPro, lockUser, track, upsertUser } from "../domain/users.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { PaymentService } from "../payments/service.js";
import { esc, T } from "../texts.js";
import { parseStartParam } from "./initData.js";
import { ALERT_TYPES, getMuted, toggleMuted, who, type AdminNotifier, type AlertType } from "../admin/notifier.js";
import { findUsers, getFunnel, getStats, userCard } from "../admin/queries.js";

export interface BotDeps {
  sql: Sql;
  cfg: Config;
  log: Logger;
  payments: PaymentService;
  botUsername: string;
  notifier?: AdminNotifier;
}

export function appUrl(cfg: Config, screen?: string): string {
  return screen ? `${cfg.WEBAPP_URL}?screen=${encodeURIComponent(screen)}` : cfg.WEBAPP_URL;
}

/** Бот — только вход в приложение: у каждого сообщения одна кнопка «Открыть». */
export function appKeyboard(cfg: Config, text = T.openApp, screen?: string): InlineKeyboard {
  return new InlineKeyboard().webApp(text, appUrl(cfg, screen));
}

export function setupBot(bot: Bot, d: BotDeps): void {
  const { sql, cfg, log } = d;
  const isAdmin = (ctx: Context) => !!ctx.from && cfg.ADMIN_IDS.includes(ctx.from.id);

  // Только личные чаты: в группах бот молчит.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private" && !ctx.preCheckoutQuery) return;
    await next();
  });

  bot.command("start", async (ctx) => {
    if (!ctx.from || ctx.from.is_bot) return;
    const { user, isNew } = await upsertUser(sql, ctx.from, { startedBot: true });
    if (user.is_banned) return void (await ctx.reply(T.banned));
    const param = parseStartParam(ctx.match);
    await track(sql, user.id, "bot_start", { isNew, param: ctx.match || null });
    const referrer = param.ref ? await attachReferrer(sql, user.id, param.ref) : null;
    if (isNew) {
      d.notifier?.notify(
        "new_user",
        `👤 <b>Новый пользователь</b> (бот)\n${who(user)}` +
          (referrer ? ` · по приглашению <code>${referrer}</code>` : param.gift ? " · по подарку" : ctx.match ? ` · метка ${esc(ctx.match.slice(0, 40))}` : " · органика"),
      );
    }
    if (ctx.match === "terms") return void (await ctx.reply(T.terms(d.botUsername), { parse_mode: "HTML", reply_markup: appKeyboard(cfg) }));
    await ctx.reply(T.welcome(ctx.from.first_name), { parse_mode: "HTML", reply_markup: appKeyboard(cfg) });
    if (param.gift) {
      try {
        const g = await redeemGift(sql, user.id, param.gift);
        await ctx.reply(T.giftRedeemed(g.credits), { reply_markup: appKeyboard(cfg, "🎁 Открыть") });
      } catch (e) {
        await ctx.reply(T.giftError(e instanceof AppError ? e.message : "Не удалось активировать подарок"));
      }
    }
    // Паки, которые ждали /start, — отправляем в очередь.
    const n = await requeueNeedsStart(sql, user.id);
    if (n) await ctx.reply(`⏳ Собираю твои паки (${n}) — следи в приложении.`, { reply_markup: appKeyboard(cfg, "Открыть") });
  });

  bot.command("terms", (ctx) => ctx.reply(T.terms(d.botUsername), { parse_mode: "HTML", reply_markup: appKeyboard(cfg) }));
  // Telegram требует у ботов с оплатой команду /paysupport.
  bot.command("paysupport", (ctx) => ctx.reply(T.paySupport(cfg.SUPPORT_USERNAME), { parse_mode: "HTML", reply_markup: appKeyboard(cfg) }));

  /* ---------------- Оплата Stars ---------------- */

  bot.on("pre_checkout_query", async (ctx) => {
    const q = ctx.preCheckoutQuery;
    try {
      const err = await d.payments.validatePreCheckout(q.from.id, q.invoice_payload, q.currency, q.total_amount);
      await ctx.answerPreCheckoutQuery(!err, err ? { error_message: err } : undefined);
    } catch (e) {
      log.error({ err: (e as Error).message }, "pre_checkout_query");
      await ctx.answerPreCheckoutQuery(false, { error_message: "Техническая ошибка, попробуй через минуту" }).catch(() => {});
    }
  });

  bot.on("message:successful_payment", async (ctx) => {
    const p = ctx.message.successful_payment;
    try {
      await d.payments.onStarsPayment({
        userId: ctx.from.id,
        payload: p.invoice_payload,
        chargeId: p.telegram_payment_charge_id,
        amount: p.total_amount,
        isRecurring: !!p.is_recurring,
        isFirstRecurring: !!p.is_first_recurring,
        raw: p,
      });
    } catch (e) {
      // Деньги списаны, а зачислить не смогли — критично: логируем и зовём админов.
      log.error({ err: (e as Error).message, charge: p.telegram_payment_charge_id }, "НЕ ЗАЧИСЛЕНА ОПЛАТА STARS");
      await ctx.reply(`Оплата получена, но зачисление задержалось. Мы уже разбираемся. Код: ${p.telegram_payment_charge_id}`);
      d.notifier?.notify(
        "system",
        `🚨 <b>Не зачислена оплата Stars</b>\n${who(ctx.from)}\ncharge <code>${esc(p.telegram_payment_charge_id)}</code>\n${esc((e as Error).message)}`,
      );
    }
  });

  // Возврат, инициированный Telegram (например, по спору).
  bot.on("message", async (ctx, next) => {
    const refunded = (ctx.message as { refunded_payment?: { telegram_payment_charge_id: string } }).refunded_payment;
    if (!refunded) return next();
    const r = await refundOrderByCharge(sql, refunded.telegram_payment_charge_id);
    log.warn({ charge: refunded.telegram_payment_charge_id, found: !!r }, "refunded_payment от Telegram");
  });


  /* ---------------- Админ-команды ---------------- */

  bot.command(["admin", "stats"], async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [st, funnel] = await Promise.all([getStats(sql), getFunnel(sql, 7)]);
    const top = funnel[0]?.users || 1;
    await ctx.reply(
      `<b>Админ-панель</b>\n\n` +
        `👤 Пользователи: <b>${st.users}</b> (+${st.users24h} за сутки), платящих ${st.payers}\n` +
        `🎨 Паки: готово ${st.packsReady}, провалено ${st.packsFailed}, в очереди ${st.inQueue}\n` +
        `💰 Выручка: <b>$${st.revenueUsd}</b> (за сутки $${st.revenue24hUsd})\n` +
        `   Stars: ${st.starsTotal} ⭐ · крипта: $${st.usdTotal}\n\n` +
        `<b>Воронка за 7 дней</b>\n` +
        funnel.map((f) => `${f.label}: ${f.users} (${Math.round((f.users / top) * 100)}%)`).join("\n") +
        `\n\n<b>Команды</b>\n/user &lt;id|@username&gt; — карточка\n/grant &lt;id&gt; &lt;±n&gt; — паки\n/refund &lt;charge_id&gt; — возврат Stars\n` +
        `/ban &lt;id&gt; [off] — бан\n/alerts — какие уведомления присылать\n\nПолная панель — в приложении, вкладка «Админ».`,
      { parse_mode: "HTML", reply_markup: appKeyboard(cfg, "Открыть админку", "admin") },
    );
  });

  const alertsKeyboard = (muted: Set<string>) => {
    const kb = new InlineKeyboard();
    for (const [type, label] of Object.entries(ALERT_TYPES)) {
      kb.text(`${muted.has(type) ? "🔕" : "🔔"} ${label}`, `al:${type}`).row();
    }
    return kb;
  };

  bot.command("alerts", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const muted = await getMuted(sql, ctx.from!.id);
    await ctx.reply("Какие уведомления присылать (нажми, чтобы включить/выключить):", { reply_markup: alertsKeyboard(muted) });
  });

  bot.callbackQuery(/^al:(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return void (await ctx.answerCallbackQuery());
    const type = ctx.match[1] as AlertType;
    if (!(type in ALERT_TYPES)) return void (await ctx.answerCallbackQuery());
    const muted = await toggleMuted(sql, ctx.from.id, type);
    d.notifier?.invalidate();
    await ctx.answerCallbackQuery({ text: muted.has(type) ? "Выключено" : "Включено" });
    await ctx.editMessageReplyMarkup({ reply_markup: alertsKeyboard(muted) }).catch(() => {});
  });

  bot.command("grant", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [idStr, nStr] = (ctx.match ?? "").split(/\s+/);
    const id = Number(idStr);
    const n = Number(nStr);
    if (!Number.isSafeInteger(id) || !Number.isInteger(n) || n === 0) return void (await ctx.reply("Формат: /grant <user_id> <кол-во, можно минус>"));
    try {
      const r = await sql.begin(async (tx) => {
        await lockUser(tx, id);
        return changeCredits(tx, id, n, "admin", `${ctx.from!.id}:${ctx.message!.message_id}`);
      });
      await ctx.reply(`Готово. Баланс ${id}: ${r.balance}`);
    } catch (e) {
      await ctx.reply(`Ошибка: ${(e as Error).message}`);
    }
  });

  bot.command("refund", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const charge = (ctx.match ?? "").trim();
    if (!charge) return void (await ctx.reply("Формат: /refund <telegram_payment_charge_id>"));
    const order = await sql<{ user_id: number; provider: string }[]>`SELECT user_id, provider FROM orders WHERE provider_charge_id = ${charge}`;
    if (!order[0]) return void (await ctx.reply("Платёж не найден"));
    try {
      if (order[0].provider === "stars") await ctx.api.refundStarPayment(order[0].user_id, charge);
      const r = await refundOrderByCharge(sql, charge);
      await ctx.reply(
        `Возврат оформлен. Списано паков: ${r?.creditsTaken ?? 0}.` +
          (order[0].provider === "cryptobot" ? "\nКрипту верни вручную через @CryptoBot (Crypto Pay → переводы)." : ""),
      );
    } catch (e) {
      await ctx.reply(`Ошибка возврата: ${esc((e as Error).message)}`);
    }
  });

  bot.command("ban", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [idStr, flag] = (ctx.match ?? "").split(/\s+/);
    const id = Number(idStr);
    if (!Number.isSafeInteger(id)) return void (await ctx.reply("Формат: /ban <user_id> [off]"));
    await sql`UPDATE users SET is_banned = ${flag !== "off"} WHERE id = ${id}`;
    await ctx.reply(flag === "off" ? "Разбанен" : "Забанен");
  });

  bot.command("user", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [u] = await findUsers(sql, ctx.match ?? "", 1);
    if (!u) return void (await ctx.reply("Не найден. Формат: /user <id> или /user @username"));
    const c = await userCard(sql, u);
    await ctx.reply(
      `${who(u)}\nпаков на балансе: <b>${c.credits}</b> · Pro: ${c.isPro ? "да" : "нет"} · бесплатный использован: ${c.freePackUsed ? "да" : "нет"}\n` +
        `паков создано: ${c.packs} (готово ${c.packsReady}) · оплат: ${c.orders}\n` +
        `оплачено: ${c.paidStars} ⭐ / $${c.paidUsd} · реферер: ${c.referredBy ?? "—"} · бан: ${c.isBanned ? "да" : "нет"}\n` +
        (c.lastCharges.length ? `\nПоследние платежи (для /refund):\n` + c.lastCharges.map((x) => `<code>${esc(x.chargeId)}</code> ${x.productId}`).join("\n") : ""),
      { parse_mode: "HTML" },
    );
  });

  // Всё остальное (текст, фото, стикеры, голосовые) — ведём в приложение.
  bot.on("message", (ctx) => ctx.reply(T.onlyApp, { reply_markup: appKeyboard(cfg) }));

  bot.catch((err) => {
    log.error({ err: err.error instanceof Error ? err.error.stack : String(err.error), update: err.ctx.update.update_id }, "ошибка в обработчике бота");
  });
}

/** Меню команд и кнопка мини-приложения. Вызывается при старте. */
export async function configureBotProfile(bot: Bot, cfg: Config, log: Logger): Promise<void> {
  try {
    await bot.api.setMyCommands([
      { command: "start", description: "Открыть Себяшку" },
      { command: "paysupport", description: "Помощь с оплатой" },
      { command: "terms", description: "Условия и приватность" },
    ]);
    if (cfg.WEBAPP_URL.startsWith("https://")) {
      await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "Стикеры", web_app: { url: cfg.WEBAPP_URL } } });
    } else {
      log.warn("WEBAPP_URL не https — кнопка меню мини-приложения не установлена (Telegram требует https)");
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, "не удалось настроить профиль бота");
  }
}
