import { describe, expect, it } from "vitest";
import { formatArtifactQuantity } from "./visualArtifactQuantity";

const unspecifiedDollar = (amount: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", currencyDisplay: "narrowSymbol",
}).formatToParts(amount).map(part => part.type === "currency" ? "$" : part.value).join("");

describe("artifact calculator quantities", () => {
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
    expect(formatArtifactQuantity(null, "$/month")).toBe("Undefined");
  });
});
