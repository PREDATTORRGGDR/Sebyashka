import { motion } from "motion/react";
import { Activity, Ban, Bitcoin, Crown, Layers, Minus, Plus, RefreshCw, Search, ShieldCheck, Star, TrendingUp, Users, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type AdminOverview, type AdminUser } from "../api";
import { StarsPrice } from "../art";
import { openTg } from "../telegram";
import { Button, Glass, stagger, useToast } from "../ui";

function Stat({ icon, label, value, sub, i }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; i: number }) {
  return (
    <Glass className="stat" {...stagger(i)}>
      <div className="row muted small" style={{ gap: 6 }}>
        {icon}
        {label}
      </div>
      <b>{value}</b>
      {sub && <div className="faint small">{sub}</div>}
    </Glass>
  );
}

const money = (n: number) => `$${n.toLocaleString("ru-RU", { maximumFractionDigits: 2 })}`;

export function Admin() {
  const toast = useToast();
  const [data, setData] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    try {
      setData(await api.admin.overview());
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось загрузить", "err");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function search() {
    if (!q.trim()) return;
    setBusy("search");
    try {
      setUsers((await api.admin.users(q.trim())).users);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Ошибка поиска", "err");
    } finally {
      setBusy(null);
    }
  }

  async function grant(u: AdminUser, delta: number) {
    setBusy(`g${u.id}${delta}`);
    try {
      const { balance } = await api.admin.grant(u.id, delta);
      setUsers((list) => list?.map((x) => (x.id === u.id ? { ...x, credits: balance } : x)) ?? null);
      toast(`Баланс ${u.firstName || u.id}: ${balance}`, "ok");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Ошибка", "err");
    } finally {
      setBusy(null);
    }
  }

  async function ban(u: AdminUser) {
    setBusy(`b${u.id}`);
    try {
      const { banned } = await api.admin.ban(u.id, !u.isBanned);
      setUsers((list) => list?.map((x) => (x.id === u.id ? { ...x, isBanned: banned } : x)) ?? null);
      toast(banned ? "Заблокирован" : "Разблокирован", "ok");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Ошибка", "err");
    } finally {
      setBusy(null);
    }
  }

  const s = data?.stats;
  const top = data?.funnel[0]?.users || 1;

  return (
    <div className="screen">
      <div className="topbar">
        <div>
          <div className="muted small row" style={{ gap: 6 }}>
            <ShieldCheck size={14} /> Только для админов
          </div>
          <h1 className="h1">Админка</h1>
        </div>
        <motion.button whileTap={{ scale: 0.9 }} className="chip" onClick={() => void load()} aria-label="Обновить">
          <RefreshCw size={16} className={loading ? "spin" : ""} />
        </motion.button>
      </div>

      {!s ? (
        <div className="grid2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="glass shimmer" style={{ height: 96, borderRadius: 20 }} />
          ))}
        </div>
      ) : (
        <div className="grid2">
          <Stat i={0} icon={<Users size={14} />} label="Пользователи" value={s.users.toLocaleString("ru-RU")} sub={`+${s.users24h} за сутки`} />
          <Stat i={1} icon={<TrendingUp size={14} />} label="Выручка" value={money(s.revenueUsd)} sub={`${money(s.revenue24hUsd)} за сутки`} />
          <Stat i={2} icon={<Wallet size={14} />} label="Платящие" value={s.payers} sub={`${s.ordersPaid} оплат · ${s.users ? ((s.payers / s.users) * 100).toFixed(1) : 0}%`} />
          <Stat i={3} icon={<Layers size={14} />} label="Паки" value={s.packsReady.toLocaleString("ru-RU")} sub={`провалено ${s.packsFailed} · в очереди ${s.inQueue}`} />
          <Stat i={4} icon={<Star size={14} />} label="Stars" value={s.starsTotal.toLocaleString("ru-RU")} sub={`≈ ${money(s.starsTotal * 0.013)} к выводу`} />
          <Stat i={5} icon={<Bitcoin size={14} />} label="Крипта" value={money(s.usdTotal)} sub={`${money(s.usd24h)} за сутки`} />
        </div>
      )}

      {data && (
        <Glass className="card col" style={{ gap: 12 }} {...stagger(6)}>
          <div className="row">
            <Activity size={18} />
            <b>Воронка за 7 дней</b>
          </div>
          {data.funnel.map((f) => (
            <div key={f.key} className="col" style={{ gap: 6 }}>
              <div className="row between small">
                <span className="muted">{f.label}</span>
                <span>
                  <b>{f.users}</b> <span className="faint">· {Math.round((f.users / top) * 100)}%</span>
                </span>
              </div>
              <div className="bar">
                <motion.div initial={{ width: 0 }} animate={{ width: `${Math.max(2, (f.users / top) * 100)}%` }} transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }} />
              </div>
            </div>
          ))}
        </Glass>
      )}

      <Glass className="card col" style={{ gap: 12 }} {...stagger(7)}>
        <div className="row">
          <Search size={18} />
          <b>Пользователь</b>
        </div>
        <div className="row">
          <input
            className="input"
            placeholder="ID, @username или имя"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void search()}
          />
          <Button size="sm" loading={busy === "search"} onClick={() => void search()}>
            Найти
          </Button>
        </div>
        {users?.length === 0 && <div className="faint small">Никого не нашли</div>}
        {users?.map((u) => (
          <div key={u.id} className="glass card tight col" style={{ gap: 10, boxShadow: "none" }}>
            <div className="row between">
              <button className="col" style={{ gap: 2, textAlign: "left" }} onClick={() => u.username && openTg(`https://t.me/${u.username}`)}>
                <b className="row" style={{ gap: 6 }}>
                  {u.firstName || "без имени"} {u.isPro && <Crown size={14} />} {u.isBanned && <Ban size={14} color="var(--danger)" />}
                </b>
                <span className="faint small">
                  {u.username ? `@${u.username} · ` : ""}
                  {u.id}
                </span>
              </button>
              <span className="chip">{u.credits}</span>
            </div>
            <div className="faint small">
              Паков: {u.packs} (готово {u.packsReady}) · оплат: {u.orders} · <StarsPrice value={u.paidStars} size={11} /> / ${u.paidUsd}
              {u.freePackUsed ? "" : " · бесплатный не использован"}
            </div>
            <div className="row" style={{ gap: 8 }}>
              <Button variant="ghost" size="sm" icon={<Minus size={14} />} loading={busy === `g${u.id}-1`} onClick={() => void grant(u, -1)}>
                1
              </Button>
              <Button variant="ghost" size="sm" icon={<Plus size={14} />} loading={busy === `g${u.id}1`} onClick={() => void grant(u, 1)}>
                1
              </Button>
              <Button variant="ghost" size="sm" icon={<Plus size={14} />} loading={busy === `g${u.id}5`} onClick={() => void grant(u, 5)}>
                5
              </Button>
              <div className="grow" />
              <Button variant="ghost" size="sm" icon={<Ban size={14} />} loading={busy === `b${u.id}`} onClick={() => void ban(u)}>
                {u.isBanned ? "Разбан" : "Бан"}
              </Button>
            </div>
          </div>
        ))}
      </Glass>

      {data && (
        <Glass className="col" style={{ gap: 0, overflow: "hidden" }} {...stagger(8)}>
          <div className="row" style={{ padding: "16px 16px 6px" }}>
            <Wallet size={18} />
            <b>Последние оплаты</b>
          </div>
          {data.payments.length === 0 && <div className="faint small" style={{ padding: 16 }}>Пока нет оплат</div>}
          {data.payments.map((p) => (
            <div key={p.id} className="list-item small">
              <div className="glass" style={{ width: 36, height: 36, borderRadius: 12, display: "grid", placeItems: "center", flexShrink: 0 }}>
                {p.provider === "stars" ? <Star size={16} /> : <Bitcoin size={16} />}
              </div>
              <div className="grow col" style={{ gap: 2 }}>
                <b>
                  {p.productId}
                  {p.recurring ? " · продление" : ""}
                  {p.refunded ? " · возврат" : ""}
                </b>
                <span className="faint">
                  {p.name} · {new Date(p.paidAt).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>
              <b>{p.stars ? <StarsPrice value={p.stars} /> : `$${p.usd}`}</b>
            </div>
          ))}
        </Glass>
      )}

      <div className="faint small center">Алерты о событиях приходят в бот · настроить: /alerts</div>
    </div>
  );
}
