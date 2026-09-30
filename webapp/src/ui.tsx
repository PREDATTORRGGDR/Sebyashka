import { AnimatePresence, motion, type HTMLMotionProps } from "motion/react";
import { CircleAlert, CircleCheck, LoaderCircle } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { haptic } from "./telegram";

export const spring = { type: "spring", stiffness: 420, damping: 32 } as const;

export const pageMotion = {
  initial: { opacity: 0, y: 14, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  exit: { opacity: 0, y: -10, filter: "blur(6px)" },
  transition: { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
} as const;

/** Появление элементов списка с каскадной задержкой. */
export const stagger = (i: number) => ({
  initial: { opacity: 0, y: 12, scale: 0.98 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { delay: 0.04 * i, ...spring },
});

type BtnProps = HTMLMotionProps<"button"> & {
  variant?: "primary" | "ghost";
  size?: "md" | "sm";
  loading?: boolean;
  icon?: ReactNode;
};

export function Button({ variant = "primary", size = "md", loading, icon, children, className = "", disabled, onClick, ...rest }: BtnProps) {
  return (
    <motion.button
      whileTap={disabled || loading ? undefined : { scale: 0.965 }}
      transition={spring}
      className={`btn ${variant} ${size === "sm" ? "sm" : ""} ${className}`}
      disabled={disabled || loading}
      onClick={(e) => {
        haptic.tap();
        onClick?.(e);
      }}
      {...rest}
    >
      {loading ? <LoaderCircle size={20} className="spin" /> : icon}
      {children as ReactNode}
    </motion.button>
  );
}

export function Glass({ children, className = "", ...rest }: HTMLMotionProps<"div">) {
  return (
    <motion.div className={`glass ${className}`} {...rest}>
      {children}
    </motion.div>
  );
}

export function Segment<T extends string>({
  value,
  options,
  onChange,
  id,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  id: string;
}) {
  return (
    <div className="segment glass">
      {options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? "active" : ""}
          onClick={() => {
            haptic.select();
            onChange(o.value);
          }}
        >
          {value === o.value && <motion.div layoutId={`seg-${id}`} className="pill" transition={spring} />}
          <span className="row" style={{ gap: 6 }}>
            {o.label}
          </span>
        </button>
      ))}
    </div>
  );
}

export function ProgressRing({ value, total, label }: { value: number; total: number; label: ReactNode }) {
  const r = 74;
  const c = 2 * Math.PI * r;
  const pct = total ? Math.min(1, value / total) : 0;
  return (
    <div className="ring">
      <svg width="168" height="168" viewBox="0 0 168 168">
        <circle cx="84" cy="84" r={r} stroke="var(--glass-strong)" strokeWidth="10" fill="none" />
        <motion.circle
          cx="84"
          cy="84"
          r={r}
          stroke="var(--accent)"
          strokeWidth="10"
          strokeLinecap="round"
          fill="none"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
        />
      </svg>
      <div className="value">{label}</div>
    </div>
  );
}

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
      <div className="orb a" />
      <div className="orb b" />
      <div className="orb c" />
      <div className="grain" />
    </div>
  );
}

/* ---------------- тосты ---------------- */

interface Toast {
  id: number;
  text: string;
  kind: "ok" | "err" | "info";
}

const ToastCtx = createContext<(text: string, kind?: Toast["kind"]) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);
  const push = useCallback((text: string, kind: Toast["kind"] = "info") => {
    const id = ++idRef.current;
    if (kind === "ok") haptic.ok();
    if (kind === "err") haptic.err();
    setToasts((t) => [...t.slice(-2), { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap">
        <AnimatePresence>
          {toasts.slice(-1).map((t) => (
            <motion.div
              key={t.id}
              className="toast glass"
              initial={{ opacity: 0, y: -24, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -24, scale: 0.95 }}
              transition={spring}
              onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}
            >
              {t.kind === "ok" ? (
                <CircleCheck size={18} color="var(--ok)" />
              ) : t.kind === "err" ? (
                <CircleAlert size={18} color="var(--danger)" />
              ) : null}
              {t.text}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export const packsWord = (n: number) => `${n} ${plural(n, "пак", "пака", "паков")}`;
