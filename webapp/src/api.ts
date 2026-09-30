import { authHeader } from "./telegram";

export interface Style {
  id: string;
  title: string;
  description: string;
  premium: boolean;
}

export interface Product {
  id: string;
  kind: "credits" | "pro" | "gift";
  title: string;
  description: string;
  credits: number;
  stars: number;
  usd: string;
  days?: number;
  badge?: string;
}

export interface User {
  id: number;
  isAdmin: boolean;
  firstName: string;
  credits: number;
  freePackAvailable: boolean;
  isPro: boolean;
  proUntil: string | null;
  hasSelfie: boolean;
  hasStartedBot: boolean;
  referralLink: string;
}

export type PackStatus = "queued" | "processing" | "needs_start" | "ready" | "failed";

export interface Pack {
  id: string;
  styleId: string;
  styleTitle: string;
  status: PackStatus;
  total: number;
  done: number;
  isFree: boolean;
  title: string;
  wish: string | null;
  addUrl: string | null;
  error: string | null;
  queuePosition: number;
  createdAt: string;
  cover: string | null;
  stickers: { idx: number; emoji: string; url: string }[];
}

export interface Me {
  user: User;
  active: Pack | null;
  notices: string[];
  catalog: { styles: Style[]; products: Product[]; freePackSize: number; packSize: number; emotions: string[]; cryptoEnabled: boolean; wishMaxLen: number };
  bot: { username: string; support: string };
}

export interface AdminOverview {
  stats: {
    users: number;
    users24h: number;
    payers: number;
    packsReady: number;
    packsFailed: number;
    inQueue: number;
    ordersPaid: number;
    starsTotal: number;
    stars24h: number;
    usdTotal: number;
    usd24h: number;
    revenueUsd: number;
    revenue24hUsd: number;
  };
  funnel: { key: string; label: string; users: number }[];
  payments: { id: string; userId: number; name: string; productId: string; provider: string; stars: number | null; usd: string | null; paidAt: string; recurring: boolean; refunded: boolean }[];
}

export interface AdminUser {
  id: number;
  username: string | null;
  firstName: string;
  credits: number;
  isPro: boolean;
  freePackUsed: boolean;
  isBanned: boolean;
  paidStars: number;
  paidUsd: number;
  packs: number;
  packsReady: number;
  orders: number;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown | FormData): Promise<T> {
  const auth = authHeader();
  if (!auth) throw new ApiError("NO_TELEGRAM", "Открой приложение из Telegram", 401);
  const headers: Record<string, string> = { Authorization: auth };
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    throw new ApiError("NETWORK", "Нет соединения. Проверь интернет", 0);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(data.error ?? "HTTP", data.message ?? `Ошибка ${res.status}`, res.status);
  return data as T;
}

export const api = {
  me: () => request<Me>("POST", "/api/me"),
  uploadSelfie: (file: Blob) => {
    const fd = new FormData();
    fd.append("photo", file, "selfie.jpg");
    return request<{ ok: true }>("POST", "/api/selfie", fd);
  },
  createPack: (styleId: string, free: boolean, wish: string) => request<{ pack: Pack }>("POST", "/api/packs", { styleId, free, wish: wish || null }),
  packs: () => request<{ packs: Pack[] }>("GET", "/api/packs"),
  pack: (id: string) => request<{ pack: Pack }>("GET", `/api/packs/${id}`),
  order: (productId: string, provider: "stars" | "cryptobot") =>
    request<{ orderId: string; url: string }>("POST", "/api/orders", { productId, provider }),
  orderStatus: (id: string) => request<{ status: string; productId: string; giftLink: string | null }>("GET", `/api/orders/${id}`),
  redeem: (code: string) => request<{ credits: number; balance: number }>("POST", "/api/gifts/redeem", { code }),
  gifts: () => request<{ gifts: { link: string; redeemed: boolean; createdAt: string }[] }>("GET", "/api/gifts"),
  admin: {
    overview: () => request<AdminOverview>("GET", "/api/admin/overview"),
    users: (q: string) => request<{ users: AdminUser[] }>("GET", `/api/admin/users?q=${encodeURIComponent(q)}`),
    grant: (id: number, delta: number) => request<{ balance: number }>("POST", `/api/admin/users/${id}/grant`, { delta }),
    ban: (id: number, banned: boolean) => request<{ banned: boolean }>("POST", `/api/admin/users/${id}/ban`, { banned }),
  },
  track: (name: string, props: Record<string, string | number | boolean> = {}) =>
    request("POST", "/api/events", { name, props }).catch(() => {}),
};

/** Сжатие фото на клиенте: быстрее загрузка на мобильном интернете, меньше отказов по размеру. */
export async function compressImage(file: File, maxSide = 1280): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", 0.9));
    return blob ?? file;
  } catch {
    return file; // HEIC и прочее, что браузер не декодирует, - пусть разбирается сервер
  }
}
