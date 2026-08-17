import { lazy, Suspense, useMemo, type CSSProperties } from "react";
import { resolveAtmospherePalette } from "../lib/homeAtmosphere";
import type { ThemePalette } from "../lib/theme";
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
  themePalette: ThemePalette;
}

export default function HomeAtmosphere({
  atmosphere,
  tone,
  motion,
  themePalette,
}: HomeAtmosphereProps) {
  const palette = useMemo(
    () => resolveAtmospherePalette(atmosphere, tone, themePalette),
    [atmosphere, themePalette, tone],
  );

  return (
    <div
      className={`home-hero-atmosphere is-${atmosphere}`}
      data-atmosphere={atmosphere}
      style={
        {
          "--atmosphere-background": palette.background,
          "--atmosphere-background-secondary": palette.backgroundSecondary,
          "--atmosphere-primary": palette.primary,
          "--atmosphere-secondary": palette.secondary,
          "--atmosphere-tertiary": palette.tertiary,
          "--atmosphere-bright": palette.bright,
          "--atmosphere-muted": palette.muted,
        } as CSSProperties
      }
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
