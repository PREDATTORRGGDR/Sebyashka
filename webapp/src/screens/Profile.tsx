import { motion } from "motion/react";
import { Check, ChevronRight, Copy, Crown, FileText, Gift, LifeBuoy, Share2, Ticket, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { useApp } from "../state";
import { openTg, share } from "../telegram";
import { Button, Glass, packsWord, stagger, useToast } from "../ui";

export function Profile() {
  const { me, refresh, go } = useApp();
  const toast = useToast();
  const { user, bot } = me;
  const [code, setCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [gifts, setGifts] = useState<{ link: string; redeemed: boolean }[]>([]);

  useEffect(() => {
    api.gifts().then((r) => setGifts(r.gifts)).catch(() => {});
  }, []);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast("Скопировано", "ok");
    } catch {
      toast(text, "info");
    }
  }

  async function redeem() {
    const c = code.trim().replace(/^.*gift_/, "").toLowerCase();
    if (!c) return;
    setRedeeming(true);
    try {
      const r = await api.redeem(c);
      setCode("");
      await refresh();
      toast(`+${packsWord(r.credits)} на баланс!`, "ok");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось активировать", "err");
    } finally {
      setRedeeming(false);
    }
  }

  return (
    <div className="screen">
      <Glass className="card row" {...stagger(0)}>
        <div
          className="inverted"
          style={{ width: 60, height: 60, borderRadius: 22, display: "grid", placeItems: "center", fontSize: 26, fontWeight: 700 }}
        >
          {(user.firstName || "?").slice(0, 1).toUpperCase()}
        </div>
        <div className="grow">
          <div className="row" style={{ gap: 8 }}>
            <b style={{ fontSize: 20, letterSpacing: "-0.02em" }}>{user.firstName || "Без имени"}</b>
            {user.isPro && (
              <span className="badge">
                <Crown size={11} /> Pro
              </span>
            )}
          </div>
          <div className="muted small">На балансе {packsWord(user.credits)}</div>
        </div>
        <Button size="sm" onClick={() => go({ name: "shop" })}>
          Пополнить
        </Button>
      </Glass>

      <Glass className="card col" style={{ gap: 12 }} {...stagger(1)}>
        <div className="row">
          <Users size={20} />
          <b>Пригласи 3 друзей - получи пак</b>
        </div>
        <div className="muted small" style={{ lineHeight: 1.45 }}>
          За каждых 3 друзей, пришедших по ссылке, - +1 пак. И ещё +1, когда друг сделает первую покупку.
        </div>
        <div className="row">
          <div className="input row" style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis", fontSize: 13 }}>
            <span className="muted" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {user.referralLink.replace("https://", "")}
            </span>
          </div>
          <motion.button whileTap={{ scale: 0.9 }} className="btn ghost sm" style={{ width: 48, padding: 0 }} onClick={() => void copy(user.referralLink)}>
            <Copy size={18} />
          </motion.button>
        </div>
        <Button
          icon={<Share2 size={18} />}
          onClick={() => {
            void api.track("ref_share");
            share(user.referralLink, "Делаю стикеры из любого фото - попробуй бесплатно 😎");
          }}
        >
          Отправить друзьям
        </Button>
      </Glass>

      <Glass className="card col" style={{ gap: 12 }} {...stagger(2)}>
        <div className="row">
          <Ticket size={20} />
          <b>Есть подарочный код?</b>
        </div>
        <div className="row">
          <input className="input" placeholder="Код или ссылка" value={code} onChange={(e) => setCode(e.target.value)} maxLength={80} />
          <Button size="sm" loading={redeeming} disabled={!code.trim()} onClick={() => void redeem()}>
            OK
          </Button>
        </div>
      </Glass>

      {gifts.length > 0 && (
        <Glass className="card col" style={{ gap: 4 }} {...stagger(3)}>
          <div className="row" style={{ marginBottom: 6 }}>
            <Gift size={20} />
            <b>Мои подарки</b>
          </div>
          {gifts.map((g) => (
            <div key={g.link} className="row between small" style={{ padding: "8px 0" }}>
              <span className={`row ${g.redeemed ? "faint" : ""}`} style={{ gap: 6 }}>
                {g.redeemed ? <><Check size={14} /> Подарок получен</> : "Ждёт получателя"}
              </span>
              {!g.redeemed && (
                <Button variant="ghost" size="sm" icon={<Share2 size={14} />} onClick={() => share(g.link, "Дарю тебе стикерпак - сделай из любого фото 🎁")}>
                  Отправить
                </Button>
              )}
            </div>
          ))}
        </Glass>
      )}

      <Glass className="col" style={{ gap: 0, overflow: "hidden" }} {...stagger(4)}>
        {bot.support && (
          <button className="list-item" onClick={() => openTg(`https://t.me/${bot.support}`)}>
            <LifeBuoy size={18} />
            <span className="grow">Поддержка</span>
            <ChevronRight size={16} className="faint" />
          </button>
        )}
        <button className="list-item" onClick={() => openTg(`https://t.me/${bot.username}?start=terms`)}>
          <FileText size={18} />
          <span className="grow">Условия и приватность</span>
          <ChevronRight size={16} className="faint" />
        </button>
      </Glass>

      <div className="faint small center">Фото удаляются через 24 часа · ID {user.id}</div>
    </div>
  );
}
