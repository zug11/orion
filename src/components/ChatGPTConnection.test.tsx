// @vitest-environment jsdom
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../data/defaults";
import { ChatGPTConnection } from "./ChatGPTConnection";
import { isSelectedAIConfigured } from "../lib/ai";
import type { Settings } from "../types";
import type { ChatGPTModel } from "../lib/chatgpt";
const api = vi.hoisted(() => ({ invoke:vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: api.invoke, isTauri: () => true }));
const disconnected = { configured:false, activeId:null, accounts:[], firstConnection:false };
const connected = { configured:true, activeId:"oaiapp_test", accounts:[{id:"oaiapp_test",email:"reader@example.test",connected:true}], firstConnection:true };
beforeEach(() => { api.invoke.mockReset(); });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function Harness({ initial = defaultSettings }: { initial?: Settings }) {
  const [settings,setSettings]=useState(initial);
  const [models, setModels] = useState<ChatGPTModel[]>([]);
  return <><ChatGPTConnection settings={settings} onChange={setSettings} onModels={setModels}/><output data-testid="config">{JSON.stringify({model:settings.model,ready:isSelectedAIConfigured(settings),apiKey:settings.apiKeyConfigured,account:settings.chatgptAccountId})}</output><output data-testid="models">{models.map(model => model.id).join(",")}</output><button onClick={() => setSettings(s => ({ ...s, model: "claude-test-choice" }))}>Choose another model</button></>;
}
describe("ChatGPT connection", () => {
  it("uses the account catalog and enables text AI without enabling API media", async () => {
    api.invoke.mockImplementation(async (command:string) => command === "chatgpt_status" ? disconnected : command === "chatgpt_sign_in" ? connected : command === "chatgpt_models" ? [{id:"chatgpt:account-model",name:"Account model"}] : undefined);
    render(<Harness/>);
    await waitFor(() => expect(api.invoke).toHaveBeenCalledWith("chatgpt_status",undefined));
    await act(async () => { fireEvent.click(screen.getByRole("button",{name:"Continue with ChatGPT"})); });
    expect(await screen.findByRole("dialog")).toHaveTextContent("You’re using your ChatGPT plan");
    await waitFor(() => expect(screen.getByTestId("config")).toHaveTextContent('"model":"chatgpt:account-model","ready":true,"apiKey":false'));
    fireEvent.click(screen.getByRole("button",{name:"Got it"}));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("does not activate a failed or declined sign-in",async () => {
    api.invoke.mockImplementation(async (command:string) => { if(command==="chatgpt_status") return disconnected; throw new Error("Plan permission was declined"); });
    render(<Harness/>);
    await act(async () => { fireEvent.click(screen.getByRole("button",{name:"Continue with ChatGPT"})); });
    expect(await screen.findByText("Plan permission was declined")).toBeInTheDocument();
    expect(screen.getByTestId("config")).toHaveTextContent('"ready":false');
  });
  it("reports an empty account catalog without fabricating a plan model", async () => {
    api.invoke.mockImplementation(async (command: string) => command === "chatgpt_status" ? disconnected : command === "chatgpt_sign_in" ? { ...connected, firstConnection: false } : command === "chatgpt_models" ? [] : undefined);
    render(<Harness/>);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    expect(await screen.findByText(/no available ChatGPT plan models/)).toBeInTheDocument();
    expect(screen.getByTestId("config")).toHaveTextContent(`"model":"${defaultSettings.model}"`);
    expect(screen.getByTestId("config")).toHaveTextContent('"ready":false');
  });
  it("keeps an explicit model choice made while the account catalog is loading", async () => {
    const catalog = deferred<ChatGPTModel[]>();
    api.invoke.mockImplementation(async (command: string) => command === "chatgpt_status" ? disconnected : command === "chatgpt_sign_in" ? { ...connected, firstConnection: false } : command === "chatgpt_models" ? catalog.promise : undefined);
    render(<Harness/>);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(api.invoke).toHaveBeenCalledWith("chatgpt_models", undefined));
    expect(screen.queryByRole("button", { name: "Cancel sign-in" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Manage usage" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Choose another model" }));
    await act(async () => catalog.resolve([{ id: "chatgpt:available", name: "Available" }]));
    expect(screen.getByTestId("config")).toHaveTextContent('"model":"claude-test-choice"');
    expect(screen.getByTestId("models")).toHaveTextContent("chatgpt:available");
  });
  it("ignores an old catalog failure after a newer sign-in succeeds", async () => {
    const oldCatalog = deferred<ChatGPTModel[]>();
    let catalogCalls = 0;
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "chatgpt_status" || command === "chatgpt_sign_in") return { ...connected, firstConnection: false };
      if (command === "chatgpt_models") return ++catalogCalls === 1 ? oldCatalog.promise : [{ id: "chatgpt:new-model", name: "New" }];
    });
    render(<Harness/>);
    await waitFor(() => expect(catalogCalls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(screen.getByTestId("config")).toHaveTextContent('"model":"chatgpt:new-model"'));
    await act(async () => oldCatalog.reject(new Error("Old account no longer available")));
    expect(screen.queryByText("Old account no longer available")).not.toBeInTheDocument();
    expect(screen.getByTestId("models")).toHaveTextContent("chatgpt:new-model");
  });
  it("does not reactivate a cancelled sign-in when its result arrives late", async () => {
    const pending = deferred<typeof connected>();
    api.invoke.mockImplementation(async (command: string) => command === "chatgpt_status" ? disconnected : command === "chatgpt_sign_in" ? pending.promise : undefined);
    render(<Harness/>);
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled());
    await act(async () => pending.resolve(connected));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByTestId("config")).toHaveTextContent('"ready":false');
    expect(api.invoke).not.toHaveBeenCalledWith("chatgpt_models", undefined);
  });
  it("cancels its pending sign-in on disposal without late settings or model writes", async () => {
    const pending = deferred<typeof connected>();
    api.invoke.mockImplementation(async (command: string) => command === "chatgpt_status" ? disconnected : command === "chatgpt_sign_in" ? pending.promise : undefined);
    const change = vi.fn(), models = vi.fn();
    const view = render(<ChatGPTConnection settings={defaultSettings} onChange={change} onModels={models}/>);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    view.unmount(); change.mockClear(); models.mockClear();
    expect(api.invoke).toHaveBeenCalledWith("chatgpt_cancel_sign_in", undefined);
    await act(async () => pending.resolve(connected));
    expect(change).not.toHaveBeenCalled(); expect(models).not.toHaveBeenCalled();
  });
  it("switches account catalogs and clears text access on sign-out", async () => {
    const second = { id: "oaiapp_second", email: "second@example.test", connected: true };
    let status = { ...connected, firstConnection: false, accounts: [...connected.accounts, second] };
    let signedOut = false;
    api.invoke.mockImplementation(async (command: string, args?: { accountId?: string }) => {
      if (command === "chatgpt_status") return signedOut ? disconnected : status;
      if (command === "chatgpt_select_account") { status = { ...status, activeId: args!.accountId! }; return status; }
      if (command === "chatgpt_models") return [{ id: `chatgpt:${status.activeId}`, name: status.activeId }];
      if (command === "chatgpt_sign_out") { signedOut = true; return "Signed out locally."; }
    });
    render(<Harness initial={{ ...defaultSettings, model: "chatgpt:oaiapp_test", chatgptConfigured: true, chatgptAccountId: "oaiapp_test" }}/>);
    await screen.findByRole("combobox", { name: "ChatGPT account" });
    fireEvent.change(screen.getByRole("combobox", { name: "ChatGPT account" }), { target: { value: second.id } });
    await waitFor(() => expect(screen.getByTestId("config")).toHaveTextContent('"model":"chatgpt:oaiapp_second"'));
    expect(screen.getByTestId("models")).not.toHaveTextContent("chatgpt:oaiapp_test");
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(await screen.findByText("Signed out locally.")).toBeInTheDocument();
    expect(screen.getByTestId("config")).toHaveTextContent('"ready":false');
    expect(screen.getByTestId("models")).toBeEmptyDOMElement();
  });
  it("allows a failed catalog request to be retried without a new sign-in", async () => {
    let calls = 0;
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "chatgpt_status") return { ...connected, firstConnection: false };
      if (command === "chatgpt_models") { if (++calls === 1) throw new Error("Catalog temporarily unavailable"); return [{ id: "chatgpt:recovered", name: "Recovered" }]; }
    });
    render(<Harness/>);
    expect(await screen.findByText("Catalog temporarily unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh models" }));
    await waitFor(() => expect(screen.getByTestId("models")).toHaveTextContent("chatgpt:recovered"));
    expect(screen.queryByText("Catalog temporarily unavailable")).not.toBeInTheDocument();
    expect(api.invoke).not.toHaveBeenCalledWith("chatgpt_sign_in", expect.anything());
  });
  it("refreshes connection flags after the catalog discovers a revoked credential", async () => {
    let revoked = false;
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "chatgpt_status") return revoked ? { ...disconnected, accounts: [{ ...connected.accounts[0], connected: false }] } : connected;
      if (command === "chatgpt_models") { revoked = true; throw new Error("Sign in again to reconnect this account."); }
    });
    render(<Harness initial={{ ...defaultSettings, chatgptConfigured: true, chatgptAccountId: connected.activeId, model: "chatgpt:old" }}/>);
    expect(await screen.findByText("Sign in again to reconnect this account.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("config")).toHaveTextContent('"ready":false'));
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(api.invoke.mock.calls.filter(([command]) => command === "chatgpt_models")).toHaveLength(1);
    expect(api.invoke.mock.calls.filter(([command]) => command === "chatgpt_status")).toHaveLength(2);
  });
  it("preserves an available plan model when reconnecting", async () => {
    api.invoke.mockImplementation(async (command: string) => {
      if (command === "chatgpt_status" || command === "chatgpt_sign_in") return { ...connected, firstConnection: false };
      if (command === "chatgpt_models") return [{ id: "chatgpt:first", name: "First" }, { id: "chatgpt:chosen", name: "Chosen" }];
    });
    render(<Harness initial={{ ...defaultSettings, chatgptConfigured: true, chatgptAccountId: connected.activeId, model: "chatgpt:chosen" }}/>);
    await waitFor(() => expect(screen.getByTestId("models")).toHaveTextContent("chatgpt:chosen"));
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeEnabled());
    expect(screen.getByTestId("config")).toHaveTextContent('"model":"chatgpt:chosen"');
  });
  it("uses the distinct native account labels without appending a second ID suffix", async () => {
    const accounts = [
      { id: "oaiapp_aaaaaa", email: "reader@example.test · aaaaaa", connected: true },
      { id: "oaiapp_bbbbbb", email: "reader@example.test · bbbbbb", connected: false },
    ];
    api.invoke.mockImplementation(async (command: string) => command === "chatgpt_status" ? { ...connected, accounts, activeId: accounts[0].id } : command === "chatgpt_models" ? [] : undefined);
    render(<Harness/>);
    const first = await screen.findByRole("option", { name: "reader@example.test · aaaaaa" });
    const second = screen.getByRole("option", { name: "reader@example.test · bbbbbb · sign in again" });
    expect(first.textContent).toBe("reader@example.test · aaaaaa");
    expect(second.textContent).toBe("reader@example.test · bbbbbb · sign in again");
  });
});
