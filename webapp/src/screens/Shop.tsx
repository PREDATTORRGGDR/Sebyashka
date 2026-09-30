import { motion } from "motion/react";
import { Bitcoin, Check, Crown, Gem, Gift, Hourglass, Star } from "lucide-react";
import { StarsPrice } from "../art";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Product } from "../api";
import { useApp } from "../state";
import { openTg, payInvoice, share } from "../telegram";
import { Button, Glass, packsWord, Segment, stagger, useToast } from "../ui";

type Method = "stars" | "cryptobot";

export function Shop({ reason }: { reason?: string }) {
  const { me, refresh } = useApp();
  const toast = useToast();
  const { user, catalog } = me;
  const [method, setMethod] = useState<Method>("stars");
  const [busy, setBusy] = useState<string | null>(null);
  const [waitingCrypto, setWaitingCrypto] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    void api.track("paywall_view", { from: reason ?? "nav" });
    return () => clearTimeout(pollRef.current);
  }, []);

  async function onPaid(orderId: string | null, product: Product) {
    await refresh();
    toast(`Оплачено: ${product.title}`, "ok");
    if (product.kind === "gift" && orderId) {
      const st = await api.orderStatus(orderId).catch(() => null);
      if (st?.giftLink) share(st.giftLink, "Дарю тебе стикерпак — сделай из любого фото 🎁");
    }
  }

  function pollCrypto(orderId: string, product: Product, startedAt = Date.now()) {
    pollRef.current = setTimeout(async () => {
      const st = await api.orderStatus(orderId).catch(() => null);
      if (st?.status === "paid") {
        setWaitingCrypto(null);
        return void onPaid(orderId, product);
      }
      if (st?.status === "expired" || Date.now() - startedAt > 20 * 60_000) {
        setWaitingCrypto(null);
        return toast("Счёт истёк — создай новый", "info");
      }
      pollCrypto(orderId, product, startedAt);
    }, 3000);
  }

  async function buy(p: Product) {
    setBusy(p.id);
    try {
      const { orderId, url } = await api.order(p.id, method);
      if (method === "stars") {
        const status = await payInvoice(url);
        if (status === "paid") await onPaid(orderId, p);
        else if (status === "failed") toast("Оплата не прошла", "err");
      } else {
        openTg(url);
        setWaitingCrypto(orderId);
        pollCrypto(orderId, p);
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось создать счёт", "err");
    } finally {
      setBusy(null);
    }
  }

  const pro = catalog.products.find((p) => p.kind === "pro");
  const packs = catalog.products.filter((p) => p.kind === "credits");
  const gift = catalog.products.find((p) => p.kind === "gift");
  const price = (p: Product) => (method === "stars" ? <StarsPrice value={p.stars} /> : `$${p.usd}`);

  return (
    <div className="screen">
      <div className="topbar">
        <h1 className="h1">Магазин</h1>
        <span className="chip">
          <Gem size={16} /> {packsWord(user.credits)}
        </span>
      </div>

      {reason === "credits" && (
        <Glass className="card tight small muted" {...stagger(0)}>
          Не хватает паков на балансе — выбери пакет ниже, и стикеры начнут собираться сразу после оплаты.
        </Glass>
      )}

      {catalog.cryptoEnabled && (
        <Segment
          id="pay"
          value={method}
          onChange={setMethod}
          options={[
            { value: "stars", label: <><Star size={15} /> Telegram Stars</> },
            { value: "cryptobot", label: <><Bitcoin size={15} /> Крипта</> },
          ]}
        />
      )}

      {waitingCrypto && (
        <Glass className="card tight row" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}>
          <Hourglass size={18} className="spin" style={{ flexShrink: 0 }} />
          <span className="small">Жду оплату в @CryptoBot. После оплаты вернись сюда — паки начислятся автоматически.</span>
        </Glass>
      )}

      {pro && (
        <Glass className="card inverted col" style={{ gap: 12 }} {...stagger(1)}>
          <div className="row between">
            <div className="row">
              <Crown size={22} />
              <b style={{ fontSize: 20, letterSpacing: "-0.02em" }}>{pro.title}</b>
            </div>
            {user.isPro ? <span className="badge" style={{ background: "var(--accent-fg)", color: "var(--accent)" }}>Активна</span> : pro.badge && <span className="badge" style={{ background: "var(--accent-fg)", color: "var(--accent)" }}>{pro.badge}</span>}
          </div>
          <div className="col" style={{ gap: 6 }}>
            {[`${packsWord(pro.credits)} каждый месяц`, "Премиум-стили по цене обычных", "Приоритет в очереди генерации"].map((t) => (
              <div key={t} className="row small">
                <Check size={16} /> {t}
              </div>
            ))}
          </div>
          <motion.button
            whileTap={{ scale: 0.97 }}
            className="btn"
            style={{ background: "var(--accent-fg)", color: "var(--accent)" }}
            disabled={busy === pro.id || (user.isPro && method === "stars")}
            onClick={() => void buy(pro)}
          >
            {user.isPro && method === "stars"
              ? "Продлевается автоматически"
              : <>{user.isPro ? "Продлить" : "Подключить"} · {price(pro)}{method === "stars" ? " / мес" : " / 30 дней"}</>}
          </motion.button>
          {user.isPro && user.proUntil && (
            <div className="small" style={{ opacity: 0.6 }}>
              Действует до {new Date(user.proUntil).toLocaleDateString("ru-RU")}
            </div>
          )}
        </Glass>
      )}

      <div className="col" style={{ gap: 10 }}>
        {packs.map((p, i) => (
          <Glass key={p.id} className="card tight row" {...stagger(i + 2)}>
            <div className="glass" style={{ width: 48, height: 48, borderRadius: 16, display: "grid", placeItems: "center", fontWeight: 700 }}>
              {p.credits}
            </div>
            <div className="grow">
              <div className="row" style={{ gap: 8 }}>
                <b>{p.title}</b>
                {p.badge && <span className="badge">{p.badge}</span>}
              </div>
              <div className="faint small">{p.description}</div>
            </div>
            <Button size="sm" loading={busy === p.id} onClick={() => void buy(p)}>
              {price(p)}
            </Button>
          </Glass>
        ))}
      </div>

      {gift && (
        <Glass className="card tight row" {...stagger(6)}>
          <div className="glass" style={{ width: 48, height: 48, borderRadius: 16, display: "grid", placeItems: "center" }}>
            <Gift size={22} />
          </div>
          <div className="grow">
            <b>{gift.title}</b>
            <div className="faint small">{gift.description}</div>
          </div>
          <Button variant="ghost" size="sm" loading={busy === gift.id} onClick={() => void buy(gift)}>
            {price(gift)}
          </Button>
        </Glass>
      )}

      <div className="faint small center" style={{ lineHeight: 1.5, padding: "0 12px" }}>
        Оплата через Telegram Stars или @CryptoBot (USDT, TON, BTC и др.). Если пак не собрался — паки возвращаются автоматически.
        Вопросы по оплате: /paysupport в боте.
      </div>
    </div>
  );
}
