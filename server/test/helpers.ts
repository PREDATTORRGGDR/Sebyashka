import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { loadConfig, type Config } from "../src/config.js";
import { createDb, migrate, type Sql } from "../src/db/client.js";
import { createLogger } from "../src/logger.js";
import type { StickerFile, TelegramGateway } from "../src/telegram/gateway.js";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "";
export const BOT_TOKEN = "123456789:AAtestTokenForUnitTests_abcdefghijklm";

export async function testConfig(over: Record<string, string> = {}): Promise<Config> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "seb-"));
  return loadConfig({
    NODE_ENV: "test",
    BOT_TOKEN,
    BOT_USERNAME: "sebyashka_test_bot",
    DATABASE_URL: TEST_DB || "postgres://x@localhost/x",
    SIGNING_SECRET: "s".repeat(40),
    DATA_DIR: dir,
    GEN_PROVIDER: "mock",
    STICKERS_PER_PACK: "8",
    FREE_PACK_SIZE: "4",
    GEN_CONCURRENCY: "4",
    LOG_LEVEL: "fatal",
    ...over,
  });
}

export const silentLog = createLogger("fatal");

/** Чистая БД для каждого файла тестов. */
export async function freshDb(): Promise<Sql> {
  const sql = createDb(TEST_DB, { max: 5 });
  await sql.unsafe("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate(sql);
  return sql;
}

export async function fakeSelfie(): Promise<Buffer> {
  const svg = `<svg width="600" height="600" xmlns="http://www.w3.org/2000/svg">
    <rect width="600" height="600" fill="#dfe6ee"/>
    <circle cx="300" cy="280" r="170" fill="#f1c27d"/>
    <circle cx="240" cy="250" r="20" fill="#333"/><circle cx="360" cy="250" r="20" fill="#333"/>
    <path d="M220 350 Q300 420 380 350" stroke="#333" stroke-width="12" fill="none"/></svg>`;
  return sharp(Buffer.from(svg)).jpeg().toBuffer();
}

export class FakeTelegram implements TelegramGateway {
  sets = new Map<string, { owner: number; title: string; stickers: StickerFile[] }>();
  messages: { userId: number; text: string }[] = [];
  unreachable = new Set<number>();
  failCreateOnce = false;

  async createStickerSet(userId: number, name: string, title: string, stickers: StickerFile[]) {
    if (this.unreachable.has(userId)) throw grammyError(400, "Bad Request: PEER_ID_INVALID");
    if (this.sets.has(name)) throw grammyError(400, "Bad Request: sticker set name is already occupied");
    if (this.failCreateOnce) {
      this.failCreateOnce = false;
      throw grammyError(500, "Internal Server Error");
    }
    for (const s of stickers) {
      const meta = await sharp(s.absPath).metadata();
      if (Math.max(meta.width!, meta.height!) !== 512) throw grammyError(400, "Bad Request: STICKER_PNG_DIMENSIONS");
    }
    this.sets.set(name, { owner: userId, title, stickers: [...stickers] });
  }
  async addSticker(_userId: number, name: string, sticker: StickerFile) {
    this.sets.get(name)!.stickers.push(sticker);
  }
  async stickerSetSize(name: string) {
    return this.sets.get(name)?.stickers.length ?? null;
  }
  async sendMessage(userId: number, text: string) {
    if (this.unreachable.has(userId)) return false;
    this.messages.push({ userId, text });
    return true;
  }
}

import { GrammyError } from "grammy";
export function grammyError(code: number, description: string): GrammyError {
  return new GrammyError(description, { ok: false, error_code: code, description }, "test", {});
}
