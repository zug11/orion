const numbers = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 10 });
const intl = Intl as typeof Intl & { supportedValuesOf?: (key: "currency") => string[] };
const currencyCodes = new Set(intl.supportedValuesOf?.("currency") ??
  ["AUD", "CAD", "CHF", "CNY", "EUR", "GBP", "HKD", "INR", "JPY", "KRW", "KWD", "NZD", "SGD", "USD"]);
// Use a dollar pattern for a bare $, retaining the source's symbol in every locale.
const symbolCurrencies = new Map(Object.entries({
  "$": "USD", "€": "EUR", "£": "GBP", "¥": "JPY", "₹": "INR", "₩": "KRW",
  "US$": "USD", "A$": "AUD", "AU$": "AUD", "C$": "CAD", "CA$": "CAD",
  "NZ$": "NZD", "HK$": "HKD", "S$": "SGD", "CN¥": "CNY",
}));
// Only recognized currency codes and symbols enter this cache. Qualifiers never do.
const moneyFormats = new Map<string, Intl.NumberFormat>();

function currencyUnit(trimmed: string) {
  const parts = trimmed.match(/^(\S+?)(?:\s*\/\s*|\s+per\s+)(.+)$/i);
  const numerator = parts ? parts[1] : trimmed;
  const token = /^dollars?$/i.test(numerator) ? "$" : numerator;
  const symbolCode = symbolCurrencies.get(token);
  if (!symbolCode && token !== "¢" && !currencyCodes.has(token)) return null;
  return { token, symbolCode, suffix: parts ? "/" + parts[2] : "" };
}

export function formatArtifactQuantity(value: number | null, unit: string): string {
  if (value === null) return "No result at these settings";
  const trimmed = unit.trim();
  if (trimmed.startsWith("%")) return numbers.format(value) + trimmed;
  const currency = currencyUnit(trimmed);
  if (!currency) return [numbers.format(value), unit].filter(Boolean).join(" ");
  const {token, symbolCode, suffix} = currency;
  if (token === "¢") return numbers.format(value) + "¢" + suffix;
  let formatter = moneyFormats.get(token);
  if (!formatter) {
    formatter = new Intl.NumberFormat(undefined, {
      style: "currency", currency: symbolCode ?? token, currencyDisplay: symbolCode ? "narrowSymbol" : "code",
    });
    moneyFormats.set(token, formatter);
  }
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const amount = Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value;
  if (!symbolCode) return formatter.format(amount) + suffix;
  return formatter.formatToParts(amount).map(part => part.type === "currency" ? token : part.value).join("") + suffix;
}

const repeatingCulinaryFractions: readonly [number, string][] = [
  [1/6, "⅙"], [1/3, "⅓"], [2/3, "⅔"], [5/6, "⅚"],
  [1/12, "1/12"], [5/12, "5/12"], [7/12, "7/12"], [11/12, "11/12"],
];

export function formatRecipeIngredient(value: number | null, unit: string): string {
  const normal = formatArtifactQuantity(value, unit);
  if (value === null || Number.isInteger(value) || unit.trim().startsWith("%") || currencyUnit(unit.trim())) return normal;
  const magnitude = Math.abs(value);
  const whole = Math.floor(magnitude);
  const fraction = magnitude - whole;
  // Accept floating-point noise from evaluating the recipe formula. A written 0.333 stays 0.333.
  const epsilon = Math.min(1e-11, Number.EPSILON * Math.max(1, magnitude) * 4);
  const match = repeatingCulinaryFractions.find(([candidate]) => Math.abs(fraction - candidate) <= epsilon);
  if (!match) return normal;
  const glyph = match[1];
  const wholePart = whole > 0 ? numbers.format(whole) + (glyph.includes("/") ? " " : "") : "";
  return [(value < 0 ? "−" : "") + wholePart + glyph, unit].filter(Boolean).join(" ");
}
