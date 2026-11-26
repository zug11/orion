import type { ArtifactIllustration } from "./artifactIllustration";
import { animationTimeForValue, drawingPoses, type DrawingPose } from "./illustrationHandles";

export interface IllustrationPose {
  stage: number;
  positions: number[];
  label: string;
  time?: number;
}

function poseDistance(a: Map<string, DrawingPose>, b: Map<string, DrawingPose>) {
  let distance = 0;
  for (const [id, part] of a) {
    const other = b.get(id)!;
    distance += Math.hypot(part.dx - other.dx, part.dy - other.dy) / 200
      + Math.abs(Math.sin((part.angle - other.angle) * Math.PI / 360))
      + Math.abs((part.opacity ?? 1) - (other.opacity ?? 1))
      + Math.abs((part.level ?? 1) - (other.level ?? 1));
  }
  return distance;
}

/** Print keeps authored stage and endpoint captions. Image review has room for
 * four pictures, so spend those slots on visibly different poses. */
export function illustrationPoses(block: ArtifactIllustration, forReview = false): IllustrationPose[] {
  const handles = block.handles ?? [];
  const stages = block.states?.items ?? [];
  const animation = block.animation;
  const initial = handles.map(handle => handle.initial ?? 0);
  const first = { stage: 0, positions: initial, label: stages[0]?.label ?? "Starting position" };
  const poses: IllustrationPose[] = [first];
  const geometry = (pose: IllustrationPose) => drawingPoses(handles, pose.positions, animation, pose.time);
  const shown = [geometry(first)];

  function add(pose: IllustrationPose) {
    if (forReview) {
      if (poses.length === 4) return;
      const picture = geometry(pose);
      if (poses.some((other, i) => other.stage === pose.stage && poseDistance(picture, shown[i]) < 0.0001)) return;
      shown.push(picture);
    }
    poses.push(pose);
  }
  function addHandle(index: number, value: 0 | 1) {
    if (initial[index] === value) return;
    const positions = [...initial];
    positions[index] = value;
    const track = animation?.tracks.find(t => "handle" in t && t.handle === index);
    add({
      stage: 0, positions,
      ...(track && { time: animationTimeForValue(track.keys, value, 0) }),
      label: handles[index].label + " · " + handles[index].ends[value],
    });
  }
  function addStage(stage: number) {
    add({ stage, positions: initial, label: stages[stage].label });
  }

  // Include intermediate times: a complete revolution looks identical at its two keys.
  const candidates = animation ? [...new Set(animation.tracks.flatMap(track => track.keys.map(([t]) => t)))]
    .sort((a, b) => a - b)
    .flatMap((end, i, times) => i === 0 ? [] : [1, .25, .5, .75].map(f => {
      const time = times[i - 1] + (end - times[i - 1]) * f;
      const pose = { stage: 0, positions: initial, time, label: animation.label + " · " + Number(time.toFixed(2)) + " s" };
      return { pose, picture: geometry(pose) };
    })) : [];

  // Find the instant that differs most from all previously chosen instants.
  function addDistinctInstant() {
    let best: IllustrationPose | undefined, largestDistance = 0.0001;
    for (const { pose, picture } of candidates) {
      const difference = Math.min(...shown.map(other => poseDistance(picture, other)));
      if (difference > largestDistance) {
        best = pose;
        largestDistance = difference;
      }
    }
    if (!best) return false;
    add(best);
    return true;
  }
  addDistinctInstant();

  if (!forReview) {
    if (animation && !animation.loop && poses[poses.length - 1].time !== animation.duration) {
      add({ stage: 0, positions: initial, time: animation.duration, label: animation.label + " · " + animation.duration + " s" });
    }
    for (let stage = 1; stage < stages.length; stage++) addStage(stage);
    handles.forEach((_, i) => { addHandle(i, 0); addHandle(i, 1); });
    return poses;
  }
  if (stages.length > 1) {
    const weight = (stage: typeof stages[number]) => stage.changes.reduce((n, change) =>
      n + (change.shapes || change.hidden !== undefined || change.level !== undefined ? 2 : change.emphasis ? 1 : 0), 0);
    let best = stages.length - 1;
    for (let i = 1; i < stages.length - 1; i++) if (weight(stages[i]) > weight(stages[best])) best = i;
    addStage(best);
  }
  handles.forEach((_, i) => addHandle(i, initial[i] < .5 ? 1 : 0));
  if (handles.length === 1) addHandle(0, initial[0] < .5 ? 0 : 1);
  for (let i = 1; i < stages.length && poses.length < 4; i++) addStage(i);
  while (poses.length < 4) {
    if (!addDistinctInstant()) break;
  }
  if (poses.slice(1).every(pose => pose.time !== undefined)) {
    poses.sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
  }
  return poses;
}
