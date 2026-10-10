import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const snowball = require("snowball-stemmers");
const ru = snowball.newStemmer("russian");
const en = snowball.newStemmer("english");

const STOP = new Set(
  [
    "a an the and or but if then else of to in on at by for with from into onto over under about as is are was were be been being am do does did done have has had having it its this that these those there here what which who whom whose when where why how all any some no not only own same so than too very can will just should would could may might must shall i me my we our you your he him his she her they them their also via per vs etc yes yeah ok okay okey thanks thank please pls lets let go continue proceed sure fine good great nice cool right next more now again same done",
    "и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это эта эти этот",
    "ок окей ага угу го давай давайте продолжай продолжи продолжаем дальше делай сделай норм нормально спасибо пасиб спс понял понятно ясно отлично круто супер класс хорошо ладно поехали вперед погнали жду согласен верно точно именно запускай стартуй",
  ]
    .join(" ")
    .split(/\s+/),
);

const WORD = /[\p{L}\p{N}_]+/gu;

export function words(text: string): string[] {
  return (text.toLowerCase().normalize("NFKC").match(WORD) ?? []).map((w) => w.replace(/ё/g, "е"));
}

export function stem(word: string): string {
  if (/[а-я]/.test(word)) return ru.stem(word);
  if (/^[a-z]+$/.test(word) && word.length > 2) return en.stem(word);
  return word;
}

export function stems(text: string): string[] {
  return words(text).map(stem);
}

export function contentStems(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const w of words(text)) {
    if (STOP.has(w) || w.length < 2) continue;
    const s = stem(w);
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export function ftsText(text: string): string {
  return stems(text).join(" ");
}

export function ftsQuery(text: string, maxTerms = 24): string | undefined {
  const terms = contentStems(text).slice(0, maxTerms);
  if (terms.length === 0) return undefined;
  return terms.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");
}

export function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  if (!trimmed || trimmed.startsWith("/")) return true;
  return contentStems(trimmed).length === 0;
}

export function recallQueryFromPrompt(prompt: string, maxChars = 1200): string {
  if (prompt.length <= maxChars) return prompt;
  const lines = prompt.split("\n");
  const errorLines = lines.filter((l) => /error|exception|fail|traceback|denied|not found|panic|ошибк/i.test(l)).slice(0, 8);
  return `${prompt.slice(0, maxChars)}\n${errorLines.join("\n")}`.slice(0, maxChars * 2);
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  [/\bsk-ant-[A-Za-z0-9_-]{16,}/g, "[REDACTED_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED_TOKEN]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]"],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "[REDACTED_TOKEN]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, "[REDACTED_KEY]"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{20,}/gi, "$1 [REDACTED]"],
  [/((?:api[_-]?key|secret|password|passwd|pwd|token|auth|credential)s?["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi, "$1[REDACTED]"],
  [/(:\/\/[^\s:/@]+:)[^\s@/]{3,}@/g, "$1[REDACTED]@"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}
