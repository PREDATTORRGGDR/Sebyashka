/**
 * Каталог: стили, эмоции и товары. Всё, что влияет на деньги, - здесь.
 * Экономика и обоснование цен - в docs/ECONOMICS.md.
 */

export interface Style {
  id: string;
  title: string;
  description: string;
  premium: boolean;
  /** Описание стиля для модели. Подобрано на тестовых генерациях PuLID (сентябрь 2026), на Seedream не перепроверялось. */
  prompt: string;
  /** Стиль ещё раз в конце промпта («Die-cut <tag> sticker»), чтобы 16 стикеров пака не расползались по стилю. */
  tag: string;
  /** Одежда: без неё «3D», «Пластилин» и «Акварель» иногда рисовали голый торс. */
  outfit?: string;
  /** Пикселизация готовой картинки до N×N (только пиксель-арт). */
  pixelate?: number;
}

export const STYLES: readonly Style[] = [
  {
    id: "original",
    title: "Как на фото",
    description: "Реалистично: твоё лицо как на фото, только с эмоциями",
    premium: false,
    prompt: "Photorealistic portrait photo, realistic skin texture, natural light and colors, true-to-life face and hair, not a drawing",
    tag: "photo",
  },
  {
    id: "cartoon3d",
    title: "3D-мульт",
    description: "Объёмный персонаж как из анимационного фильма",
    premium: false,
    prompt: "3D animated movie character render, soft studio lighting, smooth shading, detailed hair",
    tag: "3D cartoon",
  },
  {
    id: "anime",
    title: "Аниме",
    description: "Яркий аниме-рисунок с чёткими линиями",
    premium: false,
    prompt: "Anime illustration, clean line art, cel shading, vibrant colors",
    tag: "anime",
  },
  {
    id: "comic",
    title: "Комикс",
    description: "Жирный контур и сочные цвета",
    premium: false,
    prompt: "Comic book illustration, bold ink outlines, flat vivid colors, halftone accents",
    tag: "comic book",
  },
  {
    id: "chibi",
    title: "Чиби",
    description: "Милая версия тебя с большой головой",
    premium: true,
    prompt: "Chibi caricature with an oversized head and a small body, pastel colors, same face features and hairstyle",
    tag: "chibi",
  },
  {
    id: "pixel",
    title: "Пиксель-арт",
    description: "Ретро-игра 16 бит",
    premium: true,
    prompt: "Pixel art. 8-bit pixel art character portrait like a classic video game, chunky visible pixels, no anti-aliasing, flat colors",
    tag: "pixel art",
    pixelate: 96,
  },
  {
    id: "clay",
    title: "Пластилин",
    description: "Словно слеплено руками",
    premium: true,
    prompt: "Claymation figure, plasticine texture, visible fingerprints in clay, handmade stop-motion look",
    tag: "claymation",
    outfit: "a plasticine t-shirt",
  },
  {
    id: "cyberpunk",
    title: "Киберпанк",
    description: "Неон, импланты и ночной город в глазах",
    premium: true,
    prompt: "Cyberpunk portrait, neon rim light, futuristic accessories, glowing accents",
    tag: "cyberpunk",
    outfit: "a techwear jacket",
  },
  {
    id: "watercolor",
    title: "Акварель",
    description: "Нежный рисунок кистью",
    premium: true,
    prompt: "Delicate watercolor and ink illustration, thin ink linework, translucent watercolor washes, splashes of pigment, storybook art",
    tag: "watercolor",
  },
] as const;

export interface Emotion {
  id: string;
  emoji: string;
  title: string;
  prompt: string;
}

/** Порядок важен: бесплатный пак берёт первые FREE_PACK_SIZE эмоций, платный - первые STICKERS_PER_PACK. */
export const EMOTIONS: readonly Emotion[] = [
  { id: "happy", emoji: "😄", title: "Радость", prompt: "big happy smile" },
  { id: "lol", emoji: "😂", title: "Ржу", prompt: "laughing hard with tears of joy" },
  { id: "love", emoji: "😍", title: "Влюблён", prompt: "in love, heart-shaped eyes, dreamy smile" },
  { id: "cool", emoji: "😎", title: "Крутой", prompt: "wearing sunglasses, confident cool smirk" },
  { id: "shock", emoji: "😱", title: "Шок", prompt: "shocked, mouth wide open, hands on cheeks" },
  { id: "cry", emoji: "😭", title: "Плачу", prompt: "crying loudly, streams of tears" },
  { id: "angry", emoji: "😡", title: "Злой", prompt: "furious angry face, red cheeks, steam" },
  { id: "think", emoji: "🤔", title: "Думаю", prompt: "thinking, hand on chin, one eyebrow raised" },
  { id: "ok", emoji: "👍", title: "Ок", prompt: "giving thumbs up, friendly smile" },
  { id: "hi", emoji: "👋", title: "Привет", prompt: "waving hello, cheerful" },
  { id: "facepalm", emoji: "🤦", title: "Фейспалм", prompt: "facepalm, one hand on the forehead, disappointed" },
  { id: "sleep", emoji: "😴", title: "Сплю", prompt: "sleeping peacefully, eyes closed, head tilted" },
  { id: "party", emoji: "🥳", title: "Праздник", prompt: "wearing a party hat, blowing a party horn, celebrating" },
  { id: "wink", emoji: "😉", title: "Подмигиваю", prompt: "winking playfully" },
  { id: "cringe", emoji: "😬", title: "Кринж", prompt: "awkward cringe grimace, teeth clenched" },
  { id: "please", emoji: "🙏", title: "Ну пожалуйста", prompt: "begging, hands pressed together, big pleading eyes" },
  { id: "mindblown", emoji: "🤯", title: "Мозг взорван", prompt: "mind blown, both hands on the head, amazed wide eyes" },
  { id: "yum", emoji: "😋", title: "Вкусно", prompt: "licking lips, holding a tasty snack" },
  { id: "shy", emoji: "😳", title: "Смущаюсь", prompt: "blushing, embarrassed, shy" },
  { id: "bored", emoji: "😒", title: "Скучно", prompt: "bored unimpressed side eye" },
  { id: "fire", emoji: "🔥", title: "Огонь", prompt: "hyped and excited, fists up, fiery orange glow behind" },
  { id: "heart", emoji: "❤️", title: "Люблю", prompt: "holding a big red heart" },
  { id: "money", emoji: "🤑", title: "Богатею", prompt: "greedy grin, holding a fan of cash" },
  { id: "salute", emoji: "🫡", title: "Есть!", prompt: "saluting, determined" },
] as const;

export const NEGATIVE_PROMPT =
  "text, letters, watermark, logo, signature, multiple people, extra limbs, extra fingers, deformed face, blurry, lowres, busy background, scenery, frame, border, nsfw, nudity";

export function buildPrompt(style: Style, emotion: Emotion, wish?: string | null): string {
  // Модель - edit (Seedream 4): фото уже референс, поэтому главное - велеть сохранить субъекта один в один.
  // Субъект может быть не человеком (кот, игрушка, персонаж) - тогда оставляем его облик. Пожелание в конце.
  return [
    "Turn the subject of the reference photo into a sticker.",
    "Keep the subject exactly the same: identical face, facial features, skin tone, hair, age and gender, instantly recognizable as the same individual. If it is not a person (an animal, toy or character), keep its exact look, colors and markings.",
    `Style: ${style.prompt}.`,
    `If it is a person, dress them in ${style.outfit ?? "casual clothes"}. Expression and pose: ${emotion.prompt}, exaggerated.`,
    "Head and shoulders, centered, a single subject.",
    `Die-cut ${style.tag} sticker with a thick white outline on a plain white background, no text, no watermark.`,
    wish ? `Extra details: ${wish}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
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
    description: "Три пака - попробуй разные стили",
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

/** +1 пак пригласившему за каждых столько приглашённых друзей. */
export const INVITES_PER_REWARD = 3;

/** Период подписки Stars в секундах - Telegram поддерживает только 30 дней. */
export const STARS_SUBSCRIPTION_PERIOD = 30 * 24 * 60 * 60;

export function emotionsFor(count: number): Emotion[] {
  return EMOTIONS.slice(0, Math.min(count, EMOTIONS.length));
}
