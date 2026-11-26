// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRequest, Settings } from "../types";
import { providerCallScheduler } from "./providerScheduler";
import { chatWithOrion, deleteApiKey, deleteAnthropicApiKey, saveApiKey, saveAnthropicApiKey } from "./storage";
import { generatePassageIllustration, generateVisualArtifact } from "./visualArtifactGeneration";
import { readVisualArtifactMarker, visualArtifactMarker } from "./visualArtifactMarkdown";
import compositions from "./fixtures/mcpVisualCompositions.json";
import argumentsFixture from "./fixtures/mcpVisualArgument.json";
import drawings from "./fixtures/mcpVisualDrawingDynamics.json";
import { parseArtifactArgument } from "./artifactArgument";
import { parseArtifactIllustration } from "./artifactIllustration";
import { type VisualArtifact } from "./visualArtifacts";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const model = "gpt-5.6-sol";
const selected = { model, apiKeyConfigured: true, anthropicApiKeyConfigured: true, reasoningEffort: "low" } as Settings;
const source = 'On Friday the printmaker etched the plate. On Saturday she printed the first proof. "Keep the ghost marks," she wrote.';
const artifact = { version: 1, format: "timeline", title: "From plate to proof", blocks: [{ kind: "steps", items: [
  { label: "Friday", heading: "Etch", text: "The printmaker etched the plate." },
  { label: "Saturday", heading: "Proof", text: "She printed the first proof." },
] }] };
const freshSignal = () => new AbortController().signal;
function mockReply(reply: string) {
  const fetchMock = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
    const text = JSON.stringify({ reply });
    return new Response(JSON.stringify(String(url).includes("anthropic")
      ? { stop_reason: "end_turn", content: [{ type: "text", text }] } : { status: "completed", output_text: text }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
beforeEach(async () => {
  await saveApiKey("synthetic-key");
  await saveAnthropicApiKey("synthetic-key");
});
afterEach(async () => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  await deleteApiKey(); await deleteAnthropicApiKey();
});

describe("Visualise through the saved connection", () => {
  it.each([model, "claude-sonnet-5"])("fulfils an auto planner's drag-and-play brief on %s, repairing a static draft once", async selectedModel => {
    const visual = drawings[0].artifact, drawing = parseArtifactIllustration(visual.blocks[0]), passage = drawing.passage;
    const plan = {...visual, blocks: [{kind: "drawingRequest", description: "Show the microphone routing.", interaction:"dragAndPlay"}]};
    const {animation: _animation, ...still} = drawing;
    const packets: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (String(url).endsWith("/models")) return Response.json({data:[{id:"gpt-6.2-astra"}]});
      const body = JSON.parse(opts.body);
      const packet = JSON.parse(body.input ?? body.messages[0].content);
      packets.push(packet);
      if (packet.drawing) expect(body.model).toBe(selectedModel === model ? "gpt-6.2-astra" : selectedModel);
      const candidate = !packet.drawing ? plan : packet.correction ? visual : {...visual,blocks:[still]};
      const text = JSON.stringify({reply:JSON.stringify(candidate)});
      return Response.json(selectedModel === model ? {status:"completed",output_text:text} : {stop_reason:"end_turn",content:[{type:"text",text}]});
    }));
    const result = await generateVisualArtifact(passage,"auto","",{...selected, model: selectedModel},freshSignal());
    expect(readVisualArtifactMarker(visualArtifactMarker(result))).toEqual(visual);
    expect(packets).toHaveLength(3);
    expect(packets[1]).toMatchObject({source:passage,interaction:"dragAndPlay",drawing:true});
    expect(packets[2]).toMatchObject({source:passage,interaction:"dragAndPlay",correction:expect.stringContaining("animation")});
  });
  it("routes a direct animation request to the drawing engine and refuses a still substitute after one repair", async () => {
    const visual = drawings[1].artifact, {animation: _animation, ...still} = parseArtifactIllustration(visual.blocks[0]);
    const calls = mockReply(JSON.stringify({...visual,blocks:[still]}));
    await expect(generateVisualArtifact(still.passage,"auto","Animate the bridge",{...selected,model:"claude-sonnet-5"},freshSignal())).rejects.toThrow("time-keyed");
    expect(calls).toHaveBeenCalledTimes(2);
    expect(JSON.parse(JSON.parse(calls.mock.calls[0][1]!.body as string).messages[0].content).interaction).toBe("play");
  });
  it.each(compositions.slice(0, 2))("accepts a bespoke provider design through unguided Generate for me: $name", async ({ artifact: designed, source: passage }) => {
    const fetch = mockReply(JSON.stringify(designed));
    const result = await generateVisualArtifact(passage!, "auto", "", selected, freshSignal());
    expect(readVisualArtifactMarker(visualArtifactMarker(result))).toEqual(designed);
    const body = JSON.parse(fetch.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.input)).toMatchObject({ source: passage, format: "auto", guidance: "" });
    expect(body.instructions).toContain('format "custom"');
  });
  it("repairs an invalid custom binding once on the same connection and keeps explicit presets authoritative", async () => {
    const { artifact: designed, source: passage } = compositions[0];
    const invalid = { ...designed, layout: { ...designed.layout, rows: [[{ block: 99 }]] } };
    const transport = mockReply(JSON.stringify(designed));
    const badReply = () => Response.json({ status: "completed", output_text: JSON.stringify({ reply: JSON.stringify(invalid) }) });
    transport.mockResolvedValueOnce(badReply());
    const run = () => generateVisualArtifact(passage!, "auto", "", selected, freshSignal());
    expect(await run()).toEqual(designed);
    const retry = JSON.parse(transport.mock.calls[1][1]!.body as string);
    expect(JSON.parse(retry.input)).toMatchObject({ format: "custom", source: passage, guidance: "", correction: expect.stringContaining("index") });
    transport.mockClear().mockImplementation(async () => badReply());
    await expect(run()).rejects.toThrow(/custom layout/);
    expect(transport).toHaveBeenCalledTimes(2);
    transport.mockClear();
    await expect(generateVisualArtifact(passage!, "timeline", "", selected, freshSignal())).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("gives an unguided prose-only or inert custom design one chance to supply a passage-specific interaction", async () => {
    const {artifact: designed,source: passage} = compositions[1];
    const plain = {version:1,format:"explainer",title:"A reading",blocks:[{kind:"text",text:"Both records remain."}]};
    for (const first of [plain, {...plain,format:"custom",layout:{controls:[{label:"Read",options:["A","B"]}],
      rows:[[{control:0}],[{readout:0,label:"Finding",values:["Identical","Identical"]}],[{block:0}]]}}]) {
      const transport = mockReply(JSON.stringify(designed));
      transport.mockResolvedValueOnce(Response.json({status:"completed",output_text:JSON.stringify({reply:JSON.stringify(first)})}));
      expect(await generateVisualArtifact(passage!,"auto","",selected,freshSignal())).toEqual(designed);
      expect(transport).toHaveBeenCalledTimes(2);
      const retry = JSON.parse(JSON.parse(transport.mock.calls[1][1]!.body as string).input);
      expect(retry.correction).toContain("visible consequence");
    }
    const explicit = mockReply(JSON.stringify(plain));
    expect(await generateVisualArtifact(passage!,"explainer","Keep it a short reading",selected,freshSignal())).toEqual(plain);
    expect(explicit).toHaveBeenCalledTimes(1);
  });
  it("asks once for missing adaptive prose in a new argument and round-trips the resulting reading", async () => {
    const { artifact: library } = argumentsFixture[1];
    const { reading: _reading, ...legacy } = parseArtifactArgument(library.blocks[0]);
    const transport = mockReply(JSON.stringify(library));
    const withoutReading = () => Response.json({ status: "completed", output_text: JSON.stringify({ reply: JSON.stringify({ ...library, blocks: [legacy] }) }) });
    transport.mockResolvedValueOnce(withoutReading());
    const generate = () => generateVisualArtifact(legacy.passage, "auto", "", selected, freshSignal());
    const result = await generate();
    expect(readVisualArtifactMarker(visualArtifactMarker(result))).toEqual(library);
    const retry = JSON.parse(transport.mock.calls[1][1]!.body as string);
    expect(JSON.parse(retry.input)).toMatchObject({ format: "argument", source: legacy.passage, correction: expect.stringContaining("paragraph") });
    transport.mockClear().mockImplementation(async () => withoutReading());
    await expect(generate()).rejects.toThrow("paragraph");
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it.each([model, "claude-sonnet-5"])("uses one scheduled %s call for the actual selection, format and guidance", async model => {
    const transport = mockReply(JSON.stringify(artifact));
    const scheduler = vi.spyOn(providerCallScheduler, "run");
    expect(await generateVisualArtifact(source, "auto", "Show the weekend.", { ...selected, model }, freshSignal())).toEqual(artifact);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(scheduler.mock.calls[0][1]?.queueKey).toBe("visual-artifact");
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(body.model).toBe(model);
    expect(body.max_tokens ?? body.max_output_tokens).toBe(12000);
    expect(body.instructions ?? body.system).toContain("Draw the actual things");
    expect(body.text?.format.schema.required ?? body.output_config.format.schema.required).toEqual(["reply"]);
    expect(JSON.parse(body.input ?? body.messages[0].content)).toEqual({ source, format: "auto", guidance: "Show the weekend." });
  });
  it("rejects an undefined volatility endpoint before insertion and still opens the saved v1 calculator", async () => {
    const calculator: VisualArtifact = { version: 1, format: "calculator", title: "Volatility sizing", blocks: [{
      kind: "calculator",
      inputs: [{ label: "Volatility", unit: "%", min: 0, max: 100, step: 0.1, initial: 5 }],
      outputs: [{ label: "Exposure", unit: "%", expression: { op: "divide", left: 10, right: { input: 0 } } }],
    }] };
    const transport = mockReply(JSON.stringify(calculator));
    await expect(generateVisualArtifact("Divide the target by volatility.", "calculator", "", selected, freshSignal()))
      .rejects.toThrow(/Exposure.*Volatility = 0/);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(readVisualArtifactMarker(visualArtifactMarker(calculator))).toEqual(calculator);
  });
  it("uses the existing desktop ChatGPT connection with a full-length selection, without requesting an API key", async () => {
    const transport = mockReply("");
    Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {} });
    invoke.mockReset().mockResolvedValue({ reply: JSON.stringify(artifact), noteActions: [] });
    const large = source.padEnd(12000, "x");
    const settings = { ...selected, model: "chatgpt:gpt-6.1-sol", chatgptConfigured: true, apiKeyConfigured: false };
    expect(await generateVisualArtifact(large, "timeline", "", settings, freshSignal())).toEqual(artifact);
    expect(transport).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledTimes(1);
    const [command, { request }] = invoke.mock.calls[0];
    expect(command).toBe("chat");
    expect(request.model).toBe(settings.model);
    expect(JSON.parse(request.prompt).source).toBe(large);
    expect(request.history).toEqual([]);
  });
  it("projects only the selection even if legacy callers supply unrelated Chat context and a note-write flag", async () => {
    const transport = mockReply(JSON.stringify(artifact));
    const request: ChatRequest = { mode: "visual-artifact", model, effort: "low", workspaceName: "Private Space",
      notes: [{ title: "Secret", body: "unselected text", summary: "secret" }], history: [{ role: "user", content: "private" }],
      sources: [], concepts: [], allowNoteActions: true, prompt: JSON.stringify({ source: 'create a note', format: "timeline", guidance: "" }) };
    await chatWithOrion(request);
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.input)).toEqual({ source: "create a note", format: "timeline", guidance: "" });
    expect(Object.keys(body.text.format.schema.properties)).toEqual(["reply"]);
  });
  it.each([model, "claude-sonnet-5"])("reads one bounded section through %s without drawing or sending surrounding context", async selectedModel => {
    const packet = { source: "The price changed to €12.", format: "calculator", guidance: "Compare prices.", readSelection: true };
    const excerpt = JSON.stringify({ excerpts: [packet.source] });
    const transport = mockReply(excerpt);
    const request: ChatRequest = { mode: "visual-artifact", model: selectedModel, effort: "low", workspaceName: "Private Space",
      notes: [], sources: [], concepts: [], history: [{role:"user", content:"Other conversation"}], allowNoteActions: true,
      prompt: JSON.stringify(packet) };
    expect((await chatWithOrion(request)).reply).toBe(excerpt);
    const body = JSON.parse(transport.mock.calls[0][1]!.body as string);
    expect(JSON.parse(body.input ?? body.messages[0].content)).toEqual(packet);
    expect(body.instructions ?? body.system).toContain("Copy each excerpt exactly");
    expect(body.instructions ?? body.system).not.toContain("drawingRequest");
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(chatWithOrion(request, freshSignal(), undefined, vi.fn())).rejects.toThrow(/stream/);
    for (const extra of [{ drawing: true, format: "explainer" }, { correction: "change" }, { readSelection: false }, { source: "x".repeat(12_001) }]) {
      await expect(chatWithOrion({...request, prompt: JSON.stringify({...packet, ...extra})})).rejects.toThrow();
    }
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each([
    ["bad data", "auto", /incomplete visual/], [JSON.stringify({ ...artifact, storageId: "generated" }), "auto", /could not read/],
    [JSON.stringify(artifact), "quiz", /different visual format/], ['{"unavailable":true}', "calculator", /enough detail/],
  ] as const)("surfaces an unusable result without a second request", async (reply, format, error) => {
    const transport = mockReply(reply);
    await expect(generateVisualArtifact(source, format, "", selected, freshSignal())).rejects.toThrow(error);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it.each(["missing illustration", "only library symbols"])("corrects a drawing with %s and checks the final geometry and source", async initial => {
    const passage = "A float rises.";
    const drawing = { version:1,format:"explainer",title:"Float",blocks:[{kind:"illustration",passage,view:"square",
      parts:[{id:"float",name:"Float",tone:"warm",selectable:true,about:passage,quote:"float rises",
        shapes:[{type:"ellipse",cx:100,cy:90,rx:20,ry:10,paint:"soft"}]}]}] };
    const first = initial === "missing illustration" ? artifact : {...drawing, blocks:[{...drawing.blocks[0],
      parts:[{...drawing.blocks[0].parts[0], shapes:undefined, icon:{name:"gauge",x:40,y:40,size:80}}]}]};
    const packets: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, request) => {
      if (String(_url).endsWith("/models")) return Response.json({data:[{id:"gpt-6.2-astra"}]});
      const body = JSON.parse(request.body);
      expect(body.model).toBe("gpt-6.2-astra");
      expect(body.reasoning.effort).toBe("high");
      packets.push(JSON.parse(body.input));
      return new Response(JSON.stringify({status:"completed",output_text:JSON.stringify({reply:JSON.stringify(packets.length === 1 ? first : drawing)})}));
    }));
    expect(await generatePassageIllustration(passage,"Side view",selected,freshSignal())).toEqual(drawing);
    expect(packets[0]).toEqual({source:passage, format:"explainer", drawing:true, guidance:"Side view"});
    expect(packets[1]).toMatchObject({...packets[0],correction:expect.any(String)});
    const called = mockReply(JSON.stringify(drawing));
    await expect(generatePassageIllustration("Unrelated source","",selected,freshSignal())).rejects.toThrow(/passage differs/);
    expect(called).toHaveBeenCalledTimes(2);
  });
  it.each(["planned", "unsolicited geometry"])("delegates only the %s block to Astra and retains indexed evidence and other blocks", async mode => {
    const description = "Show the copper plate.";
    const plate = { kind:"illustration", view:"square", passage:source, parts:[
      { id:"plate", name:"Copper plate", tone:"warm", selectable:true, about:"The etched plate.", quote:"etched the plate",
        shapes:[{type:"ellipse", cx:100,cy:100,rx:30,ry:24,paint:"soft"}] },
    ] };
    const block = mode === "planned" ? { kind:"drawingRequest",description } : {kind:"illustration", parts:[]};
    const plan = { ...artifact, blocks:[block, ...artifact.blocks], evidence:{ passage:source, claims:[
      {label:"Etching", quotes:["etched the plate"], target:{block:1,field:"step",index:0}},
    ]} };
    const dispatch: string[] = [];
    const label = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (String(url).endsWith("/models")) return Response.json({data:[{id:"gpt-6.2-astra"}]});
      const body = JSON.parse(opts.body), input = JSON.parse(body.input);
      dispatch.push(body.model);
      if (body.model === selected.model) {
        expect(body.instructions).toContain("drawingRequest");
      } else {
        expect(input.drawing).toBe(true);
        expect(input.source).toBe(source);
        expect(input).not.toHaveProperty("blocks");
      }
      const visual = body.model === selected.model ? plan : {version:1,format:"explainer",title:"Only the plate",blocks:[plate]};
      return Response.json({status:"completed",output_text:JSON.stringify({reply:JSON.stringify(visual)})});
    }));
    const result = await generateVisualArtifact(source, mode === "planned" ? "auto" : "timeline", "", selected, freshSignal(), undefined, undefined, label);
    expect(dispatch).toEqual([model,"gpt-6.2-astra"]);
    expect(label).toHaveBeenCalledWith(expect.stringContaining("gpt-6.2-astra"));
    expect(result).toEqual({...plan,blocks:[plate,...artifact.blocks]});
  });
  it("pins plan account, selected model and advertised effort for explicit SVG guidance", async () => {
    Object.defineProperty(window,"__TAURI_INTERNALS__",{configurable:true,value:{}});
    const config = {...selected,model:"chatgpt:gpt-6-sol",chatgptConfigured:true,chatgptAccountId:"test-account",apiKeyConfigured:false};
    const plate = {kind:"illustration",view:"square",passage:source,parts:[
      {id:"plate",name:"Plate",tone:"warm",selectable:true,about:"Plate.",quote:"the plate",shapes:[{type:"circle",cx:150,cy:150,r:40,paint:"outline"}]},
    ]};
    const image = {version:1,format:"explainer",title:"Etched plate",blocks:[plate]};
    invoke.mockReset().mockImplementation(async (name,args)=>{
      if (name === "illustration_models") {
        expect(args).toEqual({plan:true,accountId:"test-account"});
        return [{id:"chatgpt:gpt-6.1-astra",efforts:["medium","high"]}];
      }
      expect(args.request).toMatchObject({model:"chatgpt:gpt-6.1-astra",effort:"high",drawingAccountId:"test-account"});
      expect(JSON.parse(args.request.prompt).drawing).toBe(true);
      return {reply:JSON.stringify(image)};
    });
    expect(await generateVisualArtifact(source,"auto","Make an SVG of the plate",config,freshSignal())).toEqual(image);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it.each([model, "gpt-6.1-astra"])("tries one same-key Astra request for %s when listing alone is forbidden", async saved => {
    const paid: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url,opts) => {
      if (String(url).endsWith("/models")) return new Response("",{status:403});
      paid.push(JSON.parse(opts.body).model);
      return Response.json({error:{message:"No access to this model."}},{status:403});
    }));
    const label = vi.fn();
    await expect(generatePassageIllustration(source,"", {...selected,model:saved},freshSignal(),{onModelSelected:label})).rejects.toThrow();
    expect(paid).toEqual([saved === model ? "gpt-6.2-astra" : saved]);
    expect(label).toHaveBeenCalledWith(expect.stringContaining("model list restricted"));
  });
  it("stops at authentication failure when listing models", async () => {
    const fetch = vi.fn(async () => Response.json({error:{message:"Invalid API key"}},{status:401}));
    vi.stubGlobal("fetch", fetch);
    await expect(generatePassageIllustration(source,"",selected,freshSignal())).rejects.toThrow(/invalid|key/i);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("does not dispatch without a configured connection or on oversized guidance or cancelled input", async () => {
    const transport = mockReply("");
    await expect(generateVisualArtifact(source, "auto", "", { ...selected, apiKeyConfigured: false }, freshSignal())).rejects.toThrow(/Settings/);
    await expect(generateVisualArtifact(source, "auto", "z".repeat(801), selected, freshSignal())).rejects.toThrow(/800/);
    const controller = new AbortController(); controller.abort();
    await expect(generateVisualArtifact(source, "auto", "", selected, controller.signal)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });
  it("discards a late provider result on cancellation or deadline", async () => {
    vi.useFakeTimers();
    for (const deadline of [false, true]) {
      let finish!: (response: Response) => void;
      const transport = vi.fn((_url: URL | string | Request, _init: RequestInit) => new Promise<Response>(resolve => { finish = resolve; }));
      vi.stubGlobal("fetch", transport);
      const controller = new AbortController();
      const result = generateVisualArtifact(source, "auto", "", selected, controller.signal);
      const failure = expect(result).rejects.toThrow(deadline ? /timed out/ : /cancelled/);
      await vi.advanceTimersByTimeAsync(0);
      expect(transport).toHaveBeenCalledTimes(1);
      if (deadline) await vi.advanceTimersByTimeAsync(120_000);
      else controller.abort(new Error("cancelled"));
      await failure;
      expect(transport.mock.calls[0][1].signal?.aborted).toBe(true);
      finish(new Response(JSON.stringify({ status: "completed", output_text: JSON.stringify({ reply: JSON.stringify(artifact) }) })));
    }
  });
});
