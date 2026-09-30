import type { Api } from "grammy";
import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import { getProduct, STARS_SUBSCRIPTION_PERIOD, type Product } from "../domain/catalog.js";
import {
  createOrder,
  expireStaleCryptoOrders,
  fulfillPayment,
  getOrder,
  pendingCryptoOrders,
  setOrderInvoice,
  type FulfillResult,
  type OrderRow,
  type PaymentEvent,
} from "../domain/orders.js";
import { getUser, track, type UserRow } from "../domain/users.js";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { TelegramGateway } from "../telegram/gateway.js";
import { T } from "../texts.js";
import { InlineKeyboard } from "grammy";
import { CryptoBotClient, CryptoBotError, type CryptoInvoice } from "./cryptobot.js";
import { who, type AdminNotifier } from "../admin/notifier.js";

export class PaymentService {
  readonly crypto: CryptoBotClient | null;

  constructor(
    private readonly sql: Sql,
    private readonly api: Api,
    private readonly cfg: Config,
    private readonly tg: TelegramGateway,
    private readonly log: Logger,
    private readonly botUsername: string,
    private readonly notifier?: AdminNotifier,
  ) {
    this.crypto = cfg.CRYPTOBOT_TOKEN ? new CryptoBotClient(cfg.CRYPTOBOT_TOKEN, cfg.CRYPTOBOT_NETWORK, cfg.CRYPTOBOT_ASSETS) : null;
  }

  /** Payload инвойса Stars: только id заказа (лимит Telegram - 128 байт). */
  static starsPayload(orderId: string): string {
    return `o:${orderId}`;
  }

  static parseStarsPayload(payload: string): string | null {
    const m = /^o:([0-9a-f-]{36})$/.exec(payload);
    return m ? m[1]! : null;
  }

  async createInvoice(user: UserRow, productId: string, provider: "stars" | "cryptobot"): Promise<{ order: OrderRow; url: string }> {
    const product = getProduct(productId);
    if (!product) throw new AppError("UNKNOWN_PRODUCT", "Товар не найден");
    if (user.is_banned) throw new AppError("BANNED", T.banned);
    if (provider === "cryptobot" && !this.crypto) throw new AppError("PROVIDER_DISABLED", "Оплата криптой временно недоступна");

    const order = await createOrder(this.sql, user.id, product, provider);
    try {
      const url = provider === "stars" ? await this.starsLink(product, order) : await this.cryptoLink(product, order);
      await track(this.sql, user.id, "invoice_created", { product: product.id, provider });
      this.notifier?.notify(
        "invoice",
        `🧾 <b>Счёт</b> · ${product.title} · ${provider === "stars" ? `${product.stars} ⭐` : `$${product.usd} крипта`}\n${who(user)}`,
      );
      return { order: { ...order, invoice_url: url }, url };
    } catch (e) {
      await this.sql`UPDATE orders SET status = 'failed' WHERE id = ${order.id}`;
      this.log.error({ err: (e as Error).message, provider }, "не удалось создать счёт");
      if (e instanceof AppError) throw e;
      throw new AppError("PAYMENT_ERROR", "Не удалось создать счёт, попробуй ещё раз");
    }
  }

  private async starsLink(product: Product, order: OrderRow): Promise<string> {
    const url = await this.api.createInvoiceLink(
      product.title,
      product.description,
      PaymentService.starsPayload(order.id),
      "", // для Stars provider_token пустой
      "XTR",
      [{ label: product.title, amount: product.stars }],
      product.kind === "pro" ? { subscription_period: STARS_SUBSCRIPTION_PERIOD } : {},
    );
    await setOrderInvoice(this.sql, order.id, url, null);
    return url;
  }

  private async cryptoLink(product: Product, order: OrderRow): Promise<string> {
    let inv: CryptoInvoice;
    try {
      inv = await this.crypto!.createInvoice({
        usd: product.usd,
        description: `${product.title} - ${product.description}`,
        payload: order.id,
        returnUrl: `https://t.me/${this.botUsername}?startapp=paid`,
      });
    } catch (e) {
      if (e instanceof CryptoBotError) throw new AppError("PAYMENT_ERROR", "CryptoBot не ответил, попробуй позже или оплати Stars");
      throw e;
    }
    await setOrderInvoice(this.sql, order.id, inv.bot_invoice_url, String(inv.invoice_id));
    return inv.bot_invoice_url;
  }

  /** Проверка перед списанием Stars. Отвечать надо в течение 10 секунд. */
  async validatePreCheckout(userId: number, payload: string, currency: string, amount: number): Promise<string | null> {
    const orderId = PaymentService.parseStarsPayload(payload);
    if (!orderId) return "Счёт устарел, создай новый в приложении";
    const order = await getOrder(this.sql, orderId);
    if (!order || order.user_id !== userId) return "Счёт не найден";
    const product = getProduct(order.product_id);
    if (!product) return "Товар больше не продаётся";
    if (currency !== "XTR" || amount !== order.amount_stars) return "Сумма не совпадает, создай новый счёт";
    const user = await getUser(this.sql, userId);
    if (user?.is_banned) return T.banned;
    // Повторная оплата уже оплаченного разового счёта.
    if (order.status === "paid" && product.kind !== "pro") return "Этот счёт уже оплачен";
    return null;
  }

  /** Stars: successful_payment из бота. */
  async onStarsPayment(p: {
    userId: number;
    payload: string;
    chargeId: string;
    amount: number;
    isRecurring: boolean;
    isFirstRecurring: boolean;
    raw: unknown;
  }): Promise<FulfillResult> {
    const orderId = PaymentService.parseStarsPayload(p.payload);
    if (!orderId) throw new AppError("BAD_REQUEST", `неизвестный payload ${p.payload}`);
    const res = await fulfillPayment(this.sql, {
      orderId,
      provider: "stars",
      chargeId: p.chargeId,
      userId: p.userId,
      amountStars: p.amount,
      isRecurring: p.isRecurring && !p.isFirstRecurring,
      raw: p.raw,
    });
    await this.notify(res);
    return res;
  }

  /** CryptoBot: вебхук invoice_paid или поллер. */
  async onCryptoInvoicePaid(inv: CryptoInvoice): Promise<FulfillResult | null> {
    if (inv.status !== "paid" || !inv.payload) return null;
    const order = await getOrder(this.sql, inv.payload);
    if (!order || order.provider !== "cryptobot") {
      this.log.warn({ invoice: inv.invoice_id }, "оплата CryptoBot по неизвестному заказу");
      return null;
    }
    if (order.provider_invoice_id && order.provider_invoice_id !== String(inv.invoice_id)) {
      this.log.error({ invoice: inv.invoice_id, order: order.id }, "invoice_id не совпадает с заказом - подозрение на подмену");
      return null;
    }
    const ev: PaymentEvent = {
      orderId: order.id,
      provider: "cryptobot",
      chargeId: `cb:${inv.invoice_id}`,
      userId: order.user_id,
      amountUsd: order.amount_usd ?? inv.amount,
      paidAsset: inv.paid_asset,
      paidAmount: inv.paid_amount,
      raw: inv,
    };
    const res = await fulfillPayment(this.sql, ev);
    await this.notify(res);
    return res;
  }

  /** Страховка на случай потерянного вебхука: раз в минуту сверяемся с CryptoBot. */
  async pollCrypto(): Promise<number> {
    if (!this.crypto) return 0;
    await expireStaleCryptoOrders(this.sql);
    const orders = await pendingCryptoOrders(this.sql);
    if (!orders.length) return 0;
    const ids = orders.map((o) => Number(o.provider_invoice_id)).filter((n) => Number.isSafeInteger(n));
    let n = 0;
    for (let i = 0; i < ids.length; i += 100) {
      const invoices = await this.crypto.getInvoices(ids.slice(i, i + 100));
      for (const inv of invoices) {
        if (inv.status !== "paid") continue;
        const r = await this.onCryptoInvoicePaid(inv).catch((e) => {
          this.log.error({ err: (e as Error).message, invoice: inv.invoice_id }, "ошибка зачисления из поллера");
          return null;
        });
        if (r?.status === "fulfilled") n++;
      }
    }
    return n;
  }

  private async notify(res: FulfillResult): Promise<void> {
    if (res.status !== "fulfilled") return;
    const { user, product } = res;
    const amount = res.order.provider === "stars" ? `${res.order.amount_stars ?? product.stars} ⭐ (~$${((res.order.amount_stars ?? product.stars) * 0.013).toFixed(2)})` : `$${res.order.amount_usd ?? product.usd} крипта`;
    this.notifier?.notify(
      "payment",
      `💰 <b>${res.order.is_recurring ? "Продление Pro" : "Оплата"}</b> · ${product.title} · ${amount}\n${who(user)}` +
        (res.balance !== undefined ? ` · баланс ${res.balance}` : "") +
        (res.referrerRewarded ? `\n↳ реферер <code>${res.referrerRewarded}</code> получил +1 пак` : ""),
    );
    const open = (text: string, screen: string) => new InlineKeyboard().webApp(text, `${this.cfg.WEBAPP_URL}?screen=${screen}`);
    try {
      if (res.order.is_recurring) {
        const u = await getUser(this.sql, user.id);
        if (u?.pro_until) await this.tg.sendMessage(user.id, T.proRenewed(u.pro_until), open("Открыть", "home"));
      } else if (res.giftCode) {
        await this.tg.sendMessage(user.id, T.giftCreated(), open("🎁 Отправить подарок", "profile"));
      } else {
        await this.tg.sendMessage(user.id, T.paymentOk(product.title, res.balance), open("✨ Сделать стикеры", "create"));
      }
      if (res.referrerRewarded) await this.tg.sendMessage(res.referrerRewarded, T.referralReward(), open("Открыть", "home"));
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, "не удалось отправить уведомление об оплате");
    }
  }
}
