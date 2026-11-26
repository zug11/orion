import type { DrawingIcon, OBJECT_GLYPHS } from "../lib/artifactIllustration";
import SunDrawing from "lucide-react/dist/esm/icons/sun.mjs";
import SolarPanelDrawing from "lucide-react/dist/esm/icons/solar-panel.mjs";
import HouseDrawing from "lucide-react/dist/esm/icons/house.mjs";
import FactoryDrawing from "lucide-react/dist/esm/icons/factory.mjs";
import UtilityPoleDrawing from "lucide-react/dist/esm/icons/utility-pole.mjs";
import ZapDrawing from "lucide-react/dist/esm/icons/zap.mjs";
import DropletsDrawing from "lucide-react/dist/esm/icons/droplets.mjs";
import WavesHorizontalDrawing from "lucide-react/dist/esm/icons/waves-horizontal.mjs";
import MountainDrawing from "lucide-react/dist/esm/icons/mountain.mjs";
import LeafDrawing from "lucide-react/dist/esm/icons/leaf.mjs";
import SproutDrawing from "lucide-react/dist/esm/icons/sprout.mjs";
import FlameDrawing from "lucide-react/dist/esm/icons/flame.mjs";
import WindDrawing from "lucide-react/dist/esm/icons/wind.mjs";
import CarDrawing from "lucide-react/dist/esm/icons/car.mjs";
import BikeDrawing from "lucide-react/dist/esm/icons/bike.mjs";
import TrainFrontDrawing from "lucide-react/dist/esm/icons/train-front.mjs";
import PlaneDrawing from "lucide-react/dist/esm/icons/plane.mjs";
import ShipDrawing from "lucide-react/dist/esm/icons/ship.mjs";
import TractorDrawing from "lucide-react/dist/esm/icons/tractor.mjs";
import UsersDrawing from "lucide-react/dist/esm/icons/users.mjs";
import Building2Drawing from "lucide-react/dist/esm/icons/building-2.mjs";
import LandmarkDrawing from "lucide-react/dist/esm/icons/landmark.mjs";
import StoreDrawing from "lucide-react/dist/esm/icons/store.mjs";
import WarehouseDrawing from "lucide-react/dist/esm/icons/warehouse.mjs";
import PiggyBankDrawing from "lucide-react/dist/esm/icons/piggy-bank.mjs";
import ScaleDrawing from "lucide-react/dist/esm/icons/scale.mjs";
import HeartPulseDrawing from "lucide-react/dist/esm/icons/heart-pulse.mjs";
import CpuDrawing from "lucide-react/dist/esm/icons/cpu.mjs";
import GlobeDrawing from "lucide-react/dist/esm/icons/globe.mjs";

// Named imports keep the offline viewer independent of Lucide’s dynamic catalogue.
const objects = {
  sun: SunDrawing,
  "solar-panel": SolarPanelDrawing,
  house: HouseDrawing,
  factory: FactoryDrawing,
  "utility-pole": UtilityPoleDrawing,
  zap: ZapDrawing,
  droplets: DropletsDrawing,
  "waves-horizontal": WavesHorizontalDrawing,
  mountain: MountainDrawing,
  leaf: LeafDrawing,
  sprout: SproutDrawing,
  flame: FlameDrawing,
  wind: WindDrawing,
  car: CarDrawing,
  bike: BikeDrawing,
  "train-front": TrainFrontDrawing,
  plane: PlaneDrawing,
  ship: ShipDrawing,
  tractor: TractorDrawing,
  users: UsersDrawing,
  "building-2": Building2Drawing,
  landmark: LandmarkDrawing,
  store: StoreDrawing,
  warehouse: WarehouseDrawing,
  "piggy-bank": PiggyBankDrawing,
  scale: ScaleDrawing,
  "heart-pulse": HeartPulseDrawing,
  cpu: CpuDrawing,
  globe: GlobeDrawing,
} satisfies Record<(typeof OBJECT_GLYPHS)[number], typeof SunDrawing>;

export function ArtifactDrawingGlyph({ icon, level }: { icon: DrawingIcon; level?: number }) {
  const L = level ?? 0;
  const a = Math.PI * (1 - L);
  const ink = "currentColor",
    tint = "color-mix(in srgb, currentColor 45%, transparent)";
  const fill = { fill: tint, stroke: "none" };
  const ticks = [0.25, 0.5, 0.75];
  const contents = () => {
    switch (icon.name) {
      case "tank":
        return (
          <>
            <rect x="17" y="9" width="30" height="46" rx="5" />
            <rect x="20" y={52 - 40 * L} width="24" height={40 * L} rx="2" {...fill} />
            {ticks.map((t) => (
              <path key={t} d={`M 47 ${55 - 46 * t} h 4`} />
            ))}
          </>
        );
      case "battery":
        return (
          <>
            <rect x="8" y="20" width="44" height="24" rx="4" />
            <rect x="53" y="27" width="3" height="10" rx="1" fill={ink} />
            <rect x="11" y="23" width={38 * L} height="18" rx="2" {...fill} />
          </>
        );
      case "thermometer":
        return (
          <>
            <rect x="27" y="6" width="10" height="42" rx="5" />
            <rect x="30" y={48 - 38 * L} width="4" height={38 * L} rx="2" {...fill} />
            <circle cx="32" cy="51" r="8" fill={tint} />
            {ticks.map((t) => (
              <path key={t} d={`M 40 ${47 - 38 * t} h 4`} />
            ))}
          </>
        );
      case "gauge":
        return (
          <>
            <path d="M 10 42 A 22 22 0 0 1 54 42" strokeWidth="5" opacity=".5" />
            {level !== undefined && (
              <line x1="32" y1="42" x2={32 + 19 * Math.cos(a)} y2={42 - 19 * Math.sin(a)} strokeWidth="3" />
            )}
            <circle cx="32" cy="42" r="2.5" fill={ink} />
          </>
        );
      case "balance": {
        const tilt = ((level ?? 0.5) - 0.5) * 0.6;
        const x = Math.cos(tilt) * 20,
          y = Math.sin(tilt) * 20;
        return (
          <>
            <path d="M 32 18 V 52 M 21 54 H 43" />
            <line x1={32 - x} y1={18 - y} x2={32 + x} y2={18 + y} />
            {[-1, 1].map((side) => (
              <g key={side} transform={`translate(${32 + side * x} ${18 + side * y})`}>
                <path d="M 0 0 L -8 14 Q 0 23 8 14 Z" fill={tint} />
                <path d="M -8 14 H 8" />
              </g>
            ))}
          </>
        );
      }
      case "bar":
        return (
          <>
            <path d="M 8 55 H 56" />
            <rect x="22" y="11" width="20" height="44" rx="2" opacity=".45" />
            <rect x="22" y={55 - 44 * L} width="20" height={44 * L} rx="2" {...fill} />
          </>
        );
      case "pie": {
        const angle = -Math.PI / 2 + 2 * Math.PI * L;
        return (
          <>
            <circle cx="32" cy="32" r="22" fill={L === 1 ? tint : "none"} />
            {L > 0 && L < 1 && (
              <path
                d={`M 32 32 V 10 A 22 22 0 ${L > 0.5 ? 1 : 0} 1 ${32 + 22 * Math.cos(angle)} ${32 + 22 * Math.sin(angle)} Z`}
                fill={tint}
              />
            )}
          </>
        );
      }
      case "coins": {
        const count = level === undefined ? 3 : Math.round(L * 7);
        return (
          <>
            {Array.from({ length: Math.max(count, 1) }, (_, i) => (
              <ellipse
                key={i}
                cx="32"
                cy={50 - i * 5.4}
                rx="15"
                ry="4.6"
                fill={count ? tint : "none"}
                strokeDasharray={count ? undefined : "3 3"}
              />
            ))}
          </>
        );
      }
      default: {
        const Icon = objects[icon.name];
        return <Icon width="64" height="64" strokeWidth="1.65" />;
      }
    }
  };
  return (
    <svg
      x={icon.x}
      y={icon.y}
      width={icon.size}
      height={icon.size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      data-glyph={icon.name}
      fill="none"
      stroke={ink}
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {contents()}
    </svg>
  );
}
