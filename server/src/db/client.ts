import postgres from "postgres";
import { MIGRATIONS } from "./migrations.js";

export type Sql = postgres.Sql<{}>;
export type Tx = postgres.TransactionSql<{}>;
/** Функции репозитория принимают и корневой пул, и транзакцию. */
export type Db = Sql | Tx;

export function createDb(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 15,
    onnotice: () => {},
    types: {
      // BIGINT -> number. Telegram id < 2^53, поэтому безопасно.
      bigint: {
        to: 20,
        from: [20],
        serialize: (x: number | bigint | string) => String(x),
        parse: (x: string) => {
          const n = Number(x);
          if (!Number.isSafeInteger(n)) throw new Error(`BIGINT вне безопасного диапазона: ${x}`);
          return n;
        },
      },
    },
  });
}

/** Применяет миграции под advisory-lock, чтобы параллельные инстансы не столкнулись. */
export async function migrate(sql: Sql, log: (m: string) => void = () => {}): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(727274)`;
    await tx`CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`;
    const applied = new Set((await tx<{ id: number }[]>`SELECT id FROM schema_migrations`).map((r) => r.id));
    for (const m of MIGRATIONS.sort((a, b) => a.id - b.id)) {
      if (applied.has(m.id)) continue;
      log(`миграция ${m.id}_${m.name}`);
      await tx.unsafe(m.sql);
      await tx`INSERT INTO schema_migrations (id, name) VALUES (${m.id}, ${m.name})`;
    }
  });
}
