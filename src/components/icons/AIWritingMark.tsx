import type { SVGProps } from "react";

interface AIWritingMarkProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

/** A single restrained four-point mark for Orion's opt-in writing mode. */
export function AIWritingMark({
  size = 24,
  ...props
}: AIWritingMarkProps) {
  const labelled = Boolean(props["aria-label"] || props["aria-labelledby"]);

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      focusable="false"
      data-orion-icon="ai-writing"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? (props.role ?? "img") : props.role}
      {...props}
    >
      <path d="M12 2.35c.46 5.08 2.57 7.19 7.65 7.65-5.08.46-7.19 2.57-7.65 7.65-.46-5.08-2.57-7.19-7.65-7.65 5.08-.46 7.19-2.57 7.65-7.65Z" />
    </svg>
  );
}
