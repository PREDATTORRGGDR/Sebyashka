import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import type { Sql } from "../src/db/client.js";
import { getProduct } from "../src/domain/catalog.js";
import { createOrder, fulfillPayment, redeemGift, refundOrderByCharge } from "../src/domain/orders.js";
import { claimPack, createPack, failPack, getPack, packStickers } from "../src/domain/packs.js";
import { attachReferrer, getUser, upsertUser, type UserRow } from "../src/domain/users.js";
import { AppError } from "../src/errors.js";
import { processPack, type PipelineDeps } from "../src/generation/pipeline.js";
import { normalizeSelfie } from "../src/generation/postprocess.js";
import { MockGenerator, ProviderConfigError, type ImageGenerator } from "../src/generation/providers.js";
import { paths, Storage } from "../src/storage.js";
import { FakeTelegram, fakeSelfie, freshDb, silentLog, TEST_DB, testConfig } from "./helpers.js";

const BOT = "sebyashka_test_bot";

describe.skipIf(!TEST_DB)("интеграция с Postgres", () => {
  let sql: Sql;
  let cfg: Config;
  let storage: Storage;
  let uid = 1000;

  beforeAll(async () => {
    sql = await freshDb();
  });
  afterAll(async () => {
    await sql?.end();
  });
  beforeEach(async () => {
    cfg = await testConfig();
    storage = new Storage(cfg.DATA_DIR);
    // Каждый тест начинает с пустой очереди.
    await sql`UPDATE packs SET status = 'failed' WHERE status IN ('queued','processing','needs_start')`;
  });

  async function newUser(name = "Тест"): Promise<UserRow> {
    const { user } = await upsertUser(sql, { id: ++uid, first_name: name, username: `u${uid}` });
    return user;
  }

  async function withSelfie(u: UserRow): Promise<UserRow> {
    const rel = paths.selfie(u.id);
    await storage.write(rel, await normalizeSelfie(await fakeSelfie()));
    await sql`UPDATE users SET selfie_path = ${rel}, selfie_uploaded_at = now() WHERE id = ${u.id}`;
    return (await getUser(sql, u.id))!;
  }

  async function pay(u: UserRow, productId: string, charge = `ch_${Math.random()}`) {
    const order = await createOrder(sql, u.id, getProduct(productId)!, "stars");
    return fulfillPayment(sql, { orderId: order.id, provider: "stars", chargeId: charge, userId: u.id, amountStars: order.amount_stars! });
  }

  function deps(tg: FakeTelegram, generator: ImageGenerator = new MockGenerator()): PipelineDeps {
    return { sql, cfg, storage, generator, bgRemover: null, tg, log: silentLog, botUsername: BOT };
  }

  it("upsert не затирает имя и сохраняет код рефералки", async () => {
    const u = await newUser("Аня");
    const again = await upsertUser(sql, { id: u.id, first_name: "" });
    expect(again.isNew).toBe(false);
    expect(again.user.first_name).toBe("Аня");
    expect(again.user.referral_code).toBe(u.referral_code);
  });

  it("оплата зачисляется ровно один раз даже при параллельных дублях", async () => {
    const u = await newUser();
    const order = await createOrder(sql, u.id, getProduct("pack_3")!, "stars");
    const ev = { orderId: order.id, provider: "stars" as const, chargeId: "dup_charge_1", userId: u.id, amountStars: 390 };
    const results = await Promise.allSettled([fulfillPayment(sql, ev), fulfillPayment(sql, ev), fulfillPayment(sql, ev)]);
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<{ status: string }>).value.status);
    expect(ok.filter((s) => s === "fulfilled")).toHaveLength(1);
    expect((await getUser(sql, u.id))!.credits).toBe(3);
    const ledger = await sql`SELECT * FROM ledger WHERE user_id = ${u.id}`;
    expect(ledger).toHaveLength(1);
  });

  it("чужой заказ не зачисляется", async () => {
    const a = await newUser();
    const b = await newUser();
    const order = await createOrder(sql, a.id, getProduct("pack_1")!, "stars");
    await expect(fulfillPayment(sql, { orderId: order.id, provider: "stars", chargeId: "x1", userId: b.id })).rejects.toThrow(AppError);
  });

  it("Pro: подписка продлевается, начисляет паки и продлевается повторно", async () => {
    const u = await newUser();
    const order = await createOrder(sql, u.id, getProduct("pro_30")!, "stars");
    await fulfillPayment(sql, { orderId: order.id, provider: "stars", chargeId: "sub_1", userId: u.id, amountStars: 500 });
    let fresh = (await getUser(sql, u.id))!;
    expect(fresh.credits).toBe(6);
    const until1 = fresh.pro_until!.getTime();
    expect(until1).toBeGreaterThan(Date.now() + 29 * 86400_000);
    // автопродление приходит с тем же payload, новым charge id
    const r2 = await fulfillPayment(sql, { orderId: order.id, provider: "stars", chargeId: "sub_2", userId: u.id, amountStars: 500, isRecurring: true });
    expect(r2.order.parent_order_id).toBe(order.id);
    fresh = (await getUser(sql, u.id))!;
    expect(fresh.credits).toBe(12);
    expect(fresh.pro_until!.getTime()).toBeGreaterThan(until1 + 29 * 86400_000);
  });

  it("рефералка: награда только за первую покупку, без самоприглашения и циклов", async () => {
    const inviter = await newUser();
    const invitee = await newUser();
    expect(await attachReferrer(sql, invitee.id, invitee.referral_code)).toBeNull(); // сам себя
    expect(await attachReferrer(sql, inviter.id, invitee.referral_code)).toBeNull(); // старший к младшему — нельзя
    expect(await attachReferrer(sql, invitee.id, inviter.referral_code)).toEqual({ referrerId: inviter.id, rewarded: false });
    expect(await attachReferrer(sql, invitee.id, inviter.referral_code)).toBeNull(); // повторно
    await pay(invitee, "pack_1");
    await pay(invitee, "pack_1");
    expect((await getUser(sql, inviter.id))!.credits).toBe(1);
  });

  it("рефералка: +1 пак за каждых 3 приглашённых, ровно на третьем", async () => {
    const inviter = await newUser();
    const got: boolean[] = [];
    for (let i = 0; i < 6; i++) {
      const friend = await newUser();
      got.push((await attachReferrer(sql, friend.id, inviter.referral_code))!.rewarded);
    }
    expect(got).toEqual([false, false, true, false, false, true]);
    expect((await getUser(sql, inviter.id))!.credits).toBe(2);
  });

  it("подарок: покупка → код → активация другом один раз", async () => {
    const buyer = await newUser();
    const friend = await newUser();
    const r = await pay(buyer, "gift_1");
    expect(r.giftCode).toMatch(/^[a-z0-9]{10}$/);
    expect((await getUser(sql, buyer.id))!.credits).toBe(0);
    await expect(redeemGift(sql, buyer.id, r.giftCode!)).rejects.toThrow(/свой/);
    const g = await redeemGift(sql, friend.id, r.giftCode!);
    expect(g.balance).toBe(1);
    await expect(redeemGift(sql, friend.id, r.giftCode!)).rejects.toThrow(/уже/);
    const third = await newUser();
    await expect(redeemGift(sql, third.id, r.giftCode!)).rejects.toThrow(/уже/);
  });

  it("возврат списывает остаток, но не уводит в минус", async () => {
    const u = await newUser();
    await pay(u, "pack_3", "refund_me");
    await sql.begin(async (tx) => {
      await tx`UPDATE users SET credits = 1 WHERE id = ${u.id}`;
    });
    const r = await refundOrderByCharge(sql, "refund_me");
    expect(r!.creditsTaken).toBe(1);
    expect((await getUser(sql, u.id))!.credits).toBe(0);
    const again = await refundOrderByCharge(sql, "refund_me");
    expect(again!.creditsTaken).toBe(0);
  });

  it("пак: без селфи нельзя, без кредитов нельзя, бесплатный — один раз, премиум бесплатно нельзя", async () => {
    let u = await newUser();
    await expect(createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: true })).rejects.toMatchObject({ code: "NO_SELFIE" });
    u = await withSelfie(u);
    await expect(createPack(sql, storage, cfg, BOT, { user: u, styleId: "chibi", free: true })).rejects.toMatchObject({ code: "FREE_STYLE_ONLY" });
    await expect(createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: false })).rejects.toMatchObject({ code: "NOT_ENOUGH_CREDITS" });
    await expect(createPack(sql, storage, cfg, BOT, { user: u, styleId: "nope", free: true })).rejects.toMatchObject({ code: "UNKNOWN_STYLE" });
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: true });
    expect(p.total).toBe(cfg.FREE_PACK_SIZE);
    await expect(createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: true })).rejects.toMatchObject({ code: "PACK_IN_PROGRESS" });
    await sql`UPDATE packs SET status = 'ready' WHERE id = ${p.id}`;
    await expect(createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: true })).rejects.toMatchObject({ code: "FREE_PACK_USED" });
  });

  it("параллельные запросы на пак не списывают дважды", async () => {
    let u = await newUser();
    await pay(u, "pack_3");
    u = await withSelfie(u);
    const rs = await Promise.allSettled(
      [1, 2, 3].map(() => createPack(sql, storage, cfg, BOT, { user: u, styleId: "comic", free: false })),
    );
    expect(rs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await getUser(sql, u.id))!.credits).toBe(2);
  });

  it("провал пака возвращает кредиты один раз и бесплатную попытку", async () => {
    let u = await newUser();
    await pay(u, "pack_1");
    u = await withSelfie(u);
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: false });
    expect((await getUser(sql, u.id))!.credits).toBe(0);
    await failPack(sql, p.id, "test");
    await failPack(sql, p.id, "test again");
    expect((await getUser(sql, u.id))!.credits).toBe(1);

    const f = await createPack(sql, storage, cfg, BOT, { user: (await getUser(sql, u.id))!, styleId: "anime", free: true });
    await failPack(sql, f.id, "x");
    expect((await getUser(sql, u.id))!.free_pack_used).toBe(false);
  });

  it("E2E: пак генерируется, загружается в Telegram, приходит уведомление", async () => {
    let u = await newUser("Макс");
    await pay(u, "pack_1");
    u = await withSelfie(u);
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "cartoon3d", free: false });
    const claimed = (await claimPack(sql))!;
    expect(claimed.id).toBe(p.id);
    const tg = new FakeTelegram();
    const outcome = await processPack(deps(tg), claimed);
    expect(outcome).toBe("ready");
    const set = tg.sets.get(p.sticker_set_name)!;
    expect(set.owner).toBe(u.id);
    expect(set.stickers).toHaveLength(cfg.STICKERS_PER_PACK);
    expect(set.title).toContain("@" + BOT);
    const fresh = (await getPack(sql, p.id))!;
    expect(fresh.status).toBe("ready");
    expect(tg.messages.at(-1)!.text).toContain("готов");
    expect(await storage.exists(p.selfie_path)).toBe(false); // селфи удалено после генерации
  });

  it("E2E: пользователь не нажал /start → needs_start, потом догружается", async () => {
    let u = await newUser();
    u = await withSelfie(u);
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: true });
    const tg = new FakeTelegram();
    tg.unreachable.add(u.id);
    expect(await processPack(deps(tg), (await claimPack(sql))!)).toBe("needs_start");
    expect((await getPack(sql, p.id))!.status).toBe("needs_start");
    tg.unreachable.delete(u.id);
    await sql`UPDATE packs SET status = 'queued' WHERE id = ${p.id}`;
    expect(await processPack(deps(tg), (await claimPack(sql))!)).toBe("ready");
  });

  it("E2E: сбой Telegram посреди загрузки → повтор без дублей", async () => {
    let u = await newUser();
    u = await withSelfie(u);
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: true });
    const tg = new FakeTelegram();
    tg.failCreateOnce = true;
    expect(await processPack(deps(tg), (await claimPack(sql))!)).toBe("requeued");
    expect(await processPack(deps(tg), (await claimPack(sql))!)).toBe("ready");
    expect(tg.sets.get(p.sticker_set_name)!.stickers).toHaveLength(cfg.FREE_PACK_SIZE);
    // генерация не повторялась: все стикеры уже были done
    const st = await packStickers(sql, p.id);
    expect(st.every((s) => s.attempts === 1)).toBe(true);
  });

  it("E2E: нейросеть часто падает → пак провален, кредиты возвращены", async () => {
    let u = await newUser();
    await pay(u, "pack_1");
    u = await withSelfie(u);
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: false });
    const broken: ImageGenerator = { name: "broken", generate: async () => { throw new Error("boom"); } };
    const tg = new FakeTelegram();
    let outcome = "";
    for (let i = 0; i < 10 && outcome !== "failed"; i++) {
      const job = await claimPack(sql);
      if (!job) break;
      outcome = await processPack(deps(tg, broken), job);
    }
    expect(outcome).toBe("failed");
    expect((await getPack(sql, p.id))!.status).toBe("failed");
    expect((await getUser(sql, u.id))!.credits).toBe(1);
    expect(tg.messages.at(-1)!.text).toContain("Вернул");
  });

  it("E2E: неверный ключ провайдера → пак остаётся в очереди, деньги не трогаем", async () => {
    let u = await newUser();
    await pay(u, "pack_1");
    u = await withSelfie(u);
    const p = await createPack(sql, storage, cfg, BOT, { user: u, styleId: "anime", free: false });
    const badKey: ImageGenerator = { name: "bad", generate: async () => { throw new ProviderConfigError("HTTP 401"); } };
    let alerted = "";
    const d = { ...deps(new FakeTelegram(), badKey), alert: (m: string) => (alerted = m) };
    expect(await processPack(d, (await claimPack(sql))!)).toBe("requeued");
    expect((await getPack(sql, p.id))!.status).toBe("queued");
    expect(alerted).toContain("401");
    expect((await getUser(sql, u.id))!.credits).toBe(0); // списано, но пак ещё будет сделан
    await sql`UPDATE packs SET status = 'ready' WHERE id = ${p.id}`;
  });

  it("очередь: приоритет Pro, SKIP LOCKED не выдаёт одну задачу дважды", async () => {
    const a = await withSelfie(await newUser());
    const b = await withSelfie(await newUser());
    await pay(b, "pro_30");
    await createPack(sql, storage, cfg, BOT, { user: a, styleId: "anime", free: true });
    const pb = await createPack(sql, storage, cfg, BOT, { user: (await getUser(sql, b.id))!, styleId: "chibi", free: false });
    const first = await claimPack(sql);
    expect(first!.id).toBe(pb.id); // Pro обслуживается первым
    const [j2, j3] = await Promise.all([claimPack(sql), claimPack(sql)]);
    const ids = [first, j2, j3].filter(Boolean).map((j) => j!.id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(pb.credits_spent).toBe(1); // премиум для Pro по цене обычного
  });
});
