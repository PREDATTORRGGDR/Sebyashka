import { AnimatePresence, motion } from "motion/react";
import { CircleAlert, Hourglass, Plus, RefreshCw, Send, Share2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type Pack } from "../api";
import { useApp } from "../state";
import { haptic, openTg, share } from "../telegram";
import { Button, Glass, ProgressRing, spring, useToast } from "../ui";

const PHRASES = ["Изучаю черты лица…", "Подбираю эмоции…", "Рисую стикеры…", "Вырезаю фон…", "Добавляю обводку…", "Почти готово…"];

export function PackView({ id }: { id: string }) {
  const { me, refresh, go } = useApp();
  const toast = useToast();
  const [pack, setPack] = useState<Pack | null>(null);
  const [phrase, setPhrase] = useState(0);
  const prevStatus = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const { pack } = await api.pack(id);
        if (!alive) return;
        setPack(pack);
        const finished = pack.status === "ready" || pack.status === "failed";
        // Пак закончился, пока экран был закрыт: me.active устарел, иначе «Создать» будет вести сюда.
        if ((prevStatus.current && prevStatus.current !== pack.status) || (!prevStatus.current && finished && me.active?.id === pack.id)) {
          if (pack.status === "ready") haptic.ok();
          if (pack.status === "failed") haptic.err();
          void refresh();
        }
        prevStatus.current = pack.status;
        if (pack.status === "queued" || pack.status === "processing" || pack.status === "needs_start") {
          timer = setTimeout(load, document.hidden ? 8000 : 2500);
        }
      } catch (e) {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          toast("Пак не найден", "err");
          return go({ name: "home" });
        }
        timer = setTimeout(load, 5000);
      }
    };
    void load();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setPhrase((p) => (p + 1) % PHRASES.length), 2600);
    return () => clearInterval(t);
  }, []);

  if (!pack) {
    return (
      <div className="screen">
        <div className="glass shimmer" style={{ height: 240, borderRadius: 24 }} />
        <div className="glass shimmer" style={{ height: 180, borderRadius: 24 }} />
      </div>
    );
  }

  const inProgress = pack.status === "queued" || pack.status === "processing";
  const botLink = `https://t.me/${me.bot.username}`;

  return (
    <div className="screen">
      <div>
        <div className="muted small">{pack.styleTitle}</div>
        <h1 className="h1">
          {pack.status === "ready" ? "Готово!" : pack.status === "failed" ? "Не вышло" : pack.status === "needs_start" ? "Один шаг" : "Собираю пак"}
        </h1>
      </div>

      <AnimatePresence mode="wait">
        {inProgress && (
          <motion.div key="progress" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 0.96 }}>
            <Glass className="card center">
              <ProgressRing
                value={pack.done}
                total={pack.total}
                label={
                  <div>
                    <b>{Math.round((pack.done / Math.max(1, pack.total)) * 100)}%</b>
                    <span className="faint small">
                      {pack.done} из {pack.total}
                    </span>
                  </div>
                }
              />
              <AnimatePresence mode="wait">
                <motion.div
                  key={pack.status === "queued" ? "q" : phrase}
                  className="muted"
                  style={{ marginTop: 14, height: 22 }}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                >
                  {pack.status === "queued" ? (
                    <span className="row" style={{ justifyContent: "center", gap: 6 }}>
                      <Hourglass size={15} /> В очереди: {pack.queuePosition}
                    </span>
                  ) : (
                    PHRASES[phrase]
                  )}
                </motion.div>
              </AnimatePresence>
              <div className="faint small" style={{ marginTop: 6 }}>
                Можно закрыть приложение - пришлю, когда будет готово
              </div>
            </Glass>
          </motion.div>
        )}

        {pack.status === "ready" && (
          <motion.div key="ready" className="col" style={{ gap: 12 }} initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={spring}>
            <Button
              icon={<Plus size={20} />}
              onClick={() => {
                void api.track("add_stickers_click", { pack: pack.id });
                openTg(pack.addUrl!);
              }}
            >
              Добавить в Telegram
            </Button>
            <div className="grid2">
              <Button
                variant="ghost"
                icon={<Share2 size={18} />}
                onClick={() => {
                  void api.track("share", { from: "pack" });
                  share(me.user.referralLink, "Смотри, какие стикеры я сделал 😂 Сделай свои из любого фото бесплатно:");
                }}
              >
                Похвастаться
              </Button>
              <Button variant="ghost" icon={<Sparkles size={18} />} onClick={() => go({ name: "create" })}>
                Ещё стиль
              </Button>
            </div>
          </motion.div>
        )}

        {pack.status === "needs_start" && (
          <motion.div key="start" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Glass className="card col" style={{ gap: 14 }}>
              <div className="muted" style={{ lineHeight: 1.45 }}>
                Стикеры готовы, но Telegram разрешает создать пак только после того, как ты запустишь бота. Нажми кнопку, затем «Start» -
                и пак появится автоматически.
              </div>
              <Button icon={<Send size={18} />} onClick={() => openTg(`${botLink}?start=go`)}>
                Открыть бота
              </Button>
            </Glass>
          </motion.div>
        )}

        {pack.status === "failed" && (
          <motion.div key="failed" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Glass className="card col" style={{ gap: 14 }}>
              <div className="row">
                <CircleAlert color="var(--danger)" />
                <b>{pack.error ?? "Технический сбой"}</b>
              </div>
              <div className="muted small" style={{ lineHeight: 1.45 }}>
                {pack.isFree ? "Бесплатная попытка вернулась." : "Паки вернулись на баланс."} Лучше всего работает крупное фото при хорошем свете с одним героем в кадре.
              </div>
              <Button icon={<RefreshCw size={18} />} onClick={() => go({ name: "create" })}>
                Попробовать снова
              </Button>
            </Glass>
          </motion.div>
        )}
      </AnimatePresence>

      {(pack.stickers.length > 0 || inProgress) && (
        <div className="grid4">
          {Array.from({ length: pack.total }, (_, i) => {
            const s = pack.stickers.find((x) => x.idx === i);
            return (
              <div key={i} className={`sticker-cell ${s ? "" : "shimmer"}`}>
                <AnimatePresence>
                  {s && (
                    <motion.img
                      src={s.url}
                      alt={s.emoji}
                      initial={{ scale: 0.3, opacity: 0, rotate: -12 }}
                      animate={{ scale: 1, opacity: 1, rotate: 0 }}
                      transition={{ type: "spring", stiffness: 380, damping: 18 }}
                    />
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
