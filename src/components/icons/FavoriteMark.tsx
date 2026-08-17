import type { SVGProps } from "react";

interface FavoriteMarkProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

// User-supplied bookmark shape, adapted to inherit Orion's active theme color.
export function FavoriteMark({
  size = 24,
  ...props
}: FavoriteMarkProps) {
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 98"
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      data-orion-icon="favorite"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? (props.role ?? "img") : props.role}
      {...props}
    >
      <path d="m67 6.7h-34c-7.6 0-14.4 6.2-14.4 14.2v67.6c0 2.7 3 4.1 5.2 2.4l26.2-18.6 25.9 18.3c2.1 1.6 5.4 0.6 5.4-2.3v-67.4c0-7.8-6.4-14.2-14.3-14.2zm7.7 74.8-22.8-16.5c-1.1-0.8-2.7-0.8-3.8 0l-22.7 16.5v-60.6c0-4.1 3.2-7.6 7.8-7.6h33.8c3.9 0 7.7 2.8 7.7 7.6v60.6z" />
    </svg>
  );
}
