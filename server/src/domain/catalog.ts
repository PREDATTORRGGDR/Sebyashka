/**
 * Каталог: стили, эмоции и товары. Всё, что влияет на деньги, — здесь.
 * Экономика и обоснование цен — в docs/ECONOMICS.md.
 */

export interface Style {
  id: string;
  title: string;
  description: string;
  premium: boolean;
  prompt: string;
}

export const STYLES: readonly Style[] = [
  {
    id: "original",
    title: "Как на фото",
    description: "Сохраняет рисовку персонажа — для героев, питомцев, аватарок",
    premium: false,
    prompt: "keep the exact original art style, colors and design of the character from the reference image",
  },
  {
    id: "cartoon3d",
    title: "3D-мульт",
    description: "Объёмный персонаж как из анимационного фильма",
    premium: false,
    prompt: "3d cartoon character render, soft studio lighting, big expressive eyes, smooth shading",
  },
  {
    id: "anime",
    title: "Аниме",
    description: "Яркий аниме-рисунок с чёткими линиями",
    premium: false,
    prompt: "anime illustration, cel shading, clean line art, vibrant colors",
  },
  {
    id: "comic",
    title: "Комикс",
    description: "Жирный контур и сочные цвета",
    premium: false,
    prompt: "comic book style, bold ink outlines, flat vivid colors, halftone accents",
  },
  {
    id: "chibi",
    title: "Чиби",
    description: "Милая версия тебя с большой головой",
    premium: true,
    prompt: "chibi character, oversized head, tiny body, kawaii, pastel colors, cute",
  },
  {
    id: "pixel",
    title: "Пиксель-арт",
    description: "Ретро-игра 16 бит",
    premium: true,
    prompt: "16-bit pixel art character sprite, crisp pixels, limited palette, retro game",
  },
  {
    id: "clay",
    title: "Пластилин",
    description: "Словно слеплено руками",
    premium: true,
    prompt: "claymation character, plasticine texture, handmade stop-motion look",
  },
  {
    id: "cyberpunk",
    title: "Киберпанк",
    description: "Неон, импланты и ночной город в глазах",
    premium: true,
    prompt: "cyberpunk character, neon rim light, futuristic accessories, glowing accents",
  },
  {
    id: "watercolor",
    title: "Акварель",
    description: "Нежный рисунок кистью",
    premium: true,
    prompt: "watercolor illustration, soft washes, paper texture, delicate brush strokes",
  },
] as const;

export interface Emotion {
  id: string;
  emoji: string;
  title: string;
  prompt: string;
}

/** Порядок важен: бесплатный пак берёт первые FREE_PACK_SIZE эмоций, платный — первые STICKERS_PER_PACK. */
export const EMOTIONS: readonly Emotion[] = [
  { id: "happy", emoji: "😄", title: "Радость", prompt: "big happy smile" },
  { id: "lol", emoji: "😂", title: "Ржу", prompt: "laughing hard with tears of joy" },
  { id: "love", emoji: "😍", title: "Влюблён", prompt: "heart eyes, in love, dreamy" },
  { id: "cool", emoji: "😎", title: "Крутой", prompt: "wearing sunglasses, confident cool smirk" },
  { id: "shock", emoji: "😱", title: "Шок", prompt: "shocked, hands on cheeks, screaming" },
  { id: "cry", emoji: "😭", title: "Плачу", prompt: "crying loudly, streams of tears" },
  { id: "angry", emoji: "😡", title: "Злой", prompt: "furious angry face, red cheeks, steam" },
  { id: "think", emoji: "🤔", title: "Думаю", prompt: "thinking, hand on chin, one eyebrow raised" },
  { id: "ok", emoji: "👍", title: "Ок", prompt: "giving thumbs up, friendly smile" },
  { id: "hi", emoji: "👋", title: "Привет", prompt: "waving hello, cheerful" },
  { id: "facepalm", emoji: "🤦", title: "Фейспалм", prompt: "facepalm, hand covering face, disappointed" },
  { id: "sleep", emoji: "😴", title: "Сплю", prompt: "sleeping, eyes closed, zzz, drooling a little" },
  { id: "party", emoji: "🥳", title: "Праздник", prompt: "party hat, confetti, celebrating" },
  { id: "wink", emoji: "😉", title: "Подмигиваю", prompt: "winking playfully" },
  { id: "cringe", emoji: "😬", title: "Кринж", prompt: "awkward cringe grimace, teeth clenched" },
  { id: "please", emoji: "🙏", title: "Ну пожалуйста", prompt: "begging, hands pressed together, puppy eyes" },
  { id: "mindblown", emoji: "🤯", title: "Мозг взорван", prompt: "mind blown, exploding head effect" },
  { id: "yum", emoji: "😋", title: "Вкусно", prompt: "licking lips, delicious food" },
  { id: "shy", emoji: "😳", title: "Смущаюсь", prompt: "blushing, embarrassed, shy" },
  { id: "bored", emoji: "😒", title: "Скучно", prompt: "bored unimpressed side eye" },
  { id: "fire", emoji: "🔥", title: "Огонь", prompt: "excited, surrounded by fire flames, hyped" },
  { id: "heart", emoji: "❤️", title: "Люблю", prompt: "holding a big red heart" },
  { id: "money", emoji: "🤑", title: "Богатею", prompt: "money eyes, holding cash, greedy grin" },
  { id: "salute", emoji: "🫡", title: "Есть!", prompt: "saluting, determined" },
] as const;

export const NEGATIVE_PROMPT =
  "text, letters, watermark, logo, signature, multiple people, extra limbs, extra fingers, deformed face, blurry, lowres, busy background, scenery, frame, border, nsfw, nudity";

export function buildPrompt(style: Style, emotion: Emotion, wish?: string | null): string {
  return [
    // Фото может быть любым: человек, питомец, мультяшный персонаж, игрушка.
    "die-cut sticker of the same character from the reference image (person, pet or cartoon character), keep identity recognizable",
    emotion.prompt,
    style.prompt,
    wish ? `extra details: ${wish}` : "",
    "upper body, centered, expressive, high detail, plain pure white background, no text",
  ]
    .filter(Boolean)
    .join(", ");
}

/** Максимальная длина пожелания к паку. */
export const WISH_MAX_LEN = 200;

/** Грубый фильтр пожеланий до отправки в модель (сама модель тоже фильтрует). */
const WISH_BLOCK = /(nsfw|nude|naked|porn|sex|hentai|gore|blood|обнаж|голы[йея]|порн|секс|эротик|хентай|кров|расчлен|нацис|свастик|swastika)/i;

export function sanitizeWish(raw: string | null | undefined): { ok: true; wish: string | null } | { ok: false; reason: string } {
  const wish = (raw ?? "").replace(/[\u0000-\u001f<>{}]/g, " ").replace(/\s+/g, " ").trim().slice(0, WISH_MAX_LEN);
  if (!wish) return { ok: true, wish: null };
  if (WISH_BLOCK.test(wish)) return { ok: false, reason: "Такое пожелание нарушает правила" };
  return { ok: true, wish };
}

export function getStyle(id: string): Style | undefined {
  return STYLES.find((s) => s.id === id);
}

/** Сколько кредитов стоит пак в стиле. Pro-подписчикам премиум-стили по цене обычных. */
export function styleCost(style: Style, isPro: boolean): number {
  if (!style.premium) return 1;
  return isPro ? 1 : 2;
}

export type ProductKind = "credits" | "pro" | "gift";

export interface Product {
  id: string;
  kind: ProductKind;
  title: string;
  description: string;
  credits: number;
  /** Цена в Telegram Stars (XTR). */
  stars: number;
  /** Цена в USD для CryptoBot. */
  usd: string;
  /** Для pro: срок действия в днях. */
  days?: number;
  badge?: string;
}

export const PRODUCTS: readonly Product[] = [
  {
    id: "pack_1",
    kind: "credits",
    title: "1 пак",
    description: "Один полный стикерпак в любом обычном стиле",
    credits: 1,
    stars: 150,
    usd: "1.99",
  },
  {
    id: "pack_3",
    kind: "credits",
    title: "3 пака",
    description: "Три пака — попробуй разные стили",
    credits: 3,
    stars: 390,
    usd: "4.99",
    badge: "−13%",
  },
  {
    id: "pack_10",
    kind: "credits",
    title: "10 паков",
    description: "Для себя, друзей и второй половинки",
    credits: 10,
    stars: 1090,
    usd: "13.99",
    badge: "−27%",
  },
  {
    id: "pro_30",
    kind: "pro",
    title: "Себяшка Pro",
    description: "6 паков каждый месяц, премиум-стили по цене обычных, приоритет в очереди",
    credits: 6,
    stars: 500,
    usd: "6.49",
    days: 30,
    badge: "Выгодно",
  },
  {
    id: "gift_1",
    kind: "gift",
    title: "Подарить пак",
    description: "Ссылка-подарок: друг получит 1 пак",
    credits: 1,
    stars: 150,
    usd: "1.99",
  },
] as const;

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}

/** Сколько долларов получаем за 1 Star при выводе через Fragment. */
export const STAR_USD = 0.013;

/** Награда пригласившему, когда приглашённый впервые что-то купил. */
export const REFERRAL_REWARD_CREDITS = 1;

/** Период подписки Stars в секундах — Telegram поддерживает только 30 дней. */
export const STARS_SUBSCRIPTION_PERIOD = 30 * 24 * 60 * 60;

export function emotionsFor(count: number): Emotion[] {
  return EMOTIONS.slice(0, Math.min(count, EMOTIONS.length));
}
