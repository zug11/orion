import type { SVGProps } from "react";

interface BlocksMarkProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

/** Three document blocks; inherits the current toolbar color. */
export function BlocksMark({ size = 16, ...props }: BlocksMarkProps) {
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      focusable="false"
      data-orion-icon="blocks"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? (props.role ?? "img") : props.role}
      {...props}
    >
      <rect x="4" y="2.5" width="16" height="4.5" rx="1.5" />
      <rect x="4" y="9.75" width="16" height="4.5" rx="1.5" />
      <rect x="4" y="17" width="16" height="4.5" rx="1.5" />
    </svg>
  );
}
