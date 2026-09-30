export type ErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "BANNED"
  | "NOT_FOUND"
  | "BAD_REQUEST"
  | "NO_SELFIE"
  | "SELFIE_EXPIRED"
  | "BAD_IMAGE"
  | "NOT_ENOUGH_CREDITS"
  | "FREE_PACK_USED"
  | "FREE_STYLE_ONLY"
  | "PACK_IN_PROGRESS"
  | "UNKNOWN_STYLE"
  | "UNKNOWN_PRODUCT"
  | "PROVIDER_DISABLED"
  | "PAYMENT_ERROR"
  | "GIFT_INVALID"
  | "GIFT_USED"
  | "GIFT_OWN"
  | "RATE_LIMIT";

const STATUS: Record<ErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  BANNED: 403,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  NO_SELFIE: 409,
  SELFIE_EXPIRED: 409,
  BAD_IMAGE: 422,
  NOT_ENOUGH_CREDITS: 402,
  FREE_PACK_USED: 409,
  FREE_STYLE_ONLY: 409,
  PACK_IN_PROGRESS: 409,
  UNKNOWN_STYLE: 400,
  UNKNOWN_PRODUCT: 400,
  PROVIDER_DISABLED: 503,
  PAYMENT_ERROR: 502,
  GIFT_INVALID: 404,
  GIFT_USED: 409,
  GIFT_OWN: 409,
  RATE_LIMIT: 429,
};

/** Ошибка, текст которой можно показать пользователю. */
export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "23505";
}
