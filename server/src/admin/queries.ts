import type { Sql } from "../db/client.js";
import { STAR_USD } from "../domain/catalog.js";
import { isPro, type UserRow } from "../domain/users.js";

export interface AdminStats {
  users: number;
  users24h: number;
  payers: number;
  packsReady: number;
  packsFailed: number;
  inQueue: number;
  ordersPaid: number;
  starsTotal: number;
  stars24h: number;
  usdTotal: number;
  usd24h: number;
  /** Грубая выручка в $: Stars по курсу вывода + крипта. */
  revenueUsd: number;
  revenue24hUsd: number;
}

export async function getStats(sql: Sql): Promise<AdminStats> {
  const [r] = await sql<Record<string, string | number>[]>`
    SELECT
      (SELECT count(*) FROM users)::int AS users,
      (SELECT count(*) FROM users WHERE created_at > now() - interval '1 day')::int AS users_24h,
      (SELECT count(DISTINCT user_id) FROM orders WHERE status = 'paid')::int AS payers,
      (SELECT count(*) FROM packs WHERE status = 'ready')::int AS packs_ready,
      (SELECT count(*) FROM packs WHERE status = 'failed')::int AS packs_failed,
      (SELECT count(*) FROM packs WHERE status IN ('queued','processing'))::int AS in_queue,
      (SELECT count(*) FROM orders WHERE status = 'paid')::int AS orders_paid,
      (SELECT COALESCE(sum(amount_stars),0) FROM orders WHERE status = 'paid' AND provider = 'stars')::int AS stars_total,
      (SELECT COALESCE(sum(amount_stars),0) FROM orders WHERE status = 'paid' AND provider = 'stars' AND paid_at > now() - interval '1 day')::int AS stars_24h,
      (SELECT COALESCE(sum(amount_usd),0) FROM orders WHERE status = 'paid' AND provider = 'cryptobot')::float AS usd_total,
      (SELECT COALESCE(sum(amount_usd),0) FROM orders WHERE status = 'paid' AND provider = 'cryptobot' AND paid_at > now() - interval '1 day')::float AS usd_24h`;
  const s = r!;
  const n = (k: string) => Number(s[k] ?? 0);
  return {
    users: n("users"),
    users24h: n("users_24h"),
    payers: n("payers"),
    packsReady: n("packs_ready"),
    packsFailed: n("packs_failed"),
    inQueue: n("in_queue"),
    ordersPaid: n("orders_paid"),
    starsTotal: n("stars_total"),
    stars24h: n("stars_24h"),
    usdTotal: n("usd_total"),
    usd24h: n("usd_24h"),
    revenueUsd: round2(n("stars_total") * STAR_USD + n("usd_total")),
    revenue24hUsd: round2(n("stars_24h") * STAR_USD + n("usd_24h")),
  };
}

export const FUNNEL_STEPS = [
  ["bot_start", "Старт бота"],
  ["app_open", "Открыли приложение"],
  ["selfie_uploaded", "Загрузили фото"],
  ["pack_created", "Запустили пак"],
  ["pack_ready", "Получили пак"],
  ["paywall_view", "Открыли магазин"],
  ["invoice_created", "Создали счёт"],
  ["payment", "Оплатили"],
  ["share", "Поделились"],
] as const;

export async function getFunnel(sql: Sql, days = 7): Promise<{ key: string; label: string; users: number }[]> {
  const rows = await sql<{ name: string; n: number }[]>`
    SELECT name, count(DISTINCT user_id)::int AS n FROM events
    WHERE created_at > now() - make_interval(days => ${days}) AND name = ANY(${FUNNEL_STEPS.map((s) => s[0])})
    GROUP BY name`;
  const m = new Map(rows.map((r) => [r.name, r.n]));
  return FUNNEL_STEPS.map(([key, label]) => ({ key, label, users: m.get(key) ?? 0 }));
}

export async function recentPayments(sql: Sql, limit = 20) {
  return sql<
    { id: string; user_id: number; username: string | null; first_name: string; product_id: string; provider: string; amount_stars: number | null; amount_usd: string | null; paid_at: Date; is_recurring: boolean; status: string }[]
  >`
    SELECT o.id, o.user_id, u.username, u.first_name, o.product_id, o.provider, o.amount_stars, o.amount_usd, o.paid_at, o.is_recurring, o.status
    FROM orders o JOIN users u ON u.id = o.user_id
    WHERE o.status IN ('paid','refunded') ORDER BY o.paid_at DESC NULLS LAST LIMIT ${limit}`;
}

/** Поиск по id, @username или части имени. */
export async function findUsers(sql: Sql, q: string, limit = 10): Promise<UserRow[]> {
  const query = q.trim().replace(/^@/, "");
  if (!query) return [];
  if (/^\d{1,16}$/.test(query)) return sql<UserRow[]>`SELECT * FROM users WHERE id = ${Number(query)}`;
  const like = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
  return sql<UserRow[]>`
    SELECT * FROM users WHERE username ILIKE ${like} OR first_name ILIKE ${like}
    ORDER BY last_seen_at DESC LIMIT ${limit}`;
}

export async function userCard(sql: Sql, u: UserRow) {
  const [agg] = await sql<{ packs: number; ready: number; orders: number }[]>`
    SELECT (SELECT count(*) FROM packs WHERE user_id = ${u.id})::int AS packs,
           (SELECT count(*) FROM packs WHERE user_id = ${u.id} AND status = 'ready')::int AS ready,
           (SELECT count(*) FROM orders WHERE user_id = ${u.id} AND status = 'paid')::int AS orders`;
  const charges = await sql<{ provider_charge_id: string; product_id: string; paid_at: Date }[]>`
    SELECT provider_charge_id, product_id, paid_at FROM orders
    WHERE user_id = ${u.id} AND status = 'paid' AND provider_charge_id IS NOT NULL ORDER BY paid_at DESC LIMIT 5`;
  return {
    id: u.id,
    username: u.username,
    firstName: u.first_name,
    credits: u.credits,
    isPro: isPro(u),
    proUntil: u.pro_until,
    freePackUsed: u.free_pack_used,
    isBanned: u.is_banned,
    referredBy: u.referred_by,
    paidStars: u.total_paid_stars,
    paidUsd: Number(u.total_paid_usd),
    createdAt: u.created_at,
    packs: agg!.packs,
    packsReady: agg!.ready,
    orders: agg!.orders,
    lastCharges: charges.map((c) => ({ chargeId: c.provider_charge_id, productId: c.product_id, paidAt: c.paid_at })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
