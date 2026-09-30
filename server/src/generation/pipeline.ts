import { createHash } from "node:crypto";
import { InlineKeyboard } from "grammy";
import type { Config } from "../config.js";
import type { Sql } from "../db/client.js";
import { buildPrompt, EMOTIONS, getStyle, NEGATIVE_PROMPT } from "../domain/catalog.js";
import { claimPack, failPack, heartbeat, packStickers, requeue, type PackRow, type StickerRow } from "../domain/packs.js";
import { track } from "../domain/users.js";
import type { Logger } from "../logger.js";
import { paths, type Storage } from "../storage.js";
import { classifyTelegramError, type TelegramGateway } from "../telegram/gateway.js";
import { esc, failureReasonForUser, T } from "../texts.js";
import type { AdminNotifier } from "../admin/notifier.js";
import { pixelate, toSticker } from "./postprocess.js";
import { ProviderConfigError, type ImageGenerator } from "./providers.js";

export interface PipelineDeps {
  sql: Sql;
  cfg: Config;
  storage: Storage;
  generator: ImageGenerator;
  bgRemover: ImageGenerator | null;
  tg: TelegramGateway;
  log: Logger;
  botUsername: string;
  /** Уведомление админам о системных проблемах (не чаще раза в 10 минут). */
  alert?: (msg: string) => void;
  notifier?: AdminNotifier;
}

const MAX_PACK_ATTEMPTS = 5;
const STICKER_TRIES = 3;

export type ProcessOutcome = "ready" | "failed" | "requeued" | "needs_start";

export function seedFor(packId: string, idx: number): number {
  return createHash("sha256").update(`${packId}:${idx}`).digest().readUInt32BE(0) % 2_147_483_647;
}

/** Параллельный map с ограничением конкурентности. */
async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function processPack(d: PipelineDeps, pack: PackRow, signal?: AbortSignal): Promise<ProcessOutcome> {
  const log = d.log.child({ pack: pack.id, user: pack.user_id });
  if (pack.attempts > MAX_PACK_ATTEMPTS) {
    return fail(d, pack, `превышено число попыток (${pack.attempts - 1}); последняя ошибка: ${pack.error ?? "-"}`);
  }
  const style = getStyle(pack.style_id);
  if (!style) return fail(d, pack, `стиль ${pack.style_id} удалён из каталога`);

  let selfie: Buffer;
  try {
    selfie = await d.storage.read(pack.selfie_path);
  } catch {
    return fail(d, pack, "фото удалено до начала генерации");
  }

  const stickers = await packStickers(d.sql, pack.id);
  const pending = stickers.filter((s) => s.status === "pending" || (s.status === "failed" && s.attempts < STICKER_TRIES));
  let configError: ProviderConfigError | null = null;
  const hb = setInterval(() => void heartbeat(d.sql, pack.id).catch(() => {}), 60_000);

  try {
    await mapLimit(pending, d.cfg.GEN_CONCURRENCY, async (s) => {
      if (configError || signal?.aborted) return;
      try {
        await generateOne(d, pack, s, selfie, style, signal);
      } catch (e) {
        if (e instanceof ProviderConfigError) {
          configError = e;
          return;
        }
        log.warn({ err: (e as Error).message, idx: s.idx }, "стикер не получился");
      }
    });
  } finally {
    clearInterval(hb);
  }

  if (configError) {
    // Ключ/модель/баланс провайдера - вина не пользователя. Ставим обратно в очередь и зовём админа.
    const msg = `провайдер ИИ: ${(configError as Error).message}`;
    log.error(msg);
    d.alert?.(`⚠️ Генерация остановлена: ${msg}`);
    await requeue(d.sql, pack.id, msg);
    return "requeued";
  }
  if (signal?.aborted) {
    await requeue(d.sql, pack.id, "воркер остановлен");
    return "requeued";
  }

  const after = await packStickers(d.sql, pack.id);
  const done = after.filter((s) => s.status === "done");
  const retryable = after.filter((s) => s.status === "failed" && s.attempts < STICKER_TRIES);
  const minOk = Math.ceil(pack.total * d.cfg.MIN_SUCCESS_RATIO);
  if (done.length < minOk) {
    if (retryable.length && pack.attempts < MAX_PACK_ATTEMPTS) {
      await requeue(d.sql, pack.id, `удачных ${done.length}/${pack.total}, повторим`);
      return "requeued";
    }
    return fail(d, pack, `мало удачных стикеров: ${done.length}/${pack.total}`);
  }

  return upload(d, pack, done);
}

async function generateOne(
  d: PipelineDeps,
  pack: PackRow,
  s: StickerRow,
  selfie: Buffer,
  style: NonNullable<ReturnType<typeof getStyle>>,
  signal?: AbortSignal,
): Promise<void> {
  const emotion = EMOTIONS.find((e) => e.id === s.emotion_id) ?? { id: s.emotion_id, emoji: s.emoji, title: "", prompt: s.emotion_id };
  let lastErr: unknown;
  for (let attempt = s.attempts; attempt < STICKER_TRIES; attempt++) {
    try {
      const raw = await d.generator.generate(
        {
          selfie,
          prompt: buildPrompt(style, emotion, pack.custom_prompt),
          negativePrompt: NEGATIVE_PROMPT,
          seed: seedFor(pack.id, s.idx) + attempt,
          emoji: emotion.emoji,
          label: emotion.title || emotion.id,
          tier: pack.is_free ? "free" : style.premium ? "premium" : "paid",
        },
        signal,
      );
      // Модель рисует «пиксель-арт» то с пикселями, то гладко (зависит от seed) - доводим сами.
      let img = style.pixelate ? await pixelate(raw, style.pixelate) : raw;
      let removeBg = d.cfg.BG_REMOVAL === "local";
      if (d.bgRemover?.removeBackground) {
        try {
          img = await d.bgRemover.removeBackground(raw, signal);
          removeBg = false;
        } catch (e) {
          if (e instanceof ProviderConfigError) throw e;
          removeBg = true; // нейросеть фона упала - вырежем локально
        }
      }
      const out = await toSticker(img, { removeBackground: removeBg });
      const rel = paths.sticker(pack.id, s.idx, out.format);
      await d.storage.write(rel, out.buffer);
      await d.sql`UPDATE stickers SET status = 'done', file_path = ${rel}, error = NULL, attempts = ${attempt + 1} WHERE id = ${s.id}`;
      await d.sql`UPDATE packs SET done = (SELECT count(*) FROM stickers WHERE pack_id = ${pack.id} AND status = 'done'), updated_at = now() WHERE id = ${pack.id}`;
      return;
    } catch (e) {
      if (e instanceof ProviderConfigError) throw e;
      lastErr = e;
      await d.sql`UPDATE stickers SET status = 'failed', error = ${String((e as Error).message).slice(0, 300)}, attempts = ${attempt + 1} WHERE id = ${s.id}`;
      if (signal?.aborted) return;
      // Пауза перед повтором: провайдеры режут по частоте (429), нельзя долбить сразу.
      if (attempt + 1 < STICKER_TRIES) await new Promise((r) => setTimeout(r, d.cfg.NODE_ENV === "test" ? 10 : 2000 * 2 ** attempt));
    }
  }
  throw lastErr;
}

async function upload(d: PipelineDeps, pack: PackRow, done: StickerRow[]): Promise<ProcessOutcome> {
  const log = d.log.child({ pack: pack.id });
  const files = done
    .sort((a, b) => a.idx - b.idx)
    .map((s) => ({ row: s, absPath: d.storage.abs(s.file_path!), emoji: s.emoji }));
  try {
    const existing = await d.tg.stickerSetSize(pack.sticker_set_name);
    if (existing === null) {
      await d.tg.createStickerSet(pack.user_id, pack.sticker_set_name, pack.sticker_set_title, files);
    } else {
      // Прошлый запуск упал посередине: докидываем недостающие по порядку.
      for (const f of files.slice(existing)) await d.tg.addSticker(pack.user_id, pack.sticker_set_name, f);
    }
    await d.sql`UPDATE stickers SET in_set = TRUE WHERE pack_id = ${pack.id} AND status = 'done'`;
  } catch (e) {
    const c = classifyTelegramError(e);
    if (c.kind === "user_unreachable") {
      await d.sql`UPDATE packs SET status = 'needs_start', locked_at = NULL, error = ${c.description}, updated_at = now() WHERE id = ${pack.id}`;
      await track(d.sql, pack.user_id, "pack_needs_start", { pack: pack.id });
      return "needs_start";
    }
    if (c.kind === "set_exists") {
      // Имя занято, но getStickerSet его не видит - редкая гонка. Повторим позже.
      await requeue(d.sql, pack.id, c.description);
      return "requeued";
    }
    if (c.kind === "bad_file") {
      log.error({ err: c.description }, "Telegram отверг файл стикера");
      return fail(d, pack, `Telegram отклонил файл: ${c.description}`);
    }
    log.warn({ err: c.description }, "ошибка загрузки набора, повторим");
    await requeue(d.sql, pack.id, c.description);
    return "requeued";
  }

  await d.sql`
    UPDATE packs SET status = 'ready', done = ${files.length}, total = ${files.length}, error = NULL,
           locked_at = NULL, finished_at = now(), updated_at = now()
    WHERE id = ${pack.id}`;
  await d.storage.remove(pack.selfie_path).catch(() => {});
  await track(d.sql, pack.user_id, "pack_ready", { pack: pack.id, count: files.length, style: pack.style_id, free: pack.is_free });
  const secs = Math.round((Date.now() - new Date(pack.created_at).getTime()) / 1000);
  d.notifier?.notify(
    "pack_ready",
    `✅ <b>Пак готов</b> · ${pack.style_id} · ${files.length} шт. · ${secs} с${pack.is_free ? " · бесплатный" : ""}\n` +
      `<code>${pack.user_id}</code> · https://t.me/addstickers/${pack.sticker_set_name}`,
  );

  const kb = new InlineKeyboard().webApp("🎉 Открыть пак", `${d.cfg.WEBAPP_URL}?screen=${encodeURIComponent(`pack:${pack.id}`)}`);
  const reached = await d.tg.sendMessage(pack.user_id, T.packReady(pack.sticker_set_title, files.length), kb).catch(() => false);
  if (!reached) await d.sql`UPDATE users SET bot_blocked = TRUE WHERE id = ${pack.user_id}`;
  return "ready";
}

async function fail(d: PipelineDeps, pack: PackRow, reason: string): Promise<ProcessOutcome> {
  d.log.warn({ pack: pack.id, reason }, "пак провален");
  const r = await failPack(d.sql, pack.id, reason);
  d.notifier?.notify("pack_failed", `⚠️ <b>Пак провален</b> · ${pack.style_id} · <code>${pack.user_id}</code>\n${esc(reason.slice(0, 300))}`);
  await d.storage.remove(pack.selfie_path).catch(() => {});
  if (r) {
    const kb = new InlineKeyboard().webApp("Попробовать снова", `${d.cfg.WEBAPP_URL}?screen=create`);
    await d.tg.sendMessage(pack.user_id, T.packFailed(failureReasonForUser(reason), r.refunded, pack.is_free), kb).catch(() => false);
  }
  return "failed";
}

/**
 * Цикл воркера: WORKER_SLOTS параллельных слотов, каждый берёт задачу из очереди в Postgres.
 */
export async function runWorker(d: PipelineDeps, signal: AbortSignal): Promise<void> {
  const idle = (ms: number) =>
    new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      signal.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
    });
  let pauseUntil = 0;
  const slot = async (n: number) => {
    while (!signal.aborted) {
      if (Date.now() < pauseUntil) {
        await idle(pauseUntil - Date.now());
        continue;
      }
      let pack: PackRow | null = null;
      try {
        pack = await claimPack(d.sql);
      } catch (e) {
        d.log.error({ err: (e as Error).message }, "не удалось взять задачу из очереди");
        await idle(5000);
        continue;
      }
      if (!pack) {
        await idle(1500);
        continue;
      }
      d.log.info({ pack: pack.id, slot: n, attempt: pack.attempts }, "генерация пака");
      try {
        const outcome = await processPack(d, pack, signal);
        d.log.info({ pack: pack.id, outcome }, "пак обработан");
        if (outcome === "requeued") pauseUntil = Math.max(pauseUntil, Date.now() + 30_000);
      } catch (e) {
        d.log.error({ pack: pack.id, err: (e as Error).stack }, "необработанная ошибка пайплайна");
        await requeue(d.sql, pack.id, (e as Error).message).catch(() => {});
        await idle(5000);
      }
    }
  };
  await Promise.all(Array.from({ length: d.cfg.WORKER_SLOTS }, (_, i) => slot(i)));
}
