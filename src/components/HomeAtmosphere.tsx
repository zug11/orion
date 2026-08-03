import { lazy, Suspense } from "react";
import { resolveAtmospherePalette } from "../lib/homeAtmosphere";
import type {
  HomeAtmosphere as HomeAtmosphereMode,
  HomeAtmosphereMotion,
  HomeAtmosphereTone,
} from "../types";

const SignalDecay = lazy(() => import("./SignalDecay"));
const LineWaves = lazy(() => import("./LineWaves"));
const DotField = lazy(() => import("./DotField"));

interface HomeAtmosphereProps {
  atmosphere: HomeAtmosphereMode;
  tone: HomeAtmosphereTone;
  motion: HomeAtmosphereMotion;
}

export default function HomeAtmosphere({
  atmosphere,
  tone,
  motion,
}: HomeAtmosphereProps) {
  const palette = resolveAtmospherePalette(atmosphere, tone);

  return (
    <div
      className={`home-hero-atmosphere is-${atmosphere}`}
      data-atmosphere={atmosphere}
      aria-hidden="true"
    >
      <Suspense fallback={null}>
        {atmosphere === "signal-decay" ? (
          <SignalDecay palette={palette} motion={motion} />
        ) : atmosphere === "line-waves" ? (
          <LineWaves
            color1={palette.primary}
            color2={palette.secondary}
            color3={palette.tertiary}
            motion={motion}
          />
        ) : (
          <DotField palette={palette} motion={motion} />
        )}
      </Suspense>
    </div>
  );
}
