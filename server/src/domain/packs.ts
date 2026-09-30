import { randomUUID } from "node:crypto";
import type { Config } from "../config.js";
import type { Db, Sql } from "../db/client.js";
import { AppError } from "../errors.js";
import { paths, type Storage } from "../storage.js";
import { emotionsFor, getStyle, sanitizeWish, styleCost } from "./catalog.js";
import { changeCredits, isPro, lockUser, track, type UserRow } from "./users.js";

export type PackStatus = "queued" | "processing" | "needs_start" | "ready" | "failed";

export interface PackRow {
  id: string;
  user_id: number;
  style_id: string;
  is_free: boolean;
  credits_spent: number;
  priority: number;
  status: PackStatus;
  total: number;
  done: number;
  selfie_path: string;
  sticker_set_name: string;
  sticker_set_title: string;
  error: string | null;
  custom_prompt: string | null;
  attempts: number;
  locked_at: Date | null;
  created_at: Date;
  finished_at: Date | null;
}

export interface StickerRow {
  id: number;
  pack_id: string;
  idx: number;
  emotion_id: string;
  emoji: string;
  status: "pending" | "done" | "failed";
  file_path: string | null;
  error: string | null;
  attempts: number;
  in_set: boolean;
}

/**
 * Имя набора стикеров: латиница/цифры/_, начинается с буквы, без «__», ≤ 64, оканчивается на _by_<bot>.
 */
export function stickerSetName(packId: string, botUsername: string): string {
  const id = packId.replace(/-/g, "").slice(0, 12).toLowerCase();
  const name = `s${id}_by_${botUsername}`;
  if (name.length > 64 || !/^[a-zA-Z](?!.*__)[a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`некорректное имя набора стикеров: ${name}`);
  }
  return name;
}

export function stickerSetTitle(firstName: string, styleTitle: string, botUsername: string): string {
  // Убираем то, что Telegram может не принять, и оставляем @бота в конце — это наша бесплатная реклама.
  const name = firstName.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24) || "Себяшка";
  const suffix = ` · @${botUsername}`;
  const title = `${name} · ${styleTitle}`;
  return (title.slice(0, 64 - suffix.length) + suffix).slice(0, 64);
}

export interface CreatePackInput {
  user: UserRow;
  styleId: string;
  free: boolean;
  wish?: string | null;
  /** Админ генерирует без списания (тесты, демо). */
  isAdmin?: boolean;
}

export async function activePackOf(db: Db, userId: number): Promise<PackRow | null> {
  const rows = await db<PackRow[]>`
    SELECT * FROM packs WHERE user_id = ${userId} AND status IN ('queued','processing','needs_start')
    ORDER BY created_at DESC LIMIT 1`;
  return rows[0] ?? null;
}

export async function createPack(sql: Sql, storage: Storage, cfg: Config, botUsername: string, input: CreatePackInput): Promise<PackRow> {
  const style = getStyle(input.styleId);
  if (!style) throw new AppError("UNKNOWN_STYLE", "Такого стиля нет");
  const { user } = input;
  if (user.is_banned) throw new AppError("BANNED", "Доступ ограничен. Напиши в поддержку.");
  if (!user.selfie_path || !user.selfie_uploaded_at) throw new AppError("NO_SELFIE", "Сначала загрузи фото");
  const ageH = (Date.now() - user.selfie_uploaded_at.getTime()) / 3_600_000;
  if (ageH > cfg.SELFIE_TTL_HOURS || !(await storage.exists(user.selfie_path))) {
    throw new AppError("SELFIE_EXPIRED", "Фото удалено ради приватности — загрузи новое");
  }
  const w = sanitizeWish(input.wish);
  if (!w.ok) throw new AppError("BAD_REQUEST", w.reason);
  const admin = !!input.isAdmin;
  if (input.free && style.premium && !admin) throw new AppError("FREE_STYLE_ONLY", "Бесплатный пак — только в обычных стилях");

  const packId = randomUUID();
  const selfieCopy = paths.packSelfie(packId);
  // Копия селфи: пользователь может загрузить новое или оно удалится по TTL, пока пак в очереди.
  await storage.copy(user.selfie_path, selfieCopy);

  try {
    return await sql.begin(async (tx) => {
      const u = await lockUser(tx, user.id);
      const active = await activePackOf(tx, u.id);
      if (active) throw new AppError("PACK_IN_PROGRESS", "Дождись, пока соберётся текущий пак");

      const pro = isPro(u);
      let cost = 0;
      let size: number;
      if (admin) {
        size = cfg.STICKERS_PER_PACK; // админ: полный пак без списания
      } else if (input.free) {
        if (u.free_pack_used) throw new AppError("FREE_PACK_USED", "Бесплатный пак уже использован");
        await tx`UPDATE users SET free_pack_used = TRUE WHERE id = ${u.id}`;
        size = cfg.FREE_PACK_SIZE;
      } else {
        cost = styleCost(style, pro);
        if (u.credits < cost) throw new AppError("NOT_ENOUGH_CREDITS", `Нужно паков: ${cost}, на балансе: ${u.credits}`);
        await changeCredits(tx, u.id, -cost, "pack", packId);
        size = cfg.STICKERS_PER_PACK;
      }
      const emotions = emotionsFor(size);
      const priority = admin || pro ? 10 : input.free ? 0 : 5;
      const isFree = input.free && !admin;
      const pack = (
        await tx<PackRow[]>`
          INSERT INTO packs (id, user_id, style_id, is_free, credits_spent, priority, total, selfie_path, sticker_set_name, sticker_set_title, custom_prompt)
          VALUES (${packId}, ${u.id}, ${style.id}, ${isFree}, ${cost}, ${priority}, ${emotions.length}, ${selfieCopy},
                  ${stickerSetName(packId, botUsername)}, ${stickerSetTitle(u.first_name, style.title, botUsername)}, ${w.wish})
          RETURNING *`
      )[0]!;
      const rows = emotions.map((e, idx) => ({ pack_id: packId, idx, emotion_id: e.id, emoji: e.emoji }));
      await tx`INSERT INTO stickers ${tx(rows, "pack_id", "idx", "emotion_id", "emoji")}`;
      await track(tx, u.id, "pack_created", { pack: packId, style: style.id, free: isFree, cost, admin, wish: !!w.wish });
      return pack;
    });
  } catch (e) {
    await storage.remove(paths.packDir(packId)).catch(() => {});
    throw e;
  }
}

/**
 * Провал пака: возвращаем кредиты (или бесплатную попытку). Идемпотентно — повторный вызов не вернёт дважды.
 */
export async function failPack(sql: Sql, packId: string, error: string): Promise<{ refunded: number; pack: PackRow } | null> {
  return sql.begin(async (tx) => {
    const pack = (await tx<PackRow[]>`SELECT * FROM packs WHERE id = ${packId} FOR UPDATE`)[0];
    if (!pack || pack.status === "ready") return null;
    await lockUser(tx, pack.user_id);
    let refunded = 0;
    if (pack.credits_spent > 0) {
      const r = await changeCredits(tx, pack.user_id, pack.credits_spent, "refund_pack", pack.id);
      if (r.applied) refunded = pack.credits_spent;
    }
    if (pack.is_free && pack.status !== "failed") {
      await tx`UPDATE users SET free_pack_used = FALSE WHERE id = ${pack.user_id}`;
    }
    const updated = (
      await tx<PackRow[]>`
        UPDATE packs SET status = 'failed', error = ${error.slice(0, 500)}, locked_at = NULL, finished_at = now(), updated_at = now()
        WHERE id = ${pack.id} RETURNING *`
    )[0]!;
    await track(tx, pack.user_id, "pack_failed", { pack: pack.id, error: error.slice(0, 200), refunded });
    return { refunded, pack: updated };
  });
}

export async function getPack(db: Db, id: string): Promise<PackRow | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const rows = await db<PackRow[]>`SELECT * FROM packs WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function listPacks(db: Db, userId: number, limit = 30): Promise<PackRow[]> {
  return db<PackRow[]>`SELECT * FROM packs WHERE user_id = ${userId} ORDER BY created_at DESC LIMIT ${limit}`;
}

export async function packStickers(db: Db, packId: string): Promise<StickerRow[]> {
  return db<StickerRow[]>`SELECT * FROM stickers WHERE pack_id = ${packId} ORDER BY idx`;
}

/**
 * Взять задачу из очереди. Зависшие задачи (воркер упал) подхватываются через 15 минут.
 */
export async function claimPack(sql: Sql): Promise<PackRow | null> {
  const rows = await sql<PackRow[]>`
    UPDATE packs SET status = 'processing', locked_at = now(), attempts = attempts + 1, updated_at = now()
    WHERE id = (
      SELECT id FROM packs
      WHERE status = 'queued' OR (status = 'processing' AND locked_at < now() - interval '15 minutes')
      ORDER BY priority DESC, created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
  return rows[0] ?? null;
}

export async function heartbeat(sql: Sql, packId: string): Promise<void> {
  await sql`UPDATE packs SET locked_at = now(), updated_at = now() WHERE id = ${packId} AND status = 'processing'`;
}

export async function requeue(sql: Sql, packId: string, error: string): Promise<void> {
  await sql`UPDATE packs SET status = 'queued', locked_at = NULL, error = ${error.slice(0, 500)}, updated_at = now() WHERE id = ${packId}`;
}

/** После /start в боте — повторить загрузку паков, которые ждали пользователя. */
export async function requeueNeedsStart(sql: Sql, userId: number): Promise<number> {
  const rows = await sql`
    UPDATE packs SET status = 'queued', locked_at = NULL, attempts = 0, updated_at = now()
    WHERE user_id = ${userId} AND status = 'needs_start' RETURNING id`;
  return rows.length;
}

export async function queueStats(sql: Sql): Promise<{ queued: number; processing: number; position?: number }> {
  const r = (
    await sql<{ queued: number; processing: number }[]>`
      SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
             count(*) FILTER (WHERE status = 'processing')::int AS processing
      FROM packs WHERE status IN ('queued','processing')`
  )[0]!;
  return r;
}

export async function queuePosition(sql: Sql, pack: PackRow): Promise<number> {
  if (pack.status !== "queued") return 0;
  const r = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM packs
    WHERE status = 'queued' AND (priority > ${pack.priority} OR (priority = ${pack.priority} AND created_at < ${pack.created_at}))`;
  return (r[0]?.n ?? 0) + 1;
}
