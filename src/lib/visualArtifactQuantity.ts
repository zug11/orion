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

export function formatArtifactQuantity(value: number | null, unit: string): string {
  if (value === null) return "No result at these settings";
  const trimmed = unit.trim();
  if (trimmed.startsWith("%")) return numbers.format(value) + trimmed;
  const parts = trimmed.match(/^(\S+?)(?:\s*\/\s*|\s+per\s+)(.+)$/i);
  const numerator = parts ? parts[1] : trimmed;
  const suffix = parts ? "/" + parts[2] : "";
  const token = /^dollars?$/i.test(numerator) ? "$" : numerator;
  if (token === "¢") return numbers.format(value) + "¢" + suffix;

  const symbolCode = symbolCurrencies.get(token);
  if (!symbolCode && !currencyCodes.has(token)) return [numbers.format(value), unit].filter(Boolean).join(" ");
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
