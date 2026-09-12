import path from "node:path";

export const STATIC_ORIGIN = "https://static.3oaks.com";
export const STATIC_TARGET = process.env.OAKS_STATIC_TARGET
  ?? path.resolve(__dirname, "../../../../api_new_docker/api_new/client/game/oaks/static");
export const MONGO_URI = process.env.OAKS_MONGO_URI ?? "mongodb://127.0.0.1:27017";
export const MONGO_DB = process.env.OAKS_MONGO_DB ?? "oaks_SunOfEgypt";
export const MONGO_COLLECTION = process.env.OAKS_MONGO_COLLECTION ?? "simulate";
export const SPIN_DELAY_MS = Number(process.env.OAKS_SPIN_DELAY_MS ?? 2000);
export const FALLBACK_SPIN_DELAY_MS = Number(process.env.OAKS_FALLBACK_SPIN_DELAY_MS ?? 5000);
export const GAME_SWITCH_DELAY_MS = Number(process.env.OAKS_GAME_SWITCH_DELAY_MS ?? 10000);
export const REQUEST_TIMEOUT_MS = Number(process.env.OAKS_REQUEST_TIMEOUT_MS ?? 20000);
export const NETWORK_TIMEOUT_MS = Number(process.env.OAKS_NETWORK_TIMEOUT_MS ?? 20000);
export const NETWORK_SETTLE_MS = Number(process.env.OAKS_NETWORK_SETTLE_MS ?? 2000);
export const NETWORK_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.OAKS_NETWORK_CONCURRENCY ?? 4) || 1));
export const RTP_BUCKETS = (process.env.OAKS_RTP_BUCKETS ?? "0,30,100,300,500,1000,2500,5000,10000,1001,2001,5001,10001")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value >= 0);

export const REQUESTED_LANGUAGES = [
  "bn-IN", "da-DK", "de-DE", "en-US", "es-AR", "fr-FR", "gr-GR", "hi-IN",
  "id-ID", "it-IT", "ja-JP", "ko-KR", "ms-MY", "my-MM", "nl-NL", "pt-BR",
  "ro-RO", "ru-RU", "sv-SE", "ta-IN", "th-TH", "tr-TR", "vi-VN", "zh-CN",
] as const;

export const LANGUAGE_MAP: Record<string, string> = {
  "de-DE": "de", "en-US": "en", "es-AR": "es", "fr-FR": "fr", "gr-GR": "el",
  "id-ID": "id", "it-IT": "it", "ja-JP": "ja", "ko-KR": "ko", "nl-NL": "nl",
  "pt-BR": "pt-br", "ro-RO": "ro", "ru-RU": "ru", "sv-SE": "sv", "th-TH": "th",
  "tr-TR": "tr", "vi-VN": "vi", "zh-CN": "zh",
};
