import type { Config } from "./config.js";
import type { Sql } from "./db/client.js";
import type { Logger } from "./logger.js";
import type { Storage } from "./storage.js";
import type { TelegramGateway } from "./telegram/gateway.js";
import { appKeyboard } from "./telegram/bot.js";
import { T } from "./texts.js";
import { getProduct } from "./domain/catalog.js";

/**
 * Регулярная уборка:
 *  - селфи старше SELFIE_TTL_HOURS удаляются (приватность и место на диске);
 *  - файлы стикеров готовых паков старше 30 дней удаляются (сам набор живёт в Telegram);
 *  - «осиротевшие» файлы селфи на диске без ссылки в БД удаляются.
 */
export async function cleanup(sql: Sql, storage: Storage, cfg: Config, log: Logger): Promise<void> {
  const stale = await sql<{ id: number }[]>`
    UPDATE users SET selfie_path = NULL, selfie_uploaded_at = NULL
    WHERE selfie_path IS NOT NULL AND selfie_uploaded_at < now() - make_interval(hours => ${cfg.SELFIE_TTL_HOURS})
    RETURNING id`;
  for (const u of stale) await storage.remove(`selfies/${u.id}`).catch(() => {});

  const oldPacks = await sql<{ id: string }[]>`
    SELECT id FROM packs WHERE status IN ('ready','failed') AND finished_at < now() - interval '30 days'
      AND EXISTS (SELECT 1 FROM stickers s WHERE s.pack_id = packs.id AND s.file_path IS NOT NULL)
    LIMIT 500`;
  for (const p of oldPacks) {
    await storage.remove(`packs/${p.id}`).catch(() => {});
    await sql`UPDATE stickers SET file_path = NULL WHERE pack_id = ${p.id}`;
  }

  // Селфи-папки пользователей, у которых в БД селфи нет.
  const dirs = await storage.list("selfies");
  if (dirs.length) {
    const ids = dirs.map(Number).filter((n) => Number.isSafeInteger(n));
    const withSelfie = new Set(
      (await sql<{ id: number }[]>`SELECT id FROM users WHERE id = ANY(${ids}) AND selfie_path IS NOT NULL`).map((r) => r.id),
    );
    for (const id of ids) if (!withSelfie.has(id)) await storage.remove(`selfies/${id}`).catch(() => {});
  }
  // Файлы селфи внутри папок паков, которые уже завершены.
  const finished = await sql<{ id: string }[]>`
    SELECT id FROM packs WHERE status IN ('ready','failed') AND finished_at > now() - interval '2 days'`;
  for (const p of finished) await storage.remove(`packs/${p.id}/selfie.jpg`).catch(() => {});

  if (stale.length || oldPacks.length) log.info({ selfies: stale.length, packs: oldPacks.length }, "уборка завершена");
}

/**
 * Одно сообщение через час после бесплатной пробы тем, кто ещё ничего не купил и не делал платных паков.
 * Окно 1-24 часа: старые пробы не трогаем. Пользователь «забирается» записью события до отправки - повторов не будет.
 */
export async function sendTrialFollowups(sql: Sql, tg: TelegramGateway, cfg: Config, log: Logger): Promise<void> {
  const claimed = await sql<{ user_id: number }[]>`
    INSERT INTO events (user_id, name)
    SELECT DISTINCT u.id, 'trial_followup'
    FROM packs p JOIN users u ON u.id = p.user_id
    WHERE p.is_free AND p.status = 'ready'
      AND p.finished_at < now() - interval '1 hour' AND p.finished_at > now() - interval '24 hours'
      AND u.total_paid_stars = 0 AND u.total_paid_usd = 0 AND u.credits = 0
      AND u.has_started_bot AND NOT u.bot_blocked AND NOT u.is_banned
      AND NOT EXISTS (SELECT 1 FROM packs q WHERE q.user_id = u.id AND NOT q.is_free)
      AND NOT EXISTS (SELECT 1 FROM events e WHERE e.user_id = u.id AND e.name = 'trial_followup')
    RETURNING user_id`;
  const more = cfg.STICKERS_PER_PACK - cfg.FREE_PACK_SIZE;
  for (const { user_id } of claimed) {
    await tg.sendMessage(user_id, T.trialFollowup(more, cfg.STICKERS_PER_PACK, getProduct("pack_1")?.stars ?? 250), appKeyboard(cfg, "✨ Собрать весь пак", "shop"));
  }
  if (claimed.length) log.info({ n: claimed.length }, "напоминания после пробы отправлены");
}
