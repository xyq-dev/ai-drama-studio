import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = "a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled])";

export function useModalKeyboard(
  active: boolean,
  containerRef: RefObject<HTMLElement | null>,
  onClose: () => void,
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;
    const inerted: HTMLElement[] = [];
    const mark = (node: HTMLElement) => {
      if (node === container || container.contains(node)) return;
      if (node.contains(container)) {
        for (const child of Array.from(node.children)) {
          if (child instanceof HTMLElement) mark(child);
        }
        return;
      }
      if (!node.hasAttribute("inert")) {
        node.setAttribute("inert", "");
        inerted.push(node);
      }
    };
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement) mark(child);
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.closest("[hidden]") === null);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const current = document.activeElement;
      if (event.shiftKey) {
        if (current === first || !container.contains(current)) {
          event.preventDefault();
          last.focus();
        }
      } else if (current === last || !container.contains(current)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const node of inerted) node.removeAttribute("inert");
    };
  }, [active, containerRef]);
}
