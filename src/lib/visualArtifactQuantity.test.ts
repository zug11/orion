import { describe, expect, it } from "vitest";
import { formatArtifactQuantity, formatRecipeIngredient } from "./visualArtifactQuantity";

const unspecifiedDollar = (amount: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
}).formatToParts(amount).map(part => part.type === "currency" ? "$" : part.value).join("");

describe("artifact calculator quantities", () => {
  it("attaches the percent sign to its displayed value and retains the stated basis", () => {
    const number = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 10 });
    expect(formatArtifactQuantity(-1.7, "%")).toBe(number.format(-1.7) + "%");
    expect(formatArtifactQuantity(0, "%")).toBe(number.format(0) + "%");
    for (const unit of ["%", "%/year", "% per annum", "% of capital"]) {
      expect(formatArtifactQuantity(5, unit)).toBe(number.format(5) + unit);
    }
  });

  it("formats old monetary units and their rate qualifiers without assuming a dollar currency", () => {
    for (const unit of ["$/month", "$ per month", "dollars / month"]) {
      expect(formatArtifactQuantity(2398.2021006112, unit)).toBe(unspecifiedDollar(2398.20) + "/month");
    }
    expect(formatArtifactQuantity(-0.045, "$/share")).toBe(unspecifiedDollar(-0.05) + "/share");
    expect(formatArtifactQuantity(-0.0049, "$")).toBe(unspecifiedDollar(0));
  });

  it("retains explicit currency identity and respects its currency's minor units", () => {
    for (const [code, amount] of [["AUD", -3.49], ["JPY", 12.9], ["KWD", 1.2345]] as const) {
      const formatted = new Intl.NumberFormat(undefined, { style: "currency", currency: code, currencyDisplay: "code" });
      expect(formatArtifactQuantity(amount, code + "/day")).toBe(formatted.format(amount) + "/day");
    }
  });

  it("keeps cents in cents and preserves small measurements and units unrelated to money", () => {
    const number = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 10 });
    expect(formatArtifactQuantity(0.015, "¢/share")).toBe(number.format(0.015) + "¢/share");
    expect(formatArtifactQuantity(12.3, "cents/share")).toBe(number.format(12.3) + " cents/share");
    expect(formatArtifactQuantity(0.00000012, "L/s")).toBe(number.format(0.00000012) + " L/s");
    expect(formatArtifactQuantity(120, "BPM")).toBe(number.format(120) + " BPM");
    expect(formatArtifactQuantity(null, "$/month")).toBe("No result at these settings");
  });
});

describe("recipe ingredient amounts", () => {
  it("uses familiar fractions for recurring quantities without rounding the recipe", () => {
    expect(formatRecipeIngredient(2 * 7 / 6, "kg")).toBe("2⅓ kg");
    expect(formatRecipeIngredient(4 * 7 / 6, "cloves")).toBe("4⅔ cloves");
    expect(formatRecipeIngredient(1/6, "tsp")).toBe("⅙ tsp");
    expect(formatRecipeIngredient(1 + 7/12, "cups")).toBe("1 7/12 cups");
    expect(formatRecipeIngredient(-2/3, "")).toBe("−⅔");
    for (const amount of [0, 1, .25, 1.2, .333, 1/7]) {
      expect(formatRecipeIngredient(amount, "kg")).toBe(formatArtifactQuantity(amount, "kg"));
    }
  });
  it("retains percentage, currency, per-unit monetary and unavailable displays", () => {
    for (const unit of ["%", "%/day", "$", "USD", "$ per person", "AUD/kg", "¢"]) {
      expect(formatRecipeIngredient(2/3, unit)).toBe(formatArtifactQuantity(2/3, unit));
    }
    expect(formatRecipeIngredient(null, "kg")).toBe(formatArtifactQuantity(null, "kg"));
  });
});
