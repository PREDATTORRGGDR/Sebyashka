import { pino, type Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    base: undefined,
    timestamp: pino.stdTimeFunctions.isoTime,
    // Никогда не пишем в логи токены и initData.
    redact: { paths: ["req.headers.authorization", "*.token", "*.BOT_TOKEN", "*.initData"], censor: "[скрыто]" },
  });
}
