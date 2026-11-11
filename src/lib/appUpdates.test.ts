import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppUpdateStore, UPDATE_CHECK_INTERVAL, UPDATE_STARTUP_DELAY, updateProgress, type AppUpdateHost, type AppUpdateStatus } from "./appUpdates";

const idle: AppUpdateStatus = { supported: true, currentVersion: "0.6.0", phase: "idle" };
const available: AppUpdateStatus = { ...idle, phase: "available", version: "0.6.1" };

function fixture(native = true, initial = idle) {
  let receive: (status: AppUpdateStatus) => void = () => {};
  let focus: () => void = () => {};
  const unlisten = vi.fn();
  const unfocus = vi.fn();
  const invoke = vi.fn<AppUpdateHost["invoke"]>().mockResolvedValue(initial);
  const host: AppUpdateHost = {
    isNative: () => native,
    invoke,
    listen: vi.fn(async (callback) => { receive = callback; return unlisten; }),
    onFocus: vi.fn((callback) => { focus = callback; return unfocus; }),
  };
  const store = createAppUpdateStore(host);
  return { host, store, invoke, unlisten, unfocus, receive: (status: AppUpdateStatus) => receive(status), focus: () => focus() };
}

describe("app updates lifecycle", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-11T12:00:00Z")); });
  afterEach(() => vi.useRealTimers());

  it("does no native work in a browser and never checks unsupported Preview hosts", async () => {
    const browser = fixture(false);
    const stopBrowser = browser.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    expect(browser.host.listen).not.toHaveBeenCalled();
    expect(browser.invoke).not.toHaveBeenCalled();
    stopBrowser();

    const preview = fixture(true, { ...idle, supported: false });
    const stop = preview.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL);
    await preview.store.check();
    await preview.store.download();
    await preview.store.install();
    expect(preview.invoke.mock.calls.map(([command]) => command)).toEqual(["get_app_update_status"]);
    stop();
  });

  it("defers a single background check for all subscribers and never downloads or installs automatically", async () => {
    const f = fixture();
    const one = f.store.subscribe(() => {});
    const two = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    f.invoke.mockResolvedValue(available);
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY - 1);
    expect(f.invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.invoke).toHaveBeenLastCalledWith("check_app_update");
    expect(f.store.getSnapshot().status).toEqual(available);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2);
    f.focus();
    expect(f.invoke).toHaveBeenCalledTimes(2);
    one();
    expect(f.unlisten).not.toHaveBeenCalled();
    two();
    expect(f.unlisten).toHaveBeenCalledOnce();
    expect(f.unfocus).toHaveBeenCalledOnce();
  });

  it("throttles focus checks and stops its timers and listener when unmounted", async () => {
    const f = fixture();
    const stop = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(UPDATE_STARTUP_DELAY);
    f.focus(); f.focus();
    expect(f.invoke).toHaveBeenCalledTimes(2);
    vi.setSystemTime(Date.now() + UPDATE_CHECK_INTERVAL);
    f.focus();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.invoke).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL * 2);
    expect(f.invoke).toHaveBeenCalledTimes(3);
  });

  it("retains a newer native broadcast when an earlier status read finishes late", async () => {
    const f = fixture();
    let finish!: (status: AppUpdateStatus) => void;
    f.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const stop = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    f.receive(available);
    finish(idle);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.getSnapshot().status).toEqual(available);
    stop();
  });

  it("downloads only on request, follows shared progress and installs through the native save handshake command", async () => {
    const f = fixture(true, available);
    const stop = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    let finish!: (status: AppUpdateStatus) => void;
    f.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const download = f.store.download();
    expect(f.invoke).toHaveBeenLastCalledWith("download_app_update");
    expect(f.store.getSnapshot().busy).toBe(true);
    await f.store.download();
    expect(f.invoke).toHaveBeenCalledTimes(2);
    f.receive({ ...available, phase: "downloading", downloaded: 50, total: 100 });
    expect(updateProgress(f.store.getSnapshot().status)).toBe(50);
    const ready: AppUpdateStatus = { ...available, phase: "ready" };
    f.receive(ready);
    finish(ready);
    await download;
    expect(f.store.getSnapshot()).toMatchObject({ status: ready, busy: false });
    expect(f.invoke.mock.calls.some(([command]) => command === "install_app_update")).toBe(false);
    f.invoke.mockResolvedValueOnce({ ...available, phase: "installing" });
    await f.store.install();
    expect(f.invoke).toHaveBeenLastCalledWith("install_app_update");
    stop();
  });

  it("surfaces a check failure for retry without inventing an available update", async () => {
    const f = fixture();
    const stop = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    f.invoke.mockRejectedValueOnce(new Error("Could not reach GitHub. Try again."));
    await f.store.check();
    expect(f.store.getSnapshot()).toMatchObject({ busy: false, status: { phase: "error", error: "Could not reach GitHub. Try again." } });
    expect(f.store.getSnapshot().status.version).toBeUndefined();
    f.invoke.mockResolvedValueOnce(available);
    await f.store.check();
    expect(f.store.getSnapshot().status).toEqual(available);
    stop();
  });

  it("discards callbacks from a disposed subscription while initializing again", async () => {
    const f = fixture();
    let finish!: (status: AppUpdateStatus) => void;
    f.invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const stop = f.store.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    stop();
    finish(available);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.store.getSnapshot().status.supported).toBe(false);
  });

  it("bounds displayed download progress and supports missing content length", () => {
    expect(updateProgress({ ...available, downloaded: 20 })).toBeNull();
    expect(updateProgress({ ...available, downloaded: 120, total: 100 })).toBe(100);
    expect(updateProgress({ ...available, downloaded: -2, total: 100 })).toBe(0);
  });
});
