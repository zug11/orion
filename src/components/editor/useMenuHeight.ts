import { useLayoutEffect, useState, type RefObject } from "react";

/** Keep toolbar popovers below their trigger and inside the window. */
export function useMenuHeight(open: boolean, trigger: RefObject<HTMLElement | null>) {
  const [height, setHeight] = useState(320);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const bottom = trigger.current?.getBoundingClientRect().bottom ?? 0;
      setHeight(Math.max(80, window.innerHeight - bottom - 26));
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, trigger]);
  return height;
}
