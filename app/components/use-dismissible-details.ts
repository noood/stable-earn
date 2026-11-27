"use client";

import { useEffect, useRef } from "react";

export function useDismissibleDetails() {
  const menuRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function closeFromOutside(event: PointerEvent) {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.open && !menuRef.current.contains(target)) {
        menuRef.current.removeAttribute("open");
      }
    }

    function closeFromEscape(event: KeyboardEvent) {
      const menu = menuRef.current;
      if (event.key !== "Escape" || event.defaultPrevented || !menu?.open) return;
      const focusInside = event.target instanceof Node && menu.contains(event.target);
      menu.open = false;
      if (focusInside) {
        event.preventDefault();
        menu.querySelector("summary")?.focus();
      }
    }

    document.addEventListener("pointerdown", closeFromOutside);
    // A disclosure with focus handles Escape before its containing dialog.
    document.addEventListener("keydown", closeFromEscape, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape, true);
    };
  }, []);

  return menuRef;
}
