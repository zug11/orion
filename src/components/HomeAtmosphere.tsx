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
const QuietLoom = lazy(() => import("./QuietLoom"));
const Nova = lazy(() => import("./Nova"));
const Flux = lazy(() => import("./Flux"));
const TidalGlass = lazy(() => import("./TidalGlass"));
const PrismDrift = lazy(() => import("./PrismDrift"));
const Nebula = lazy(() => import("./Nebula"));
const Emberwake = lazy(() => import("./Emberwake"));
const GravitySilk = lazy(() => import("./GravitySilk"));
const Mirage = lazy(() => import("./Mirage"));

interface HomeAtmosphereProps {
  atmosphere: HomeAtmosphereMode;
  tone: HomeAtmosphereTone;
  customColor?: string;
  customSecondaryColor?: string;
  motion: HomeAtmosphereMotion;
  themePalette: ThemePalette;
}

export default function HomeAtmosphere({
  atmosphere,
  tone,
  customColor,
  customSecondaryColor,
  motion,
  themePalette,
}: HomeAtmosphereProps) {
  const palette = useMemo(
    () =>
      resolveAtmospherePalette(
        atmosphere,
        tone,
        themePalette,
        customColor,
        customSecondaryColor,
      ),
    [atmosphere, themePalette, tone, customColor, customSecondaryColor],
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
        ) : atmosphere === "emberwake" ? (
          <Emberwake palette={palette} motion={motion} />
        ) : atmosphere === "gravity-silk" ? (
          <GravitySilk palette={palette} motion={motion} />
        ) : atmosphere === "mirage" ? (
          <Mirage palette={palette} motion={motion} />
        ) : atmosphere === "flux" ? (
          <Flux palette={palette} motion={motion} />
        ) : atmosphere === "tidal-glass" ? (
          <TidalGlass palette={palette} motion={motion} />
        ) : atmosphere === "prism-drift" ? (
          <PrismDrift palette={palette} motion={motion} />
        ) : atmosphere === "nebula" ? (
          <Nebula palette={palette} motion={motion} />
        ) : atmosphere === "nova" ? (
          <Nova palette={palette} motion={motion} />
        ) : atmosphere === "quiet-loom" ? (
          <QuietLoom palette={palette} motion={motion} />
        ) : (
          <DotField palette={palette} motion={motion} />
        )}
      </Suspense>
    </div>
  );
}
