import { Bot } from "grammy";
import { buildServer } from "./api/server.js";
import { loadConfig } from "./config.js";
import { createDb, migrate } from "./db/client.js";
import { createBgRemover, createGenerator } from "./generation/providers.js";
import { runWorker } from "./generation/pipeline.js";
import { createLogger } from "./logger.js";
import { cleanup } from "./maintenance.js";
import { PaymentService } from "./payments/service.js";
import { Storage, UrlSigner } from "./storage.js";
import { configureBotProfile, setupBot } from "./telegram/bot.js";
import { BotApiGateway } from "./telegram/gateway.js";
import { AdminNotifier } from "./admin/notifier.js";
import { esc } from "./texts.js";

async function main() {
  const cfg = loadConfig();
  const log = createLogger(cfg.LOG_LEVEL);
  const sql = createDb(cfg.DATABASE_URL);
  await migrate(sql, (m) => log.info(m));

  const bot = new Bot(cfg.BOT_TOKEN, { client: { apiRoot: cfg.TELEGRAM_API_ROOT } });
  await bot.init(); // getMe: проверяет токен
  const botUsername = cfg.BOT_USERNAME ?? bot.botInfo.username;
  log.info({ bot: botUsername, role: cfg.ROLE, provider: cfg.GEN_PROVIDER }, "старт");

  const storage = new Storage(cfg.DATA_DIR);
  const signer = new UrlSigner(cfg.SIGNING_SECRET);
  const tg = new BotApiGateway(bot.api);
  const notifier = new AdminNotifier(bot.api, sql, cfg, log);
  const payments = new PaymentService(sql, bot.api, cfg, tg, log, botUsername, notifier);

  if (payments.crypto) {
    try {
      const me = await payments.crypto.getMe();
      log.info({ app: me.name }, "CryptoBot подключён");
    } catch (e) {
      log.error({ err: (e as Error).message }, "CryptoBot: токен не работает — крипто-оплата будет падать");
    }
  }

  // Системные алерты (сломался провайдер ИИ и т.п.) — не чаще раза в 10 минут, чтобы не заспамить.
  let lastAlert = 0;
  const alert = (msg: string) => {
    if (Date.now() - lastAlert < 10 * 60_000) return;
    lastAlert = Date.now();
    notifier.notify("system", esc(msg));
  };

  const abort = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  const tasks: Promise<unknown>[] = [];
  let server: Awaited<ReturnType<typeof buildServer>> | null = null;

  if (cfg.ROLE === "all" || cfg.ROLE === "api") {
    setupBot(bot, { sql, cfg, log, payments, botUsername, notifier });
    await configureBotProfile(bot, cfg, log);
    server = await buildServer({ sql, cfg, log, storage, signer, payments, bot, botUsername, notifier });
    await server.listen({ port: cfg.PORT, host: cfg.HOST });

    const allowed_updates = ["message", "pre_checkout_query", "callback_query"] as const; // callback_query — кнопки /alerts
    if (cfg.BOT_MODE === "webhook") {
      await bot.api.setWebhook(`${cfg.PUBLIC_URL}/telegram/webhook`, {
        secret_token: cfg.TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: [...allowed_updates],
        drop_pending_updates: false,
        max_connections: 40,
      });
      log.info("бот: webhook");
    } else {
      await bot.api.deleteWebhook();
      tasks.push(bot.start({ allowed_updates: [...allowed_updates], onStart: () => log.info("бот: long polling") }));
    }

    const poll = async () => {
      try {
        const n = await payments.pollCrypto();
        if (n) log.info({ n }, "CryptoBot: зачислены оплаты из поллера");
      } catch (e) {
        log.warn({ err: (e as Error).message }, "поллер CryptoBot");
      }
    };
    timers.push(setInterval(poll, 60_000));
  }

  if (cfg.ROLE === "all" || cfg.ROLE === "worker") {
    const generator = createGenerator(cfg);
    const bgRemover = createBgRemover(cfg);
    tasks.push(runWorker({ sql, cfg, storage, generator, bgRemover, tg, log, botUsername, alert, notifier }, abort.signal));
    const clean = () => cleanup(sql, storage, cfg, log).catch((e) => log.warn({ err: (e as Error).message }, "уборка"));
    timers.push(setInterval(clean, 30 * 60_000));
    void clean();
  }

  let stopping = false;
  const shutdown = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ sig }, "остановка...");
    timers.forEach(clearInterval);
    abort.abort();
    if (bot.isRunning()) await bot.stop();
    await server?.close();
    await notifier.flush().catch(() => {});
    await Promise.race([Promise.allSettled(tasks), new Promise((r) => setTimeout(r, 20_000))]);
    await sql.end({ timeout: 5 });
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error({ err: e instanceof Error ? e.stack : String(e) }, "unhandledRejection"));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
