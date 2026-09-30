/**
 * Векторные иллюстрации интерфейса: монохромные SVG + стекло. Без эмодзи и растровых картинок —
 * одинаково чётко на любом экране, наследуют цвет темы (currentColor / CSS-переменные).
 */
import { motion } from "motion/react";
import { CloudOff, Crown, Heart, ImagePlus, Sparkles, Star, Zap, type LucideIcon } from "lucide-react";

/** Линейный портрет — фирменный знак «Себяшки». */
export function FaceMark({ size = 72, scan = false }: { size?: number; scan?: boolean }) {
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      {/* голова и волосы */}
      <path d="M20 34c0-10.5 7.2-18 16-18s16 7.5 16 18v4c0 10-7.2 18-16 18s-16-8-16-18v-4z" />
      <path d="M20.5 30c4-1.5 9-5.5 11-10 3.5 5 11 8.5 20 9.5" />
      {/* глаза */}
      <circle cx="29.5" cy="37" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="42.5" cy="37" r="1.6" fill="currentColor" stroke="none" />
      {/* улыбка */}
      <path d="M29 45.5c3.8 3.4 10.2 3.4 14 0" />
      {/* рамка-видоискатель */}
      <path d="M6 18V10a4 4 0 0 1 4-4h8M54 6h8a4 4 0 0 1 4 4v8M66 54v8a4 4 0 0 1-4 4h-8M18 66h-8a4 4 0 0 1-4-4v-8" strokeWidth="2" opacity="0.55" />
      {scan && (
        <motion.line
          x1="8"
          x2="64"
          stroke="currentColor"
          strokeWidth="2"
          opacity="0.8"
          initial={{ y1: 12, y2: 12 }}
          animate={{ y1: [12, 60, 12], y2: [12, 60, 12] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
        />
      )}
    </svg>
  );
}

const ORBIT: { Icon: LucideIcon; x: string; y: number; r: number; d: number }[] = [
  { Icon: Heart, x: "6%", y: 26, r: -12, d: 0 },
  { Icon: Zap, x: "20%", y: 104, r: 8, d: 0.8 },
  { Icon: Sparkles, x: "76%", y: 18, r: 10, d: 0.4 },
  { Icon: Crown, x: "70%", y: 100, r: -8, d: 1.2 },
];

/** Герой главного экрана: портрет в стеклянном круге и «стикеры»-плитки на орбите. */
export function HeroArt() {
  return (
    <div className="hero-art" aria-hidden>
      <motion.svg
        className="hero-orbit"
        viewBox="0 0 200 200"
        animate={{ rotate: 360 }}
        transition={{ duration: 60, repeat: Infinity, ease: "linear" }}
      >
        <circle cx="100" cy="100" r="92" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeDasharray="2 7" strokeWidth="1.5" />
        <circle cx="100" cy="100" r="66" fill="none" stroke="currentColor" strokeOpacity="0.1" strokeWidth="1" />
      </motion.svg>

      <motion.div
        className="hero-core glass"
        initial={{ scale: 0.7, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
      >
        <FaceMark size={68} scan />
      </motion.div>

      {ORBIT.map(({ Icon, x, y, r, d }, i) => (
        <motion.div
          key={i}
          className="hero-tile glass"
          style={{ left: x, top: y, rotate: r }}
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1, y: [0, -7, 0] }}
          transition={{
            opacity: { delay: 0.15 + i * 0.08 },
            scale: { delay: 0.15 + i * 0.08, type: "spring", stiffness: 300, damping: 16 },
            y: { delay: d, duration: 4.2, repeat: Infinity, ease: "easeInOut" },
          }}
        >
          <Icon size={24} strokeWidth={2.2} />
        </motion.div>
      ))}
    </div>
  );
}

/** Пустое состояние: стопка стеклянных карточек. */
export function EmptyArt() {
  return (
    <div className="empty-art" aria-hidden>
      {[-10, 0, 10].map((r, i) => (
        <motion.div
          key={r}
          className="glass"
          style={{ rotate: r, zIndex: i }}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * 0.08, type: "spring", stiffness: 260, damping: 20 }}
        >
          {i === 2 && <ImagePlus size={26} strokeWidth={1.8} />}
        </motion.div>
      ))}
    </div>
  );
}

/** Экран загрузки. */
export function LoadingArt() {
  return (
    <motion.div
      className="glass state-art"
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: [1, 1.04, 1] }}
      transition={{ scale: { duration: 2, repeat: Infinity, ease: "easeInOut" }, opacity: { duration: 0.3 } }}
    >
      <FaceMark size={64} scan />
    </motion.div>
  );
}

export function ErrorArt() {
  return (
    <div className="glass state-art">
      <CloudOff size={40} strokeWidth={1.8} />
    </div>
  );
}

/** Цена в Stars: SVG-звезда вместо эмодзи. */
export function StarsPrice({ value, size = 14 }: { value: number; size?: number }) {
  return (
    <span className="row" style={{ gap: 4, display: "inline-flex" }}>
      <Star size={size} fill="currentColor" strokeWidth={0} />
      {value}
    </span>
  );
}
