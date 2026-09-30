import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const intFrom = (def: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(def);

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
    ROLE: z.enum(["all", "api", "worker"]).default("all"),
    PORT: intFrom(3000, 1, 65535),
    HOST: z.string().default("0.0.0.0"),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

    BOT_TOKEN: z.string().regex(/^\d+:[\w-]{30,}$/, "BOT_TOKEN выглядит неверно (формат 123456:ABC...)"),
    // Без @. Если не задан — берётся из getMe при старте.
    BOT_USERNAME: z.string().regex(/^[A-Za-z][\w]{3,31}$/).optional(),
    BOT_MODE: z.enum(["polling", "webhook"]).default("polling"),
    // Свой Bot API сервер (https://github.com/tdlib/telegram-bot-api) или тестовый стенд. По умолчанию — официальный.
    TELEGRAM_API_ROOT: z.string().url().default("https://api.telegram.org"),
    TELEGRAM_WEBHOOK_SECRET: z.string().regex(/^[\w-]{16,256}$/).optional(),
    // Короткое имя Main Mini App в BotFather не требуется: используем ссылку ?startapp.
    ADMIN_IDS: z
      .string()
      .default("")
      .transform((s) =>
        s
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean)
          .map((x) => Number(x))
          .filter((n) => Number.isSafeInteger(n) && n > 0),
      ),
    SUPPORT_USERNAME: z.string().default(""),
    // Какие алерты слать админам. Пусто = никакие.
    ADMIN_ALERTS: z
      .string()
      .default("new_user,invoice,payment,pack_created,pack_ready,pack_failed,system")
      .transform((s) => new Set(s.split(",").map((x) => x.trim()).filter(Boolean))),
    // Необязательно: id группы/канала для алертов (например -1001234567890). Бот должен быть там админом.
    ADMIN_CHAT_ID: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().int().optional()),

    // Публичный https-адрес, на котором висит сервер (нужен для webhook и мини-аппа).
    PUBLIC_URL: z.string().url().default("http://localhost:3000"),
    // Адрес мини-приложения (обычно = PUBLIC_URL).
    WEBAPP_URL: z.string().url().optional(),

    DATABASE_URL: z.string().min(1),
    DATA_DIR: z.string().default("./data"),
    // Секрет для подписи ссылок на картинки стикеров. Минимум 32 символа.
    SIGNING_SECRET: z.string().min(32),

    CRYPTOBOT_TOKEN: z.string().optional(),
    CRYPTOBOT_NETWORK: z.enum(["mainnet", "testnet"]).default("mainnet"),
    CRYPTOBOT_ASSETS: z.string().default("USDT,TON,BTC,ETH,LTC,TRX,USDC"),

    GEN_PROVIDER: z.enum(["mock", "fal", "replicate"]).default("mock"),
    FAL_KEY: z.string().optional(),
    FAL_MODEL: z.string().default("fal-ai/flux-pulid"),
    FAL_INPUT_TEMPLATE: z.string().optional(),
    REPLICATE_TOKEN: z.string().optional(),
    // owner/name для официальных моделей или owner/name:version
    REPLICATE_MODEL: z.string().optional(),
    REPLICATE_INPUT_TEMPLATE: z.string().optional(),
    BG_REMOVAL: z.enum(["local", "fal", "none"]).default("local"),
    FAL_BG_MODEL: z.string().default("fal-ai/birefnet"),
    GEN_TIMEOUT_SEC: intFrom(180, 10, 1800),

    STICKERS_PER_PACK: intFrom(16, 4, 24),
    FREE_PACK_SIZE: intFrom(6, 1, 12),
    GEN_CONCURRENCY: intFrom(3, 1, 16),
    WORKER_SLOTS: intFrom(2, 1, 16),
    SELFIE_TTL_HOURS: intFrom(24, 1, 720),
    MAX_UPLOAD_MB: intFrom(10, 1, 25),
    MIN_SUCCESS_RATIO: z.coerce.number().min(0.1).max(1).default(0.7),

    // Только для локальной разработки в браузере без Telegram.
    DEV_AUTH: bool,
  })
  .superRefine((c, ctx) => {
    if (c.BOT_MODE === "webhook" && !c.TELEGRAM_WEBHOOK_SECRET) {
      ctx.addIssue({ code: "custom", path: ["TELEGRAM_WEBHOOK_SECRET"], message: "обязателен при BOT_MODE=webhook" });
    }
    if (c.BOT_MODE === "webhook" && !c.PUBLIC_URL.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["PUBLIC_URL"], message: "для webhook нужен https" });
    }
    if (c.GEN_PROVIDER === "fal" && !c.FAL_KEY) {
      ctx.addIssue({ code: "custom", path: ["FAL_KEY"], message: "обязателен при GEN_PROVIDER=fal" });
    }
    if (c.BG_REMOVAL === "fal" && !c.FAL_KEY) {
      ctx.addIssue({ code: "custom", path: ["FAL_KEY"], message: "обязателен при BG_REMOVAL=fal" });
    }
    if (c.GEN_PROVIDER === "replicate" && (!c.REPLICATE_TOKEN || !c.REPLICATE_MODEL)) {
      ctx.addIssue({ code: "custom", path: ["REPLICATE_TOKEN"], message: "REPLICATE_TOKEN и REPLICATE_MODEL обязательны" });
    }
    if (c.NODE_ENV === "production" && c.DEV_AUTH) {
      ctx.addIssue({ code: "custom", path: ["DEV_AUTH"], message: "DEV_AUTH запрещён в production" });
    }
    if (c.NODE_ENV === "production" && c.GEN_PROVIDER === "mock") {
      // Не ошибка, но в проде почти наверняка забыли переключить провайдера.
      console.warn("[config] ВНИМАНИЕ: GEN_PROVIDER=mock в production — стикеры будут без ИИ.");
    }
  });

export type Config = z.infer<typeof schema> & { WEBAPP_URL: string };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Ошибка конфигурации (.env):\n${lines.join("\n")}`);
  }
  const c = parsed.data;
  return { ...c, WEBAPP_URL: c.WEBAPP_URL ?? c.PUBLIC_URL };
}
