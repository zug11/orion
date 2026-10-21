import type { SVGProps } from "react";

/** User-supplied chat and voice mark; colour follows the current Orion palette. */
export function ChatVoiceMark({ size = 22, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 22 19" width={size} height={size * 19 / 22}
    fill="none" focusable="false" aria-hidden="true" {...props}>
<path d="M15.3271 7.31525C15.7224 8.30095 15.925 9.38134 15.8889 10.5C15.7876 13.6412 13.8242 16.0129 11.1 17.1983C10.1122 17.6281 9.02431 17.902 7.88891 18C6.40195 18.1284 5.3313 17.5947 4.09999 17.5C2.49456 17.3765 1.75494 18.5 0.888914 18C0.0228883 17.5 1.37976 16 1.37977 14.5C1.37977 13 0.799967 11.8778 0.888914 10.5C1.08658 7.43809 2.65272 4.65701 5.09999 3.32617C6.06839 2.79954 7.17477 2.5 8.38891 2.5C8.802 2.5 9.20646 2.53461 9.59999 2.601" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
<path d="M11.59 2.98386V4.33869" stroke="currentColor" strokeLinecap="round"/>
<path d="M13.19 7.04839V0.5" stroke="currentColor" strokeLinecap="round"/>
<path d="M14.79 5.01613V2.08064" stroke="currentColor" strokeLinecap="round"/>
<path d="M16.39 1.17741V6.14516" stroke="currentColor" strokeLinecap="round"/>
<path d="M17.99 2.98386V4.11289" stroke="currentColor" strokeLinecap="round"/>
  </svg>;
}
