/** Минимальная типизация Telegram.WebApp — только то, что используем. */
type InvoiceStatus = "paid" | "cancelled" | "failed" | "pending";

interface TgButton {
  show(): void;
  hide(): void;
  onClick(cb: () => void): void;
  offClick(cb: () => void): void;
}

interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name?: string }; start_param?: string };
  version: string;
  platform: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  close(): void;
  isVersionAtLeast(v: string): boolean;
  setHeaderColor?(c: string): void;
  setBackgroundColor?(c: string): void;
  setBottomBarColor?(c: string): void;
  disableVerticalSwipes?(): void;
  openInvoice(url: string, cb?: (status: InvoiceStatus) => void): void;
  openTelegramLink(url: string): void;
  openLink(url: string): void;
  requestWriteAccess?(cb?: (granted: boolean) => void): void;
  onEvent(e: string, cb: () => void): void;
  offEvent(e: string, cb: () => void): void;
  BackButton: TgButton;
  HapticFeedback?: {
    impactOccurred(s: "light" | "medium" | "heavy" | "rigid" | "soft"): void;
    notificationOccurred(t: "error" | "success" | "warning"): void;
    selectionChanged(): void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp: TgWebApp };
  }
}

export const tg: TgWebApp | null = window.Telegram?.WebApp?.initData ? window.Telegram.WebApp : null;

const devUser = import.meta.env.VITE_DEV_USER as string | undefined;

export function authHeader(): string | null {
  if (tg?.initData) return `tma ${tg.initData}`;
  if (import.meta.env.DEV && devUser) return `tma dev:${devUser}`;
  return null;
}

export function initTelegram(dark: boolean): void {
  if (!tg) return;
  tg.ready();
  tg.expand();
  const bg = dark ? "#050505" : "#f4f4f5";
  try {
    if (tg.isVersionAtLeast("6.1")) {
      tg.setHeaderColor?.(bg);
      tg.setBackgroundColor?.(bg);
    }
    if (tg.isVersionAtLeast("7.10")) tg.setBottomBarColor?.(bg);
    if (tg.isVersionAtLeast("7.7")) tg.disableVerticalSwipes?.();
  } catch {
    /* старые клиенты */
  }
}

export const haptic = {
  tap: () => tg?.HapticFeedback?.impactOccurred("light"),
  select: () => tg?.HapticFeedback?.selectionChanged(),
  ok: () => tg?.HapticFeedback?.notificationOccurred("success"),
  err: () => tg?.HapticFeedback?.notificationOccurred("error"),
};

export function openTg(url: string): void {
  if (tg) tg.openTelegramLink(url);
  else window.open(url, "_blank");
}

export function share(url: string, text: string): void {
  openTg(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
}

export function payInvoice(url: string): Promise<InvoiceStatus> {
  return new Promise((resolve) => {
    if (!tg) {
      window.open(url, "_blank");
      resolve("pending");
      return;
    }
    tg.openInvoice(url, resolve);
  });
}

export function requestWriteAccess(): Promise<boolean> {
  return new Promise((resolve) => {
    if (!tg?.requestWriteAccess || !tg.isVersionAtLeast("6.9")) return resolve(true);
    tg.requestWriteAccess((granted) => resolve(granted));
  });
}

export function prefersDark(): boolean {
  if (tg) return tg.colorScheme === "dark";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}
