import { motion } from "motion/react";
import { ChevronRight, Crown, Gem, Gift, Image, LoaderCircle, Sparkles } from "lucide-react";
import { EmptyArt, HeroArt } from "../art";
import { useEffect, useState } from "react";
import { api, type Pack } from "../api";
import { useApp } from "../state";
import { Button, Glass, packsWord, stagger } from "../ui";

export function Home() {
  const { me, go } = useApp();
  const { user, active } = me;
  const [packs, setPacks] = useState<Pack[] | null>(null);

  useEffect(() => {
    api
      .packs()
      .then((r) => setPacks(r.packs.filter((p) => p.status === "ready")))
      .catch(() => setPacks([]));
  }, []);

  return (
    <div className="screen">
      <div className="topbar">
        <div>
          <div className="muted small">Привет, {user.firstName || "друг"}</div>
          <h1 className="h1">Себяшка</h1>
        </div>
        <motion.button whileTap={{ scale: 0.95 }} className="chip" onClick={() => go({ name: "shop" })}>
          {user.isPro ? <Crown size={16} /> : <Gem size={16} />}
          {user.credits}
        </motion.button>
      </div>

      <Glass className="card" {...stagger(0)}>
        <HeroArt />
        <h2 className="h2">Стикеры из любого фото</h2>
        <p className="muted" style={{ margin: "6px 0 16px", lineHeight: 1.45 }}>
          Любое фото — ты, друг, питомец или персонаж — и через пару минут свой стикерпак в Telegram. 9 стилей и пожелания текстом.
        </p>
        {user.freePackAvailable ? (
          <Button icon={<Gift size={20} />} onClick={() => go({ name: "create" })}>
            Бесплатный мини-пак
          </Button>
        ) : (
          <Button icon={<Sparkles size={20} />} onClick={() => go({ name: "create" })}>
            Сделать стикеры
          </Button>
        )}
      </Glass>

      {active && (
        <Glass className="card tight" {...stagger(1)}>
          <button className="row" style={{ width: "100%", textAlign: "left" }} onClick={() => go({ name: "pack", id: active.id })}>
            <div className="tile-icon glass" style={{ width: 44, height: 44, borderRadius: 14, display: "grid", placeItems: "center" }}>
              <LoaderCircle size={20} className="spin" />
            </div>
            <div className="grow">
              <div style={{ fontWeight: 650 }}>{active.status === "needs_start" ? "Пак ждёт тебя" : "Собираю пак…"}</div>
              <div className="muted small">
                {active.styleTitle} · {active.done}/{active.total}
              </div>
            </div>
            <ChevronRight size={18} className="faint" />
          </button>
        </Glass>
      )}

      <div className="row between" style={{ marginTop: 6 }}>
        <h2 className="h2">Мои паки</h2>
        {!!packs?.length && <span className="faint small">{packsWord(packs.length)}</span>}
      </div>

      {packs === null ? (
        <div className="grid2">
          {[0, 1].map((i) => (
            <div key={i} className="glass shimmer" style={{ height: 172, borderRadius: 22 }} />
          ))}
        </div>
      ) : packs.length === 0 ? (
        <Glass className="card center" {...stagger(2)}>
          <EmptyArt />
          <div className="muted">
            Пока пусто. Первый пак — за наш счёт.
          </div>
        </Glass>
      ) : (
        <div className="grid2">
          {packs.map((p, i) => (
            <Glass key={p.id} className="tile" style={{ padding: 10 }} {...stagger(i + 2)} whileTap={{ scale: 0.97 }}>
              <button style={{ textAlign: "left" }} onClick={() => go({ name: "pack", id: p.id })}>
                <div className="sticker-cell" style={{ borderRadius: 16 }}>
                  {p.cover ? <img src={p.cover} alt="" loading="lazy" /> : <Image size={32} strokeWidth={1.6} className="faint" />}
                </div>
                <div style={{ fontWeight: 650, marginTop: 8, fontSize: 14 }}>{p.styleTitle}</div>
                <div className="faint small">{p.total} стикеров</div>
              </button>
            </Glass>
          ))}
        </div>
      )}
    </div>
  );
}
