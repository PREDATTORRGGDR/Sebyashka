import { motion } from "motion/react";
import { Bitcoin, Check, Crown, Gem, Gift, Hourglass, LoaderCircle, Star, Sticker } from "lucide-react";
import { StarsPrice } from "../art";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, type Product } from "../api";
import { useApp } from "../state";
import { haptic, openTg, payInvoice, share } from "../telegram";
import { Glass, packsWord, Segment, stagger, useToast } from "../ui";

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
      if (st?.giftLink) share(st.giftLink, "Дарю тебе стикерпак - сделай из любого фото 🎁");
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
        return toast("Счёт истёк - создай новый", "info");
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

  // Вся карточка - кнопка оплаты; цена справа только метка (кнопка в кнопке недопустима).
  const buyRow = ({ p, art, ghost, i }: { p: Product; art: ReactNode; ghost?: boolean; i: number }) => (
    <motion.button
      key={p.id}
      className="glass card tight row buy-row"
      {...stagger(i)}
      whileTap={busy ? undefined : { scale: 0.98 }}
      disabled={!!busy}
      aria-label={`Купить: ${p.title}`}
      onClick={() => {
        haptic.tap();
        void buy(p);
      }}
    >
      {art}
      <div className="grow">
        <div className="row" style={{ gap: 8 }}>
          <b>{p.title}</b>
          {p.badge && <span className="badge">{p.badge}</span>}
        </div>
        <div className="faint small">{p.description}</div>
      </div>
      <span className={`btn sm ${ghost ? "ghost" : "primary"}`}>{busy === p.id ? <LoaderCircle size={18} className="spin" /> : price(p)}</span>
    </motion.button>
  );

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
          Не хватает паков на балансе - выбери пакет ниже, и стикеры начнут собираться сразу после оплаты.
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
          <span className="small">Жду оплату в @CryptoBot. После оплаты вернись сюда - паки начислятся автоматически.</span>
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
          buyRow({ p, i: i + 2, art: <PackStack n={p.credits} /> })
        ))}
      </div>

      {gift &&
        buyRow({
          p: gift,
          i: 6,
          ghost: true,
          art: (
            <div className="pack-stack" aria-hidden>
              <span className="top">
                <Gift size={22} />
              </span>
            </div>
          ),
        })}

      <div className="faint small center" style={{ lineHeight: 1.5, padding: "0 12px" }}>
        Оплата через Telegram Stars или @CryptoBot (USDT, TON, BTC и др.). Если пак не собрался - паки возвращаются автоматически.
        Вопросы по оплате: /paysupport в боте.
      </div>
    </div>
  );
}

/** Стопка стикерпаков: число листов растёт с количеством паков, у больших пакетов метка ×N. */
function PackStack({ n }: { n: number }) {
  const layers = Math.min(n, 3);
  return (
    <div className="pack-stack" aria-hidden>
      {layers >= 3 && <span className="l2" />}
      {layers >= 2 && <span className="l1" />}
      <span className="top">
        <Sticker size={22} />
      </span>
      {n > 1 && <b className="pack-count">×{n}</b>}
    </div>
  );
}
