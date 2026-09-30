import { randomBytes } from "node:crypto";
import type { Db, Sql, Tx } from "../db/client.js";
import { AppError, isUniqueViolation } from "../errors.js";
import { INVITES_PER_REWARD } from "./catalog.js";

export interface UserRow {
  id: number;
  username: string | null;
  first_name: string;
  language_code: string | null;
  credits: number;
  free_pack_used: boolean;
  pro_until: Date | null;
  referral_code: string;
  referred_by: number | null;
  referral_rewarded: boolean;
  has_started_bot: boolean;
  bot_blocked: boolean;
  is_banned: boolean;
  selfie_path: string | null;
  selfie_uploaded_at: Date | null;
  total_paid_stars: number;
  total_paid_usd: string;
  created_at: Date;
}

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  language_code?: string;
}

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function randomCode(len = 8): string {
  const bytes = randomBytes(len);
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i]! % ALPHABET.length];
  return s;
}

export function isPro(u: Pick<UserRow, "pro_until">, now = new Date()): boolean {
  return !!u.pro_until && u.pro_until.getTime() > now.getTime();
}

/** Создаёт или обновляет пользователя. Возвращает строку и флаг «новый». */
export async function upsertUser(sql: Sql, tg: TgUser, opts: { startedBot?: boolean } = {}): Promise<{ user: UserRow; isNew: boolean }> {
  const firstName = (tg.first_name ?? "").slice(0, 64);
  const username = tg.username?.slice(0, 32) ?? null;
  const lang = tg.language_code?.slice(0, 8) ?? null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const rows = await sql<(UserRow & { inserted: boolean })[]>`
        INSERT INTO users (id, username, first_name, language_code, referral_code, has_started_bot)
        VALUES (${tg.id}, ${username}, ${firstName}, ${lang}, ${randomCode()}, ${!!opts.startedBot})
        ON CONFLICT (id) DO UPDATE SET
          username = EXCLUDED.username,
          first_name = CASE WHEN EXCLUDED.first_name <> '' THEN EXCLUDED.first_name ELSE users.first_name END,
          language_code = COALESCE(EXCLUDED.language_code, users.language_code),
          has_started_bot = users.has_started_bot OR EXCLUDED.has_started_bot,
          bot_blocked = CASE WHEN EXCLUDED.has_started_bot THEN FALSE ELSE users.bot_blocked END,
          last_seen_at = now(),
          updated_at = now()
        RETURNING *, (xmax = 0) AS inserted`;
      const { inserted, ...user } = rows[0]!;
      return { user, isNew: inserted };
    } catch (e) {
      // Коллизия referral_code - крайне редка, просто пробуем другой код.
      if (isUniqueViolation(e) && String((e as Error).message).includes("referral_code")) continue;
      throw e;
    }
  }
  throw new Error("не удалось сгенерировать referral_code");
}

export async function getUser(db: Db, id: number): Promise<UserRow | null> {
  const rows = await db<UserRow[]>`SELECT * FROM users WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function lockUser(tx: Tx, id: number): Promise<UserRow> {
  const rows = await tx<UserRow[]>`SELECT * FROM users WHERE id = ${id} FOR UPDATE`;
  if (!rows[0]) throw new AppError("NOT_FOUND", "Пользователь не найден");
  return rows[0];
}

/**
 * Привязка реферера. Защита от накруток:
 *  - только если реферер ещё не задан;
 *  - пользователь зарегистрировался не раньше чем сутки назад и ничего не покупал;
 *  - реферер зарегистрирован раньше (исключает циклы A→B→A и дедлоки при начислении).
 * Каждый INVITES_PER_REWARD-й приглашённый приносит рефереру +1 пак (rewarded = true).
 */
export async function attachReferrer(sql: Sql, userId: number, refCode: string): Promise<{ referrerId: number; rewarded: boolean } | null> {
  if (!/^[a-z0-9]{4,16}$/.test(refCode)) return null;
  const rows = await sql<{ id: number }[]>`
    UPDATE users u SET referred_by = r.id, updated_at = now()
    FROM users r
    WHERE u.id = ${userId}
      AND r.referral_code = ${refCode}
      AND r.id <> u.id
      AND r.created_at < u.created_at
      AND u.referred_by IS NULL
      AND u.created_at > now() - interval '1 day'
      AND u.total_paid_stars = 0 AND u.total_paid_usd = 0
    RETURNING r.id`;
  const referrerId = rows[0]?.id;
  if (!referrerId) return null;
  // +1 пак за каждых INVITES_PER_REWARD приглашённых. Идемпотентно: ref = "<реферер>:<номер тройки>".
  // ponytail: засчитывается любой новый аккаунт - от фейков защищает только «сутки с регистрации»; нужны строже - считать после первого пака друга.
  const rewarded = await sql.begin(async (tx) => {
    await lockUser(tx, referrerId);
    const n = (await tx<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE referred_by = ${referrerId}`)[0]!.n;
    if (n % INVITES_PER_REWARD !== 0) return false;
    return (await changeCredits(tx, referrerId, 1, "invite", `${referrerId}:${n / INVITES_PER_REWARD}`)).applied;
  });
  return { referrerId, rewarded };
}

export interface CreditChange {
  applied: boolean;
  balance: number;
}

/**
 * Единственный способ изменить баланс. Вызывать ТОЛЬКО внутри транзакции после lockUser().
 * Идемпотентно по (reason, ref): повторный вызов с тем же ref ничего не меняет.
 */
export async function changeCredits(tx: Tx, userId: number, delta: number, reason: string, ref: string | null): Promise<CreditChange> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error(`некорректная дельта кредитов: ${delta}`);
  if (ref) {
    const dup = await tx`SELECT 1 FROM ledger WHERE reason = ${reason} AND ref = ${ref}`;
    if (dup.length) {
      const u = await tx<{ credits: number }[]>`SELECT credits FROM users WHERE id = ${userId}`;
      return { applied: false, balance: u[0]?.credits ?? 0 };
    }
  }
  const cur = await tx<{ credits: number }[]>`SELECT credits FROM users WHERE id = ${userId}`;
  if (!cur[0]) throw new AppError("NOT_FOUND", "Пользователь не найден");
  if (cur[0].credits + delta < 0) throw new AppError("NOT_ENOUGH_CREDITS", "Недостаточно паков на балансе");
  const upd = await tx<{ credits: number }[]>`
    UPDATE users SET credits = credits + ${delta}, updated_at = now() WHERE id = ${userId} RETURNING credits`;
  const balance = upd[0]!.credits;
  await tx`INSERT INTO ledger (user_id, delta, balance, reason, ref) VALUES (${userId}, ${delta}, ${balance}, ${reason}, ${ref})`;
  return { applied: true, balance };
}

export async function track(db: Db, userId: number | null, name: string, props: Record<string, unknown> = {}): Promise<void> {
  try {
    await db`INSERT INTO events (user_id, name, props) VALUES (${userId}, ${name}, ${db.json(props as never)})`;
  } catch {
    // Аналитика не должна ломать основной сценарий.
  }
}
