import { createContext, useContext } from "react";
import type { Me } from "./api";

export type Route =
  | { name: "home" }
  | { name: "create" }
  | { name: "pack"; id: string }
  | { name: "shop"; reason?: string }
  | { name: "profile" }
  | { name: "admin" };

export interface AppState {
  me: Me;
  refresh: () => Promise<Me | null>;
  go: (r: Route) => void;
}

export const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppCtx);
  if (!v) throw new Error("AppCtx не инициализирован");
  return v;
}

/** Экран из ссылки бота: ?screen=create | shop | profile | pack:<id>. */
export function initialRoute(): Route {
  const s = new URLSearchParams(window.location.search).get("screen") ?? "";
  if (s === "create") return { name: "create" };
  if (s === "shop") return { name: "shop" };
  if (s === "profile") return { name: "profile" };
  if (s === "admin") return { name: "admin" };
  const m = /^pack:([0-9a-f-]{36})$/.exec(s);
  if (m) return { name: "pack", id: m[1]! };
  return { name: "home" };
}
