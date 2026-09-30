import type { Config } from "./config.js";
import type { Sql } from "./db/client.js";
import type { Logger } from "./logger.js";
import type { Storage } from "./storage.js";

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
