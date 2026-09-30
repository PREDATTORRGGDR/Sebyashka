import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
}

export interface InitData {
  user: WebAppUser;
  authDate: Date;
  startParam: string | null;
  queryId: string | null;
}

export class InitDataError extends Error {}

/**
 * Проверка подписи Telegram.WebApp.initData (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
 * secret = HMAC_SHA256(key="WebAppData", bot_token); hash = HMAC_SHA256(key=secret, data_check_string).
 */
export function validateInitData(raw: string, botToken: string, maxAgeSec = 24 * 3600, now = Date.now()): InitData {
  if (!raw || raw.length > 8192) throw new InitDataError("пустые или слишком длинные initData");
  const params = new URLSearchParams(raw);
  const hash = params.get("hash");
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) throw new InitDataError("нет hash");
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(dataCheckString).digest();
  const got = Buffer.from(hash, "hex");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new InitDataError("неверная подпись");

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0) throw new InitDataError("нет auth_date");
  if (now / 1000 - authDate > maxAgeSec) throw new InitDataError("initData устарели — перезапусти мини-приложение");

  const userRaw = params.get("user");
  if (!userRaw) throw new InitDataError("нет user");
  let user: WebAppUser;
  try {
    user = JSON.parse(userRaw) as WebAppUser;
  } catch {
    throw new InitDataError("user — не JSON");
  }
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new InitDataError("некорректный user.id");
  return {
    user,
    authDate: new Date(authDate * 1000),
    startParam: params.get("start_param"),
    queryId: params.get("query_id"),
  };
}

/** Для тестов и локальной отладки: собрать валидные initData. */
export function signInitData(fields: Record<string, string>, botToken: string): string {
  const params = new URLSearchParams(fields);
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}

/** Разбор start-параметра: ref_<code> | gift_<code>. */
export function parseStartParam(p: string | null | undefined): { ref?: string; gift?: string } {
  if (!p) return {};
  const m = /^(ref|gift)_([a-z0-9]{4,16})$/.exec(p);
  if (!m) return {};
  return m[1] === "ref" ? { ref: m[2]! } : { gift: m[2]! };
}
