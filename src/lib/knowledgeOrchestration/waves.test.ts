/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import {
  PRESENTATION_PHYSICAL_WIDTH,
  PresentationWaveCancelledError,
  PresentationWaveKindError,
  runPresentationStages,
  runPresentationWaves,
  type PresentationWaveEvent,
  type PresentationWaveJob,
} from "./waves";

interface TestJob extends PresentationWaveJob {
  label?: string;
}

function copyJobs(count: number, start = 1): TestJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `copy-${start + index}`,
    kind: "copy",
  }));
}

function imageJobs(count: number): TestJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `image-${index + 1}`,
    kind: "image",
  }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("presentation wave runner", () => {
  it("splits 14 copy jobs into waves of 6, 6, and 2", async () => {
    const live: number[] = [];
    let maxLive = 0;
    const result = await runPresentationWaves({
      jobs: copyJobs(14),
      execute: async (job) => {
        live.push(1);
        maxLive = Math.max(maxLive, live.length);
        await delay(5);
        live.pop();
        return job.id;
      },
    });

    expect(PRESENTATION_PHYSICAL_WIDTH).toBe(6);
    expect(result.waves).toEqual([
      ["copy-1", "copy-2", "copy-3", "copy-4", "copy-5", "copy-6"],
      ["copy-7", "copy-8", "copy-9", "copy-10", "copy-11", "copy-12"],
      ["copy-13", "copy-14"],
    ]);
    expect(result.waveCount).toBe(3);
    expect(result.maxPhysicalWidth).toBe(6);
    expect(maxLive).toBe(6);
    expect(result.results).toHaveLength(14);
    expect(result.failures).toEqual([]);
  });

  it("waits for a wave to settle before starting the next", async () => {
    const events: string[] = [];
    await runPresentationWaves({
      jobs: copyJobs(8),
      execute: async (job) => {
        events.push(`start:${job.id}`);
        await delay(job.id === "copy-1" ? 20 : 1);
        events.push(`end:${job.id}`);
        return job.id;
      },
      onEvent: (event: PresentationWaveEvent<TestJob>) => {
        if (event.type === "wave-started" || event.type === "wave-settled") {
          events.push(`${event.type}:${event.waveIndex}`);
        }
      },
    });

    const secondWaveStart = events.indexOf("wave-started:1");
    const firstWaveSettled = events.indexOf("wave-settled:0");
    expect(firstWaveSettled).toBeGreaterThan(-1);
    expect(secondWaveStart).toBeGreaterThan(firstWaveSettled);
    expect(events.indexOf("start:copy-7")).toBeGreaterThan(firstWaveSettled);
  });

  it("refuses to mix copy and image jobs in one stage", async () => {
    await expect(
      runPresentationWaves({
        jobs: [...copyJobs(1), ...imageJobs(1)],
        execute: async (job) => job.id,
      }),
    ).rejects.toBeInstanceOf(PresentationWaveKindError);
  });

  it("queues repair children after remaining original jobs, not into the live wave", async () => {
    const started: string[] = [];
    const result = await runPresentationWaves({
      jobs: copyJobs(8),
      execute: async (job) => {
        started.push(job.id);
        if (job.id === "copy-2") {
          throw new Error("contract-invalid");
        }
        return job.id;
      },
      repair: (job) =>
        job.id === "copy-2"
          ? [
              { id: "copy-2a", kind: "copy" },
              { id: "copy-2b", kind: "copy" },
            ]
          : undefined,
    });

    expect(result.waves[0]).toEqual([
      "copy-1",
      "copy-2",
      "copy-3",
      "copy-4",
      "copy-5",
      "copy-6",
    ]);
    expect(result.waves[0]).not.toContain("copy-2a");
    expect(result.waves[1]).toEqual(["copy-7", "copy-8"]);
    expect(result.waves[2]).toEqual(["copy-2a", "copy-2b"]);
    expect(started.indexOf("copy-2a")).toBeGreaterThan(started.indexOf("copy-8"));
    expect(result.failures.map(({ job }) => job.id)).toEqual(["copy-2"]);
  });

  it("never exceeds physical width 6", async () => {
    let live = 0;
    let maxLive = 0;
    await runPresentationWaves({
      jobs: copyJobs(20),
      execute: async () => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await delay(8);
        live -= 1;
        return "ok";
      },
    });
    expect(maxLive).toBeLessThanOrEqual(6);
  });

  it("ignores late results after cancellation", async () => {
    const controller = new AbortController();
    let lateResolved = false;
    const run = runPresentationWaves({
      jobs: copyJobs(6),
      signal: controller.signal,
      execute: async (job, signal) => {
        if (job.id === "copy-1") {
          controller.abort();
          await delay(30);
          if (!signal.aborted) lateResolved = true;
          return "late";
        }
        await delay(80);
        return job.id;
      },
    });

    await expect(run).rejects.toBeInstanceOf(PresentationWaveCancelledError);
    await delay(50);
    expect(lateResolved).toBe(false);
  });

  it("runs image stages only after every copy wave has settled", async () => {
    const events: string[] = [];
    await runPresentationStages(
      [{ jobs: copyJobs(8) }, { jobs: imageJobs(3) }],
      {
        execute: async (job) => {
          events.push(`start:${job.kind}:${job.id}`);
          await delay(2);
          events.push(`end:${job.kind}:${job.id}`);
          return job.id;
        },
      },
    );

    const lastCopy = Math.max(
      ...events.flatMap((event, index) =>
        event.startsWith("end:copy:") ? [index] : [],
      ),
    );
    const firstImage = events.findIndex((event) =>
      event.startsWith("start:image:"),
    );
    expect(firstImage).toBeGreaterThan(lastCopy);
  });
});
