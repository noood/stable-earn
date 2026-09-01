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
      if (event.key === "Escape") menuRef.current?.removeAttribute("open");
    }

    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, []);

  return menuRef;
}
