export const MAX_FLOW_CHARACTERS = 200_000;
export const WRITING_MINUTES = [5, 15, 25, 45] as const;
export const FLOW_IDLE_SECONDS = [5, 10, 20] as const;

export function writingDuration(minutes: number): number | null {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= 180
    ? minutes * 60_000 : null;
}

export function formatWritingTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface FlowSession {
  phase: "ready" | "writing" | "complete" | "lost";
  durationMs: number;
  idleMs: number;
  text: string;
  endsAt: number;
  lastInputAt: number;
  composingAt: number | null;
}

export function createFlowSession(durationMs: number, idleSeconds: number): FlowSession {
  if (writingDuration(durationMs / 60_000) === null || !FLOW_IDLE_SECONDS.some(value => value === idleSeconds)) {
    throw new Error("Choose a session of 1–180 minutes and a supported inactivity limit.");
  }
  return { phase: "ready", durationMs, idleMs: idleSeconds * 1000, text: "", endsAt: 0, lastInputAt: 0, composingAt: null };
}

/** Compare deadlines, not callback order: a suspended window must not rescue an expired draft. */
export function advanceFlow(session: FlowSession, now: number): FlowSession {
  if (session.phase !== "writing" || session.composingAt !== null) return session;
  const expiresAt = session.lastInputAt + session.idleMs;
  if (session.endsAt <= expiresAt && now >= session.endsAt) return { ...session, phase: "complete" };
  if (now >= expiresAt) return { ...session, phase: "lost", text: "", composingAt: null };
  if (now >= session.endsAt) return { ...session, phase: "complete" };
  return session;
}

export function changeFlow(session: FlowSession, text: string, now: number): FlowSession {
  const current = advanceFlow(session, now);
  if (current.phase === "complete" || current.phase === "lost" || text === current.text) return current;
  const bounded = text.slice(0, MAX_FLOW_CHARACTERS);
  if (current.phase === "ready" && !bounded) return current;
  return { ...current, text: bounded, phase: "writing", lastInputAt: now,
    composingAt: current.phase === "ready" && current.composingAt !== null ? now : current.composingAt,
    endsAt: current.phase === "ready" ? now + current.durationMs : current.endsAt };
}

export function stopFlow(session: FlowSession, now: number): FlowSession {
  const current = advanceFlow(session, now);
  return current.phase === "lost" ? current : { ...current, phase: "complete", composingAt: null };
}

export function beginFlowComposition(session: FlowSession, now: number): FlowSession {
  const current = advanceFlow(session, now);
  return current.phase === "writing" || current.phase === "ready"
    ? { ...current, composingAt: now } : current;
}

export function endFlowComposition(session: FlowSession, text: string, now: number): FlowSession {
  const pausedFor = session.composingAt === null ? 0 : Math.max(0, now - session.composingAt);
  // IME candidate selection is writing. Pause both clocks until it commits.
  return changeFlow({ ...session, composingAt: null, lastInputAt: now,
    endsAt: session.endsAt ? session.endsAt + pausedFor : 0 }, text, now);
}

export function flowOpacity(session: FlowSession, now: number): number {
  if (session.phase === "lost") return 0;
  if (session.phase !== "writing" || session.composingAt !== null) return 1;
  const idle = Math.max(0, now - session.lastInputAt);
  return Math.max(0, Math.min(1, (session.idleMs - idle) / (session.idleMs * 0.7)));
}

export function flowRemaining(session: FlowSession, now: number): number {
  return session.phase === "ready" ? session.durationMs
    : Math.max(0, session.endsAt - (session.composingAt ?? now));
}

export interface WritingTimer {
  status: "idle" | "running" | "paused" | "complete";
  durationMs: number;
  remainingMs: number;
  deadline: number;
}

/** One general timer per window; it survives editor/navigation remounts without storing note data. */
export function createWritingTimerStore() {
  let state: WritingTimer = { status: "idle", durationMs: 0, remainingMs: 0, deadline: 0 };
  let interval: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const clear = () => {
    if (interval !== undefined) clearInterval(interval);
    interval = undefined;
    if (typeof window !== "undefined") window.removeEventListener("focus", refresh);
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", refresh);
  };
  const publish = (next: WritingTimer) => { state = next; listeners.forEach(listener => listener()); };
  function refresh() {
    if (state.status !== "running") return;
    const remainingMs = Math.max(0, state.deadline - Date.now());
    if (!remainingMs) clear();
    publish({ ...state, remainingMs, status: remainingMs ? "running" : "complete" });
  }
  const schedule = () => {
    clear();
    interval = setInterval(refresh, 1000);
    if (typeof window !== "undefined") window.addEventListener("focus", refresh);
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", refresh);
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start(durationMs: number) {
      if (writingDuration(durationMs / 60_000) === null) return false;
      publish({ status: "running", durationMs, remainingMs: durationMs, deadline: Date.now() + durationMs });
      schedule(); return true;
    },
    pause() { refresh(); if (state.status === "running") { clear(); publish({ ...state, status: "paused" }); } },
    resume() {
      if (state.status !== "paused") return;
      publish({ ...state, status: "running", deadline: Date.now() + state.remainingMs }); schedule();
    },
    stop() { clear(); publish({ status: "idle", durationMs: 0, remainingMs: 0, deadline: 0 }); },
    refresh,
  };
}

export const writingTimer = createWritingTimerStore();
