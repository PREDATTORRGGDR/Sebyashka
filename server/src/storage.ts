import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile, copyFile, readdir } from "node:fs/promises";
import path from "node:path";

/** Локальное файловое хранилище. Все пути — относительные к DATA_DIR и строятся только из наших id. */
export class Storage {
  readonly root: string;
  constructor(dataDir: string) {
    this.root = path.resolve(dataDir);
  }

  abs(rel: string): string {
    const p = path.resolve(this.root, rel);
    if (!p.startsWith(this.root + path.sep)) throw new Error(`путь вне хранилища: ${rel}`);
    return p;
  }

  async write(rel: string, data: Buffer): Promise<void> {
    const p = this.abs(rel);
    await mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, p); // атомарно: читатель никогда не увидит полфайла
  }

  read(rel: string): Promise<Buffer> {
    return readFile(this.abs(rel));
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await stat(this.abs(rel));
      return true;
    } catch {
      return false;
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const dst = this.abs(to);
    await mkdir(path.dirname(dst), { recursive: true });
    await copyFile(this.abs(from), dst);
  }

  async remove(rel: string): Promise<void> {
    await rm(this.abs(rel), { force: true, recursive: true });
  }

  async list(relDir: string): Promise<string[]> {
    try {
      return await readdir(this.abs(relDir));
    } catch {
      return [];
    }
  }
}

export const paths = {
  selfie: (userId: number) => `selfies/${userId}/${Date.now()}-${randomBytes(3).toString("hex")}.jpg`,
  packSelfie: (packId: string) => `packs/${packId}/selfie.jpg`,
  sticker: (packId: string, idx: number, ext: "png" | "webp") => `packs/${packId}/${idx}.${ext}`,
  packDir: (packId: string) => `packs/${packId}`,
};

/** Подписанные ссылки на превью стикеров: <img> не умеет слать заголовок авторизации. */
export class UrlSigner {
  constructor(private readonly secret: string) {}

  private sig(data: string): string {
    return createHmac("sha256", this.secret).update(data).digest("base64url").slice(0, 32);
  }

  sign(pathname: string, ttlSec = 6 * 3600): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    return `${pathname}?exp=${exp}&sig=${this.sig(`${pathname}|${exp}`)}`;
  }

  verify(pathname: string, exp: string | undefined, sig: string | undefined): boolean {
    if (!exp || !sig || !/^\d+$/.test(exp)) return false;
    if (Number(exp) < Date.now() / 1000) return false;
    const expected = Buffer.from(this.sig(`${pathname}|${exp}`));
    const got = Buffer.from(sig);
    return expected.length === got.length && timingSafeEqual(expected, got);
  }
}
