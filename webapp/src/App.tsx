import { AnimatePresence, motion } from "motion/react";
import { CircleUser, House, RefreshCw, ShieldCheck, Sparkles, Store } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Me } from "./api";
import { ErrorArt, LoadingArt } from "./art";
import { Create } from "./screens/Create";
import { Home } from "./screens/Home";
import { PackView } from "./screens/PackView";
import { Profile } from "./screens/Profile";
import { Shop } from "./screens/Shop";
import { Admin } from "./screens/Admin";
import { AppCtx, initialRoute, type Route } from "./state";
import { haptic, tg } from "./telegram";
import { Button, Glass, pageMotion, spring, useToast } from "./ui";

const TABS = [
  { name: "home", label: "Главная", icon: House },
  { name: "create", label: "Создать", icon: Sparkles },
  { name: "shop", label: "Магазин", icon: Store },
  { name: "profile", label: "Профиль", icon: CircleUser },
] as const;

const ADMIN_TAB = { name: "admin", label: "Админ", icon: ShieldCheck } as const;

export function App() {
  const toast = useToast();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>(initialRoute);

  const refresh = useCallback(async () => {
    try {
      const data = await api.me();
      setMe(data);
      setError(null);
      return data;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось загрузить");
      return null;
    }
  }, []);

  useEffect(() => {
    void refresh().then((d) => d?.notices.forEach((n) => toast(n, "ok")));
    // Вернулись в приложение (например, после оплаты в @CryptoBot) - обновим баланс.
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const meRef = useRef(me);
  meRef.current = me;

  const go = useCallback((r: Route) => {
    haptic.select();
    // Пока пак собирается, «Создать» открывает его, а не новый.
    const active = meRef.current?.active;
    if (r.name === "create" && active) r = { name: "pack", id: active.id };
    setRoute(r);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  // Системная кнопка «Назад» Telegram на вложенных экранах.
  useEffect(() => {
    if (!tg) return;
    const back = () => go({ name: "home" });
    if (route.name === "pack") {
      tg.BackButton.show();
      tg.BackButton.onClick(back);
    } else tg.BackButton.hide();
    return () => tg?.BackButton.offClick(back);
  }, [route, go]);

  const ctx = useMemo(() => (me ? { me, refresh, go } : null), [me, refresh, go]);

  if (!me) {
    return (
      <div className="app">
        <div className="fullscreen-center">
          {error ? (
            <Glass className="card col center" style={{ gap: 14, maxWidth: 340 }} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
              <ErrorArt />
              <b>{error}</b>
              <Button icon={<RefreshCw size={18} />} onClick={() => void refresh()}>
                Повторить
              </Button>
            </Glass>
          ) : (
            <LoadingArt />
          )}
        </div>
      </div>
    );
  }

  const key = route.name === "pack" ? `pack-${route.id}` : route.name;

  return (
    <AppCtx.Provider value={ctx}>
      <div className="app">
        <AnimatePresence mode="wait">
          <motion.div key={key} {...pageMotion}>
            {route.name === "home" && <Home />}
            {route.name === "create" && <Create />}
            {route.name === "pack" && <PackView id={route.id} />}
            {route.name === "shop" && <Shop reason={route.reason} />}
            {route.name === "profile" && <Profile />}
            {route.name === "admin" && (me.user.isAdmin ? <Admin /> : <Home />)}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="nav-fade" aria-hidden />
      <nav className="nav glass">
        {(me.user.isAdmin ? [...TABS, ADMIN_TAB] : TABS).map((t) => {
          const active = route.name === t.name;
          const Icon = t.icon;
          return (
            <button key={t.name} className={active ? "active" : ""} onClick={() => go({ name: t.name })}>
              {active && <motion.div layoutId="nav-pill" className="pill" transition={spring} />}
              <Icon size={21} strokeWidth={active ? 2.4 : 2} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </nav>
    </AppCtx.Provider>
  );
}
