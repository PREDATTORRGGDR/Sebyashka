import type { Db, Sql, Tx } from "../db/client.js";
import { AppError } from "../errors.js";
import { getProduct, REFERRAL_REWARD_CREDITS, type Product } from "./catalog.js";
import { changeCredits, lockUser, randomCode, track, type UserRow } from "./users.js";

export type Provider = "stars" | "cryptobot" | "admin";

export interface OrderRow {
  id: string;
  user_id: number;
  product_id: string;
  provider: Provider;
  status: "pending" | "paid" | "expired" | "refunded" | "failed";
  amount_stars: number | null;
  amount_usd: string | null;
  invoice_url: string | null;
  provider_invoice_id: string | null;
  provider_charge_id: string | null;
  is_recurring: boolean;
  parent_order_id: string | null;
  created_at: Date;
  paid_at: Date | null;
}

export async function createOrder(db: Db, userId: number, product: Product, provider: Provider): Promise<OrderRow> {
  const rows = await db<OrderRow[]>`
    INSERT INTO orders (user_id, product_id, provider, amount_stars, amount_usd)
    VALUES (${userId}, ${product.id}, ${provider},
            ${provider === "stars" ? product.stars : null},
            ${provider === "cryptobot" ? product.usd : null})
    RETURNING *`;
  return rows[0]!;
}

export async function setOrderInvoice(db: Db, orderId: string, invoiceUrl: string, providerInvoiceId: string | null): Promise<void> {
  await db`UPDATE orders SET invoice_url = ${invoiceUrl}, provider_invoice_id = ${providerInvoiceId} WHERE id = ${orderId}`;
}

export async function getOrder(db: Db, id: string): Promise<OrderRow | null> {
  if (!isUuid(id)) return null;
  const rows = await db<OrderRow[]>`SELECT * FROM orders WHERE id = ${id}`;
  return rows[0] ?? null;
}

export function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

export interface PaymentEvent {
  orderId: string;
  provider: Exclude<Provider, "admin">;
  /** Уникальный id платежа у провайдера (telegram_payment_charge_id / invoice_id CryptoBot). */
  chargeId: string;
  userId: number;
  amountStars?: number;
  amountUsd?: string;
  paidAsset?: string;
  paidAmount?: string;
  /** Автопродление подписки Stars (не первый платёж). */
  isRecurring?: boolean;
  raw?: unknown;
}

export interface FulfillResult {
  status: "fulfilled" | "duplicate";
  order: OrderRow;
  product: Product;
  user: UserRow;
  giftCode?: string;
  referrerRewarded?: number;
  balance?: number;
}

/**
 * Зачисление оплаты. Идемпотентно: повторный вебхук/апдейт с тем же chargeId ничего не начислит.
 * Порядок блокировок: заказ → покупатель → реферер (реферер всегда старше, циклов нет).
 */
export async function fulfillPayment(sql: Sql, ev: PaymentEvent): Promise<FulfillResult> {
  return sql.begin(async (tx) => {
    const dup = await tx<OrderRow[]>`SELECT * FROM orders WHERE provider_charge_id = ${ev.chargeId}`;
    const base = (await tx<OrderRow[]>`SELECT * FROM orders WHERE id = ${ev.orderId} FOR UPDATE`)[0];
    if (!base) throw new AppError("NOT_FOUND", `заказ ${ev.orderId} не найден`);
    if (base.user_id !== ev.userId) throw new AppError("FORBIDDEN", "заказ принадлежит другому пользователю");
    const product = getProduct(base.product_id);
    if (!product) throw new AppError("UNKNOWN_PRODUCT", `неизвестный товар ${base.product_id}`);
    if (dup[0]) {
      const user = await lockUser(tx, ev.userId);
      return { status: "duplicate", order: dup[0], product, user };
    }

    let order: OrderRow;
    if (ev.isRecurring && base.status !== "pending") {
      // Продление подписки: новый заказ-потомок, чтобы у каждого платежа была своя строка.
      order = (
        await tx<OrderRow[]>`
          INSERT INTO orders (user_id, product_id, provider, status, amount_stars, amount_usd,
                              provider_charge_id, is_recurring, parent_order_id, raw, paid_at)
          VALUES (${base.user_id}, ${base.product_id}, ${ev.provider}, 'paid', ${ev.amountStars ?? null}, ${ev.amountUsd ?? null},
                  ${ev.chargeId}, TRUE, ${base.id}, ${tx.json((ev.raw ?? {}) as never)}, now())
          RETURNING *`
      )[0]!;
    } else if (base.status === "pending" || base.status === "expired") {
      // expired тоже принимаем: CryptoBot мог прислать оплату после нашего таймаута - деньги-то пришли.
      order = (
        await tx<OrderRow[]>`
          UPDATE orders SET status = 'paid', paid_at = now(), provider_charge_id = ${ev.chargeId},
                 paid_asset = ${ev.paidAsset ?? null}, paid_amount = ${ev.paidAmount ?? null},
                 amount_stars = COALESCE(${ev.amountStars ?? null}, amount_stars),
                 raw = ${tx.json((ev.raw ?? {}) as never)}
          WHERE id = ${base.id} RETURNING *`
      )[0]!;
    } else {
      // Заказ уже оплачен другим платежом (двойная оплата одного счёта) - фиксируем, чтобы разобраться вручную.
      throw new AppError("PAYMENT_ERROR", `заказ ${base.id} уже в статусе ${base.status}, платёж ${ev.chargeId} требует ручной проверки`);
    }

    const user = await lockUser(tx, ev.userId);
    await tx`
      UPDATE users SET total_paid_stars = total_paid_stars + ${ev.amountStars ?? 0},
                       total_paid_usd = total_paid_usd + ${ev.amountUsd ?? "0"}, updated_at = now()
      WHERE id = ${user.id}`;

    const result: FulfillResult = { status: "fulfilled", order, product, user };
    result.giftCode = await grantProduct(tx, user, product, order.id, result);

    if (user.referred_by && !user.referral_rewarded) {
      await tx`UPDATE users SET referral_rewarded = TRUE WHERE id = ${user.id}`;
      await lockUser(tx, user.referred_by);
      const r = await changeCredits(tx, user.referred_by, REFERRAL_REWARD_CREDITS, "referral", String(user.id));
      if (r.applied) result.referrerRewarded = user.referred_by;
    }
    await track(tx, user.id, "payment", { product: product.id, provider: ev.provider, stars: ev.amountStars, usd: ev.amountUsd, recurring: !!ev.isRecurring });
    return result;
  });
}

async function grantProduct(tx: Tx, user: UserRow, product: Product, orderId: string, result: FulfillResult): Promise<string | undefined> {
  switch (product.kind) {
    case "credits": {
      result.balance = (await changeCredits(tx, user.id, product.credits, "purchase", orderId)).balance;
      return undefined;
    }
    case "pro": {
      await tx`
        UPDATE users SET pro_until = GREATEST(COALESCE(pro_until, now()), now()) + make_interval(days => ${product.days ?? 30}),
                         updated_at = now()
        WHERE id = ${user.id}`;
      result.balance = (await changeCredits(tx, user.id, product.credits, "purchase", orderId)).balance;
      return undefined;
    }
    case "gift": {
      for (let i = 0; i < 5; i++) {
        const code = randomCode(10);
        const ins = await tx`
          INSERT INTO gifts (code, order_id, buyer_id, credits) VALUES (${code}, ${orderId}, ${user.id}, ${product.credits})
          ON CONFLICT (code) DO NOTHING RETURNING code`;
        if (ins.length) return code;
      }
      throw new Error("не удалось сгенерировать код подарка");
    }
  }
}

export async function redeemGift(sql: Sql, userId: number, code: string): Promise<{ credits: number; buyerId: number; balance: number }> {
  if (!/^[a-z0-9]{6,16}$/.test(code)) throw new AppError("GIFT_INVALID", "Подарок не найден");
  return sql.begin(async (tx) => {
    const g = (await tx<{ code: string; buyer_id: number; credits: number; redeemed_by: number | null; revoked: boolean }[]>`
      SELECT * FROM gifts WHERE code = ${code} FOR UPDATE`)[0];
    if (!g || g.revoked) throw new AppError("GIFT_INVALID", "Подарок не найден или отменён");
    if (g.redeemed_by === userId) throw new AppError("GIFT_USED", "Ты уже получил этот подарок");
    if (g.redeemed_by) throw new AppError("GIFT_USED", "Этот подарок уже кто-то забрал");
    if (g.buyer_id === userId) throw new AppError("GIFT_OWN", "Нельзя забрать свой же подарок - отправь ссылку другу");
    await lockUser(tx, userId);
    const r = await changeCredits(tx, userId, g.credits, "gift", code);
    await tx`UPDATE gifts SET redeemed_by = ${userId}, redeemed_at = now() WHERE code = ${code}`;
    await track(tx, userId, "gift_redeemed", { code });
    return { credits: g.credits, buyerId: g.buyer_id, balance: r.balance };
  });
}

/**
 * Возврат (по команде админа или по refunded_payment от Telegram).
 * Списываем столько кредитов, сколько осталось (не уходим в минус), pro укорачиваем, подарок отзываем.
 */
export async function refundOrderByCharge(sql: Sql, chargeId: string): Promise<{ order: OrderRow; creditsTaken: number } | null> {
  return sql.begin(async (tx) => {
    const order = (await tx<OrderRow[]>`SELECT * FROM orders WHERE provider_charge_id = ${chargeId} FOR UPDATE`)[0];
    if (!order) return null;
    if (order.status === "refunded") return { order, creditsTaken: 0 };
    const product = getProduct(order.product_id);
    const user = await lockUser(tx, order.user_id);
    let taken = 0;
    if (product && (product.kind === "credits" || product.kind === "pro")) {
      taken = Math.min(user.credits, product.credits);
      if (taken > 0) await changeCredits(tx, user.id, -taken, "payment_refund", order.id);
    }
    if (product?.kind === "pro") {
      await tx`UPDATE users SET pro_until = GREATEST(now(), pro_until - make_interval(days => ${product.days ?? 30})) WHERE id = ${user.id} AND pro_until IS NOT NULL`;
    }
    if (product?.kind === "gift") {
      await tx`UPDATE gifts SET revoked = TRUE WHERE order_id = ${order.id} AND redeemed_by IS NULL`;
    }
    const updated = (await tx<OrderRow[]>`UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = ${order.id} RETURNING *`)[0]!;
    await tx`UPDATE users SET total_paid_stars = GREATEST(0, total_paid_stars - ${order.amount_stars ?? 0}) WHERE id = ${user.id}`;
    await track(tx, user.id, "refund", { order: order.id, taken });
    return { order: updated, creditsTaken: taken };
  });
}

export async function expireStaleCryptoOrders(sql: Sql, olderThanMinutes = 90): Promise<number> {
  const rows = await sql`
    UPDATE orders SET status = 'expired'
    WHERE provider = 'cryptobot' AND status = 'pending' AND created_at < now() - make_interval(mins => ${olderThanMinutes})
    RETURNING id`;
  return rows.length;
}

export async function pendingCryptoOrders(sql: Sql, limit = 100): Promise<OrderRow[]> {
  return sql<OrderRow[]>`
    SELECT * FROM orders
    WHERE provider = 'cryptobot' AND status IN ('pending','expired') AND provider_invoice_id IS NOT NULL
      AND created_at > now() - interval '2 days'
    ORDER BY created_at DESC LIMIT ${limit}`;
}
