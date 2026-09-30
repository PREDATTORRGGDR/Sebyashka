import type { Api } from "grammy";
import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import type { Logger } from "../logger.js";
import { esc } from "../texts.js";

export const ALERT_TYPES = {
  new_user: "👤 Новые пользователи",
  invoice: "🧾 Созданные счета",
  payment: "💰 Оплаты",
  pack_created: "🎨 Создание паков",
  pack_ready: "✅ Готовые паки",
  pack_failed: "⚠️ Проваленные паки",
  system: "🚨 Системные сбои",
} as const;

export type AlertType = keyof typeof ALERT_TYPES;

const MAX_MESSAGE = 3800;

/**
 * Алерты админам. События копятся 3 секунды и уходят одним сообщением на каждого получателя —
 * так бот не упрётся в лимиты Telegram даже при наплыве пользователей.
 */
export class AdminNotifier {
  private buffer: { type: AlertType; text: string }[] = [];
  private timer: NodeJS.Timeout | null = null;
  private muted = new Map<number, Set<string>>();
  private mutedLoadedAt = 0;

  constructor(
    private readonly api: Api,
    private readonly sql: Sql,
    private readonly cfg: Config,
    private readonly log: Logger,
    private readonly flushMs = 3000,
  ) {}

  /** Получатели: все админы (в личку) + общий чат, если задан. */
  private recipients(): number[] {
    const ids = [...this.cfg.ADMIN_IDS];
    if (this.cfg.ADMIN_CHAT_ID) ids.push(this.cfg.ADMIN_CHAT_ID);
    return ids;
  }

  notify(type: AlertType, text: string): void {
    if (!this.cfg.ADMIN_ALERTS.has(type) || !this.recipients().length) return;
    this.buffer.push({ type, text });
    if (this.buffer.length > 500) this.buffer.splice(0, this.buffer.length - 500); // защита памяти
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.flushMs);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const items = this.buffer.splice(0);
    if (!items.length) return;
    await this.loadMuted();
    for (const chatId of this.recipients()) {
      const muted = this.muted.get(chatId) ?? new Set();
      const lines = items.filter((i) => i.type === "system" || !muted.has(i.type)).map((i) => i.text);
      for (const chunk of chunks(lines)) {
        await this.api
          .sendMessage(chatId, chunk, { parse_mode: "HTML", link_preview_options: { is_disabled: true } })
          .catch((e) => this.log.warn({ err: (e as Error).message, chatId }, "алерт админу не доставлен"));
      }
    }
  }

  private async loadMuted(): Promise<void> {
    if (Date.now() - this.mutedLoadedAt < 30_000) return;
    try {
      const rows = await this.sql<{ admin_id: number; muted: string[] }[]>`SELECT admin_id, muted FROM admin_prefs`;
      this.muted = new Map(rows.map((r) => [r.admin_id, new Set(r.muted)]));
      this.mutedLoadedAt = Date.now();
    } catch {
      /* таблица может быть недоступна — шлём всё */
    }
  }

  invalidate(): void {
    this.mutedLoadedAt = 0;
  }
}

function chunks(lines: string[]): string[] {
  const out: string[] = [];
  let cur = "";
  for (const l of lines) {
    if (cur && cur.length + l.length + 2 > MAX_MESSAGE) {
      out.push(cur);
      cur = "";
    }
    cur += (cur ? "\n\n" : "") + l.slice(0, MAX_MESSAGE);
  }
  if (cur) out.push(cur);
  return out;
}

/** Ссылка на пользователя для алерта. */
export function who(u: { id: number; username?: string | null; first_name?: string | null }): string {
  const name = esc((u.first_name ?? "").slice(0, 40) || "без имени");
  return `<a href="tg://user?id=${u.id}">${name}</a>${u.username ? ` @${esc(u.username)}` : ""} <code>${u.id}</code>`;
}

export async function getMuted(sql: Sql, adminId: number): Promise<Set<string>> {
  const r = await sql<{ muted: string[] }[]>`SELECT muted FROM admin_prefs WHERE admin_id = ${adminId}`;
  return new Set(r[0]?.muted ?? []);
}

export async function toggleMuted(sql: Sql, adminId: number, type: AlertType): Promise<Set<string>> {
  const cur = await getMuted(sql, adminId);
  if (cur.has(type)) cur.delete(type);
  else cur.add(type);
  await sql`
    INSERT INTO admin_prefs (admin_id, muted) VALUES (${adminId}, ${[...cur]})
    ON CONFLICT (admin_id) DO UPDATE SET muted = EXCLUDED.muted, updated_at = now()`;
  return cur;
}
