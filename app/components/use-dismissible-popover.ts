import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

export function useDismissiblePopover<TTrigger extends HTMLElement, TPopover extends HTMLElement>(
  open: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  triggerRef: RefObject<TTrigger | null>,
  popoverRef: RefObject<TPopover | null>,
  options: { closeOnOutside?: boolean; closeOnScroll?: boolean } = {},
) {
  const closeOnOutside = options.closeOnOutside ?? true;
  const closeOnScroll = options.closeOnScroll ?? true;
  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && !triggerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) { if (event.key === "Escape") setOpen(false); }
    function closeFromScroll(event: Event) {
      const target = event.target;
      if (target instanceof Node && popoverRef.current?.contains(target)) return;
      setOpen(false);
    }
    if (closeOnOutside) document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    if (closeOnScroll) window.addEventListener("scroll", closeFromScroll, true);
    return () => {
      if (closeOnOutside) document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      if (closeOnScroll) window.removeEventListener("scroll", closeFromScroll, true);
    };
  }, [closeOnOutside, closeOnScroll, open, popoverRef, setOpen, triggerRef]);
}
