import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Клиент Crypto Pay API (@CryptoBot). Документация: https://help.crypt.bot/crypto-pay-api
 */
export interface CryptoInvoice {
  invoice_id: number;
  hash: string;
  status: "active" | "paid" | "expired";
  bot_invoice_url: string;
  mini_app_invoice_url?: string;
  web_app_invoice_url?: string;
  payload?: string;
  amount: string;
  fiat?: string;
  asset?: string;
  paid_asset?: string;
  paid_amount?: string;
  paid_usd_rate?: string;
  paid_at?: string;
}

export class CryptoBotError extends Error {}

export class CryptoBotClient {
  private readonly base: string;
  constructor(
    private readonly token: string,
    network: "mainnet" | "testnet",
    private readonly assets: string,
  ) {
    this.base = network === "testnet" ? "https://testnet-pay.crypt.bot/api" : "https://pay.crypt.bot/api";
  }

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.base}/${method}`, {
        method: "POST",
        headers: { "Crypto-Pay-API-Token": this.token, "Content-Type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new CryptoBotError(`CryptoBot недоступен: ${(e as Error).message}`);
    }
    const body = (await res.json().catch(() => null)) as { ok: boolean; result?: T; error?: { name?: string; code?: number } } | null;
    if (!body?.ok || body.result === undefined) {
      throw new CryptoBotError(`CryptoBot ${method}: ${body?.error?.name ?? `HTTP ${res.status}`}`);
    }
    return body.result;
  }

  getMe(): Promise<{ app_id: number; name: string; payment_processing_bot_username: string }> {
    return this.call("getMe", {});
  }

  createInvoice(p: { usd: string; description: string; payload: string; returnUrl: string }): Promise<CryptoInvoice> {
    return this.call<CryptoInvoice>("createInvoice", {
      currency_type: "fiat",
      fiat: "USD",
      amount: p.usd,
      accepted_assets: this.assets,
      description: p.description.slice(0, 1024),
      payload: p.payload,
      paid_btn_name: "callback",
      paid_btn_url: p.returnUrl,
      allow_comments: false,
      allow_anonymous: true,
      expires_in: 3600,
    });
  }

  async getInvoices(ids: number[]): Promise<CryptoInvoice[]> {
    if (!ids.length) return [];
    const r = await this.call<{ items: CryptoInvoice[] }>("getInvoices", { invoice_ids: ids.join(","), count: 1000 });
    return r.items;
  }
}

/**
 * Проверка подписи вебхука: HMAC-SHA256(body, key = SHA256(token)), заголовок crypto-pay-api-signature.
 * Проверять нужно по СЫРОМУ телу запроса, не по пересобранному JSON.
 */
export function verifyCryptoBotSignature(token: string, rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!signature || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const secret = createHash("sha256").update(token).digest();
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const got = Buffer.from(signature, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export interface CryptoWebhookUpdate {
  update_id: number;
  update_type: "invoice_paid" | string;
  request_date: string;
  payload: CryptoInvoice;
}
