// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { createEmptySnapshot } from "../data/defaults";
import { apiIllustrationModelItems, chooseIllustrationModel, resolveIllustrationModel } from "./illustrationModel";

const settings = { ...createEmptySnapshot("Test", "2026-11-26", "space").settings,
  model: "gpt-5.6-sol", reasoningEffort: "low" as const, apiKeyConfigured: true };
const catalog = apiIllustrationModelItems({ data: [
  { id: "gpt-6.2-astra" }, { id: "gpt-6-astra" }, { id: "gpt-6.10-astra-2026-10-07" }, { id:"gpt-6.10-astra" },
  { id:"gpt-8-astra-audio" }, { id:"gpt-9-sol" }, { id:"chatgpt:gpt-7-astra" },
] });

describe("drawing model selection", () => {
  it("selects the strongest catalog version numerically, then its stable alias; leaves saved settings alone", () => {
    expect(chooseIllustrationModel(settings, catalog)).toMatchObject({ settings:{model:"gpt-6.10-astra",reasoningEffort:"high"} });
    expect(settings).toMatchObject({model:"gpt-5.6-sol",reasoningEffort:"low"});
    expect(chooseIllustrationModel(settings, [{id:"gpt-5.6-astra-2026-10-01"}]).settings.model).toBe("gpt-5.6-astra-2026-10-01");
    expect(chooseIllustrationModel({...settings,model:"gpt-6-astra"},catalog).settings.model).toBe("gpt-6-astra");
  });
  it("uses the selected plan namespace and advertised reasoning options, including higher explicit settings", () => {
    const plan = {...settings,model:"chatgpt:gpt-6-sol"};
    const mixed = [...catalog, {id:"chatgpt:gpt-5.6-astra", efforts:["low","xhigh"], planAccountId:"connected-account"}];
    const route = chooseIllustrationModel(plan, mixed);
    expect(route.settings).toMatchObject({model:"chatgpt:gpt-5.6-astra",reasoningEffort:"xhigh"});
    expect(route.label).toContain("ChatGPT plan");
    expect(route.settings.chatgptAccountId).toBe("connected-account");
    expect(() => chooseIllustrationModel({...plan,chatgptAccountId:"other"},mixed)).toThrow(/account changed/);
    const explicit = {...plan,model:"chatgpt:gpt-5.6-astra",reasoningEffort:"max" as const};
    expect(chooseIllustrationModel(explicit, [{id:explicit.model, efforts:["high","max"]}]).settings.reasoningEffort).toBe("max");
    expect(chooseIllustrationModel(plan, [{id:"chatgpt:gpt-6-astra",efforts:["medium"]}]).settings.reasoningEffort).toBe("medium");
    expect(() => chooseIllustrationModel(plan, catalog)).toThrow(/does not list an Astra/);
  });
  it("rejects missing and unsupported models explicitly", () => {
    expect(() => chooseIllustrationModel({...settings,model:"gpt-5-astra"},catalog)).toThrow(/unavailable/);
    expect(() => chooseIllustrationModel(settings,[{id:"gpt-6-astra",efforts:[]}])).toThrow(/reasoning/);
    expect(() => apiIllustrationModelItems({})).toThrow(/invalid/);
  });
  it("keeps Anthropic on its own connection without a model-catalog request", async () => {
    const fetch = vi.spyOn(globalThis,"fetch");
    try {
      const anthropic = {...settings,model:"claude-sonnet-5",anthropicApiKeyConfigured:true};
      expect((await resolveIllustrationModel(anthropic,new AbortController().signal)).settings).toBe(anthropic);
      expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });
});
