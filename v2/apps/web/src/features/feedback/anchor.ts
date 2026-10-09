/**
 * Where a note is pinned: the element tapped (as a CSS path), where inside it,
 * and the page position as a fallback. Anchoring to the element keeps a pin on
 * its button when the page is opened at another screen size.
 */
export type Anchor = { selector: string; label: string; offsetX: number; offsetY: number; pageX: number; pageY: number; viewportWidth: number };

const MEANINGFUL = "button, a, input, select, textarea, label, [role], h1, h2, h3, h4, td, th, li, img, p";
const generatedId = (id: string) => /^(mantine-|:r|«|r\d)/.test(id);

/** The element a tap means: the nearest control, heading or cell, else what was hit. */
export const targetOf = (el: Element) => el.closest(MEANINGFUL) ?? el;

export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node !== document.body && parts.length < 10) {
    if (node.id && !generatedId(node.id)) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      return parts.join(" > ");
    }
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.tagName.toLowerCase();
    const same = Array.from(parent.children).filter((child) => child.tagName === node!.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
    node = parent;
  }
  return `body > ${parts.join(" > ")}`;
}

export function labelFor(el: Element): string {
  const text = el.getAttribute("aria-label") || el.getAttribute("alt") || el.getAttribute("placeholder") || el.textContent || el.tagName.toLowerCase();
  return text.trim().replace(/\s+/g, " ").slice(0, 80);
}

export function anchorAt(el: Element, clientX: number, clientY: number): Anchor {
  const rect = el.getBoundingClientRect();
  return {
    selector: selectorFor(el),
    label: labelFor(el),
    offsetX: rect.width ? (clientX - rect.left) / rect.width : 0.5,
    offsetY: rect.height ? (clientY - rect.top) / rect.height : 0.5,
    pageX: clientX + window.scrollX,
    pageY: clientY + window.scrollY,
    viewportWidth: window.innerWidth,
  };
}

/** Where the pin goes now, in page coordinates. */
export function locate(anchor: Anchor): { x: number; y: number } {
  let el: Element | null = null;
  try {
    el = document.querySelector(anchor.selector);
  } catch {
    el = null;
  }
  if (el) {
    const rect = el.getBoundingClientRect();
    if (rect.width || rect.height) {
      return { x: rect.left + window.scrollX + rect.width * anchor.offsetX, y: rect.top + window.scrollY + rect.height * anchor.offsetY };
    }
  }
  return { x: Math.min(anchor.pageX, document.documentElement.scrollWidth - 20), y: anchor.pageY };
}
