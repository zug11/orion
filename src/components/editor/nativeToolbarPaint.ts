/** Paint only editor chrome, never document content. Native glass owns the
 * foreground as well as its background so they cannot drift during scrolling.
 * The existing DOM controls still own input, focus, selection and accessibility. */
export interface ToolbarPaint { png: string; width: number; height: number }

function visible(element: Element, root: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const overlay = element.closest('[role="menu"],[role="listbox"],[role="dialog"]');
  return style.display !== "none" && style.visibility === "visible" && !element.closest('[hidden],.sr-only') && (!overlay || overlay === root);
}

function shape(element: SVGElement): Path2D | null {
  const number = (key: string) => Number(element.getAttribute(key) ?? 0);
  const path = new Path2D();
  switch (element.localName) {
    case "path": return new Path2D(element.getAttribute("d") ?? "");
    case "line": path.moveTo(number("x1"), number("y1")); path.lineTo(number("x2"), number("y2")); break;
    case "rect": path.roundRect(number("x"), number("y"), number("width"), number("height"), number("rx")); break;
    case "circle": path.arc(number("cx"), number("cy"), number("r"), 0, Math.PI * 2); break;
    case "ellipse": path.ellipse(number("cx"), number("cy"), number("rx"), number("ry"), 0, 0, Math.PI * 2); break;
    case "polyline": case "polygon": {
      const points = (element.getAttribute("points") ?? "").trim().split(/[\s,]+/).map(Number);
      for (let i = 0; i + 1 < points.length; i += 2) {
        if (i === 0) path.moveTo(points[i], points[i + 1]); else path.lineTo(points[i], points[i + 1]);
      }
      if (element.localName === "polygon") path.closePath();
      break;
    }
    default: return null;
  }
  return path;
}

export function paintNativeToolbar(toolbar: HTMLElement): ToolbarPaint | null {
  return paintChrome(toolbar, false);
}

/** Only the existing More menu's controls enter this bounded foreground. */
export function paintNativeMenu(menu: HTMLElement): ToolbarPaint | null {
  if (!menu.matches('.editor-more-menu[role="menu"]')) return null;
  return paintChrome(menu, true);
}

function paintChrome(toolbar: HTMLElement, menu: boolean): ToolbarPaint | null {
  const rect = toolbar.getBoundingClientRect();
  if (rect.width < 24 || rect.width > (menu ? 512 : 2048) || rect.height < 24 || rect.height > (menu ? 768 : 80)) return null;
  const scale = Math.min(2, Math.max(1, window.devicePixelRatio));
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(rect.width * scale); canvas.height = Math.ceil(rect.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.scale(scale, scale);
  // Grouping is whitespace only. Paint actual controls, never group borders.
  const controls = [...toolbar.querySelectorAll<HTMLElement>('button,select,input[type="number"]')];
  if (controls.length > 64) return null;
  for (const control of controls) {
    if (!visible(control, toolbar)) continue;
    const box = control.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const x = box.left - rect.left, y = box.top - rect.top;
    const style = getComputedStyle(control);
    ctx.save();
    ctx.globalAlpha = control.matches(':disabled,[aria-disabled="true"]') || control.closest('[inert]') ? 0.35 : 1;
    ctx.fillStyle = style.backgroundColor;
    ctx.beginPath(); ctx.roundRect(x, y, box.width, box.height, parseFloat(style.borderRadius) || 0); ctx.fill();
    if (parseFloat(style.borderLeftWidth) > 0) {
      // Preserve each control's rounded hover/pressed treatment.
      ctx.strokeStyle = style.borderLeftColor; ctx.lineWidth = parseFloat(style.borderLeftWidth);
      ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, box.width - 1, box.height - 1, parseFloat(style.borderRadius) || 0); ctx.stroke();
    }
    if (control.matches(":focus-visible")) {
      ctx.strokeStyle = getComputedStyle(toolbar).getPropertyValue("--periwinkle").trim(); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.roundRect(x - 1, y - 1, box.width + 2, box.height + 2, 5); ctx.stroke();
    }
    if (control.matches("button,select,input")) {
      for (const svg of control.querySelectorAll<SVGSVGElement>("svg")) {
        if (!visible(svg, toolbar)) continue;
        const svgBox = svg.getBoundingClientRect();
        for (const element of svg.querySelectorAll<SVGGraphicsElement>("path,line,rect,circle,ellipse,polyline,polygon")) {
          const path = shape(element), matrix = element.getCTM();
          if (!path || !matrix) continue;
          const ink = getComputedStyle(element);
          ctx.save(); ctx.translate(svgBox.left - rect.left, svgBox.top - rect.top);
          ctx.transform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
          ctx.lineWidth = parseFloat(ink.strokeWidth) || 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
          if (ink.fill !== "none") { ctx.fillStyle = ink.fill; ctx.fill(path); }
          if (ink.stroke !== "none") { ctx.strokeStyle = ink.stroke; ctx.stroke(path); }
          ctx.restore();
        }
      }
      ctx.fillStyle = style.color;
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      ctx.textBaseline = "middle";
      if (control instanceof HTMLSelectElement || control instanceof HTMLInputElement) {
        const text = control instanceof HTMLSelectElement ? control.selectedOptions[0]?.text ?? "" : control.value;
        ctx.fillText(text, x + (parseFloat(style.paddingLeft) || 8), y + box.height / 2);
        if (control instanceof HTMLSelectElement) {
        ctx.strokeStyle = style.color; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(x + box.width - 16, y + box.height / 2 - 2); ctx.lineTo(x + box.width - 12, y + box.height / 2 + 2); ctx.lineTo(x + box.width - 8, y + box.height / 2 - 2); ctx.stroke();
        }
      } else {
        const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim() || node.parentElement?.closest("svg,.sr-only")) continue;
          const range = document.createRange(); range.selectNodeContents(node);
          const textBox = range.getBoundingClientRect();
          if (textBox.width) {
            const ink = node.parentElement ? getComputedStyle(node.parentElement) : style;
            ctx.fillStyle = ink.color;
            ctx.font = `${ink.fontStyle} ${ink.fontWeight} ${ink.fontSize} ${ink.fontFamily}`;
            ctx.fillText(node.textContent, textBox.left - rect.left, textBox.top - rect.top + textBox.height / 2);
            if (ink.textDecorationLine.includes("line-through")) {
              ctx.fillRect(textBox.left - rect.left, textBox.top - rect.top + textBox.height / 2, textBox.width, 1);
            }
          }
        }
      }
    }
    ctx.restore();
  }
  // Image-width labels sit beside the input rather than inside a button.
  for (const label of toolbar.querySelectorAll<HTMLElement>(".note-image-size > span,.editor-style-select > span:not(.sr-only)")) {
    if (!visible(label, toolbar)) continue;
    const box = label.getBoundingClientRect(), style = getComputedStyle(label);
    ctx.fillStyle = style.color; ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    ctx.textBaseline = "middle"; ctx.fillText(label.textContent ?? "", box.left - rect.left, box.top - rect.top + box.height / 2);
  }
  if (menu && toolbar.scrollHeight > toolbar.clientHeight) {
    const inset = 6, available = rect.height - inset * 2;
    const height = Math.max(24, available * toolbar.clientHeight / toolbar.scrollHeight);
    const y = inset + (available - height) * toolbar.scrollTop / (toolbar.scrollHeight - toolbar.clientHeight);
    ctx.fillStyle = getComputedStyle(toolbar).getPropertyValue("--muted").trim();
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.roundRect(rect.width - 5, y, 3, height, 1.5); ctx.fill();
  }
  const png = canvas.toDataURL("image/png").split(",")[1];
  return png && png.length <= (menu ? 700_000 : 350_000) ? { png, width: canvas.width, height: canvas.height } : null;
}
