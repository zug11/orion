import type { SVGProps } from "react";

interface AIWritingMarkProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

/** A clear four-point sparkle for Orion's opt-in AI tools. */
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
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      focusable="false"
      data-orion-icon="ai-writing"
      aria-hidden={labelled ? undefined : true}
      role={labelled ? (props.role ?? "img") : props.role}
      {...props}
    >
      <path d="M12 2.5 14.7 9.3 21.5 12 14.7 14.7 12 21.5 9.3 14.7 2.5 12 9.3 9.3Z" />
    </svg>
  );
}
