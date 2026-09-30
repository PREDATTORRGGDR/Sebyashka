import { AnimatePresence, motion } from "motion/react";
import {
  Box,
  Brush,
  Camera,
  Check,
  Cpu,
  Crown,
  Gift,
  Grid3x3,
  Heart,
  Image as ImageIcon,
  Palette,
  PawPrint,
  PenLine,
  RefreshCw,
  ScanFace,
  Shapes,
  Sparkles,
  SunMedium,
  Zap,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { api, ApiError, compressImage } from "../api";
import { useApp } from "../state";
import { haptic, requestWriteAccess } from "../telegram";
import { Button, Glass, packsWord, pageMotion, spring, stagger, useToast } from "../ui";

const STYLE_ICONS: Record<string, ReactNode> = {
  original: <ImageIcon size={20} />,
  cartoon3d: <Box size={20} />,
  anime: <Sparkles size={20} />,
  comic: <Zap size={20} />,
  chibi: <Heart size={20} />,
  pixel: <Grid3x3 size={20} />,
  clay: <Shapes size={20} />,
  cyberpunk: <Cpu size={20} />,
  watercolor: <Palette size={20} />,
};

const TIPS = [
  { icon: <ScanFace size={16} />, text: "Ты, друг или любой персонаж" },
  { icon: <PawPrint size={16} />, text: "Питомцы тоже подходят" },
  { icon: <SunMedium size={16} />, text: "Крупно и при хорошем свете" },
  { icon: <Shapes size={16} />, text: "Один герой в кадре" },
];

const WISH_IDEAS = ["в костюме супергероя", "с гитарой", "в очках и кепке", "в космосе", "с чашкой кофе"];

export function Create() {
  const { me, refresh, go } = useApp();
  const toast = useToast();
  const { user, catalog } = me;
  const [step, setStep] = useState<"photo" | "style">(user.hasSelfie ? "style" : "photo");
  const [preview, setPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [styleId, setStyleId] = useState<string>(catalog.styles[0]?.id ?? "");
  const [wish, setWish] = useState("");
  const [creating, setCreating] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const style = catalog.styles.find((s) => s.id === styleId);
  const admin = user.isAdmin;
  const cost = !style ? 1 : style.premium && !user.isPro ? 2 : 1;
  const useFree = !admin && user.freePackAvailable && !!style && !style.premium;

  async function onFile(f: File | undefined) {
    if (!f) return;
    if (!f.type.startsWith("image/") && !/\.(heic|heif)$/i.test(f.name)) return toast("Нужна картинка", "err");
    setPreview(URL.createObjectURL(f));
    setUploading(true);
    try {
      const blob = await compressImage(f);
      await api.uploadSelfie(blob);
      await refresh();
      haptic.ok();
      setStep("style");
    } catch (e) {
      setPreview(null);
      toast(e instanceof ApiError ? e.message : "Не удалось загрузить фото", "err");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function create() {
    if (!style) return;
    if (!admin && !useFree && user.credits < cost) {
      void api.track("paywall_view", { from: "create", style: style.id });
      toast(`Нужно ${packsWord(cost)} - пополни баланс`, "info");
      return go({ name: "shop", reason: "credits" });
    }
    setCreating(true);
    try {
      // Разрешение писать в личку: без него Telegram не даст создать пак на имя пользователя.
      if (!user.hasStartedBot) await requestWriteAccess();
      const { pack } = await api.createPack(style.id, useFree, wish.trim());
      await refresh();
      go({ name: "pack", id: pack.id });
    } catch (e) {
      const err = e instanceof ApiError ? e : null;
      if (err?.code === "SELFIE_EXPIRED" || err?.code === "NO_SELFIE") setStep("photo");
      if (err?.code === "PACK_IN_PROGRESS" && me.active) return go({ name: "pack", id: me.active.id });
      if (err?.code === "NOT_ENOUGH_CREDITS") return go({ name: "shop", reason: "credits" });
      toast(err?.message ?? "Не получилось, попробуй ещё раз", "err");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="screen">
      <div className="col" style={{ gap: 12 }}>
        <div className="steps">
          <span className="on" />
          <span className={step === "style" ? "on" : ""} />
          <span />
        </div>
        <h1 className="h1">{step === "photo" ? "Загрузи фото" : "Выбери стиль"}</h1>
      </div>

      <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => void onFile(e.target.files?.[0])} />

      <AnimatePresence mode="wait">
        {step === "photo" ? (
          <motion.div key="photo" className="col" style={{ gap: 16 }} {...pageMotion}>
            <Glass className="card">
              <button className="dropzone" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {preview ? (
                  <motion.img src={preview} className="avatar-xl" initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={spring} />
                ) : (
                  <motion.div
                    className="glass"
                    style={{ width: 96, height: 96, borderRadius: 32, display: "grid", placeItems: "center" }}
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <Camera size={36} />
                  </motion.div>
                )}
                <div style={{ fontWeight: 650, fontSize: 17 }}>{uploading ? "Загружаю…" : "Сделай снимок или выбери из галереи"}</div>
                <div className="muted small">Любое фото или картинка · удаляется через 24 часа</div>
              </button>
            </Glass>

            <div className="grid2">
              {TIPS.map((t, i) => (
                <Glass key={t.text} className="card tight row small" {...stagger(i)}>
                  <span className="muted">{t.icon}</span>
                  {t.text}
                </Glass>
              ))}
            </div>

            <Button loading={uploading} icon={<Camera size={20} />} onClick={() => fileRef.current?.click()}>
              Загрузить фото
            </Button>
            <div className="faint small center">Чужие фото - только с согласия человека</div>
          </motion.div>
        ) : (
          <motion.div key="style" className="col" style={{ gap: 16 }} {...pageMotion}>
            <Glass className="card tight row between">
              <div className="row">
                <div className="glass" style={{ width: 40, height: 40, borderRadius: 14, display: "grid", placeItems: "center" }}>
                  <Check size={18} />
                </div>
                <div>
                  <div style={{ fontWeight: 650 }}>Фото загружено</div>
                  <div className="faint small">Можно заменить в любой момент</div>
                </div>
              </div>
              <Button variant="ghost" size="sm" icon={<RefreshCw size={15} />} onClick={() => setStep("photo")}>
                Заменить
              </Button>
            </Glass>

            <div className="grid2">
              {catalog.styles.map((s, i) => (
                <Glass
                  key={s.id}
                  className={`tile ${styleId === s.id ? "selected" : ""}`}
                  {...stagger(i)}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => {
                    haptic.select();
                    setStyleId(s.id);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  <div className="row between">
                    <div className="icon">{STYLE_ICONS[s.id] ?? <Brush size={20} />}</div>
                    {s.premium && (
                      <span className="badge outline">
                        <Crown size={11} /> {user.isPro ? "Pro" : "×2"}
                      </span>
                    )}
                  </div>
                  <div style={{ fontWeight: 650 }}>{s.title}</div>
                  <div className="faint small" style={{ lineHeight: 1.35 }}>
                    {s.description}
                  </div>
                </Glass>
              ))}
            </div>

            <Glass className="card col" style={{ gap: 10 }}>
              <div className="row">
                <PenLine size={18} />
                <b>Пожелание</b>
                <span className="faint small">необязательно</span>
              </div>
              <textarea
                className="input textarea"
                placeholder="Например: в костюме супергероя"
                value={wish}
                maxLength={catalog.wishMaxLen}
                onChange={(e) => setWish(e.target.value)}
                rows={2}
              />
              <div className="chips-row">
                {WISH_IDEAS.map((w) => (
                  <motion.button
                    key={w}
                    whileTap={{ scale: 0.94 }}
                    className={`chip sm ${wish === w ? "on" : ""}`}
                    onClick={() => {
                      haptic.select();
                      setWish(wish === w ? "" : w);
                    }}
                  >
                    {w}
                  </motion.button>
                ))}
              </div>
            </Glass>

            <Glass className="card col" style={{ gap: 12 }}>
              <div className="row between">
                <span className="muted">Стикеров в паке</span>
                <b>{useFree ? catalog.freePackSize : catalog.packSize}</b>
              </div>
              <div className="row between">
                <span className="muted">Стоимость</span>
                <b>{admin ? "Бесплатно (админ)" : useFree ? "Бесплатно" : packsWord(cost)}</b>
              </div>
              {!useFree && !admin && (
                <div className="row between">
                  <span className="muted">На балансе</span>
                  <b>{packsWord(user.credits)}</b>
                </div>
              )}
              {!admin && user.freePackAvailable && style?.premium && (
                <div className="faint small">Бесплатный мини-пак доступен в обычных стилях. Премиум - за паки с баланса.</div>
              )}
            </Glass>

            <Button loading={creating} icon={useFree ? <Gift size={20} /> : <Sparkles size={20} />} onClick={() => void create()}>
              {admin || useFree ? "Сделать бесплатно" : user.credits >= cost ? "Сделать пак" : "Пополнить и сделать"}
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
