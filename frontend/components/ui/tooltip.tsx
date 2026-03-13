"use client";

import { useRef, useState } from "react";
import { createPortal } from "react-dom";

export function Tooltip({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [show, setShow] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  const handleEnter = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      setPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setShow(true);
  };

  return (
    <div
      ref={triggerRef}
      onMouseEnter={handleEnter}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show &&
        createPortal(
          <span
            className="pointer-events-none fixed z-50 -translate-x-1/2 whitespace-nowrap rounded bg-gray-900/80 px-2 py-0.5 text-[10px] text-white shadow"
            style={{ left: pos.x, top: pos.y - 28 }}
          >
            {label}
          </span>,
          document.body,
        )}
    </div>
  );
}
