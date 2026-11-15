import { invoke, isTauri } from "@tauri-apps/api/core";
export interface ChatGPTAccount { id: string; email: string; connected: boolean }
export interface ChatGPTStatus { configured: boolean; activeId: string | null; accounts: ChatGPTAccount[]; firstConnection: boolean }
export interface ChatGPTModel { id: string; name: string }
export const isChatGPTModel = (model: string | undefined) => model?.startsWith("chatgpt:") === true;
export async function chatGPTCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) throw new Error("ChatGPT sign-in is available in the Orion desktop app.");
  return invoke<T>(command, args);
}
export async function manageChatGPTUsage() {
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl("https://chatgpt.com/settings/usage");
}
