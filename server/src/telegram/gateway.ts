import { Api, GrammyError, HttpError, InlineKeyboard, InputFile } from "grammy";
import type { InputSticker } from "grammy/types";

export interface StickerFile {
  absPath: string;
  emoji: string;
}

/** Всё, что пайплайну нужно от Telegram. Интерфейс - чтобы тестировать без сети. */
export interface TelegramGateway {
  createStickerSet(userId: number, name: string, title: string, stickers: StickerFile[]): Promise<void>;
  addSticker(userId: number, name: string, sticker: StickerFile): Promise<void>;
  /** Количество стикеров в наборе или null, если набора нет. */
  stickerSetSize(name: string): Promise<number | null>;
  sendMessage(userId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean>;
}

/** Классификация ошибок Bot API для правильной реакции. */
export type TgErrorKind = "user_unreachable" | "set_exists" | "set_missing" | "flood" | "bad_file" | "other";

export function classifyTelegramError(e: unknown): { kind: TgErrorKind; retryAfter?: number; description: string } {
  if (e instanceof GrammyError) {
    const d = e.description;
    if (e.error_code === 429) return { kind: "flood", retryAfter: e.parameters.retry_after ?? 5, description: d };
    if (/name is already occupied|STICKERSET_OCCUPIED/i.test(d)) return { kind: "set_exists", description: d };
    if (/STICKERSET_INVALID|sticker set not found/i.test(d)) return { kind: "set_missing", description: d };
    if (/PEER_ID_INVALID|USER_ID_INVALID|user not found|bot was blocked|user is deactivated|chat not found|USER_IS_BOT|have no rights to send/i.test(d))
      return { kind: "user_unreachable", description: d };
    if (/STICKER_PNG_DIMENSIONS|STICKER_FILE_INVALID|wrong file|IMAGE_PROCESS_FAILED|STICKER_PNG_NOPNG|too big/i.test(d))
      return { kind: "bad_file", description: d };
    return { kind: "other", description: d };
  }
  if (e instanceof HttpError) return { kind: "other", description: `сеть: ${e.message}` };
  return { kind: "other", description: (e as Error)?.message ?? String(e) };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Повтор при 429 (flood control) и сетевых сбоях. */
export async function withTgRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const c = classifyTelegramError(e);
      if (c.kind === "flood") {
        await sleep(Math.min((c.retryAfter ?? 5) + 1, 60) * 1000);
        continue;
      }
      if (e instanceof HttpError) {
        await sleep(1000 * 2 ** i);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

function inputSticker(s: StickerFile): InputSticker {
  return { sticker: new InputFile(s.absPath), format: "static", emoji_list: [s.emoji] };
}

export class BotApiGateway implements TelegramGateway {
  constructor(private readonly api: Api) {}

  async createStickerSet(userId: number, name: string, title: string, stickers: StickerFile[]): Promise<void> {
    // Telegram принимает до 50 стикеров при создании; у нас максимум 24.
    await withTgRetry(() => this.api.createNewStickerSet(userId, name, title, stickers.slice(0, 50).map(inputSticker)));
  }

  async addSticker(userId: number, name: string, sticker: StickerFile): Promise<void> {
    await withTgRetry(() => this.api.addStickerToSet(userId, name, inputSticker(sticker)));
  }

  async stickerSetSize(name: string): Promise<number | null> {
    try {
      const set = await withTgRetry(() => this.api.getStickerSet(name));
      return set.stickers.length;
    } catch (e) {
      if (classifyTelegramError(e).kind === "set_missing") return null;
      throw e;
    }
  }

  async sendMessage(userId: number, text: string, keyboard?: InlineKeyboard): Promise<boolean> {
    try {
      await withTgRetry(() =>
        this.api.sendMessage(userId, text, { parse_mode: "HTML", reply_markup: keyboard, link_preview_options: { is_disabled: true } }),
      );
      return true;
    } catch (e) {
      if (classifyTelegramError(e).kind === "user_unreachable") return false;
      throw e;
    }
  }
}
