"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type LiquidGlassButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  innerClassName?: string;
};

export const LiquidGlassButton = React.memo(function LiquidGlassButton({
  children,
  className,
  innerClassName,
  style,
  type = "button",
  ...props
}: LiquidGlassButtonProps) {
  const filterId = React.useId().replace(/:/g, "");

  return (
    <>
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute h-0 w-0"
        focusable="false"
      >
        <filter
          id={filterId}
          x="0%"
          y="0%"
          width="100%"
          height="100%"
          filterUnits="objectBoundingBox"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.001 0.005"
            numOctaves="1"
            seed="17"
            result="turbulence"
          />
          <feComponentTransfer in="turbulence" result="mapped">
            <feFuncR type="gamma" amplitude="1" exponent="10" offset="0.5" />
            <feFuncG type="gamma" amplitude="0" exponent="1" offset="0" />
            <feFuncB type="gamma" amplitude="0" exponent="1" offset="0.5" />
          </feComponentTransfer>
          <feGaussianBlur in="turbulence" stdDeviation="3" result="softMap" />
          <feSpecularLighting
            in="softMap"
            surfaceScale="5"
            specularConstant="1"
            specularExponent="100"
            lightingColor="white"
            result="specLight"
          >
            <fePointLight x="-200" y="-200" z="300" />
          </feSpecularLighting>
          <feComposite
            in="specLight"
            operator="arithmetic"
            k1="0"
            k2="1"
            k3="1"
            k4="0"
            result="litImage"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="softMap"
            scale="140"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

      <button
        type={type}
        className={cn(
          "group relative inline-flex overflow-hidden rounded-full text-[#2f241d] transition-all duration-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-black/20 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-wait disabled:opacity-70",
          className,
        )}
        style={{
          boxShadow:
            "0 10px 24px rgba(52, 36, 24, 0.14), 0 0 20px rgba(255, 255, 255, 0.08)",
          transitionTimingFunction: "cubic-bezier(0.175, 0.885, 0.32, 1.4)",
          ...style,
        }}
        {...props}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{
            backdropFilter: "blur(5px)",
            WebkitBackdropFilter: "blur(5px)",
            filter: `url(#${filterId})`,
            isolation: "isolate",
          }}
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full bg-white/30 transition-all duration-700 group-hover:bg-white/36"
        />
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-px rounded-full border border-white/45 bg-[linear-gradient(180deg,rgba(255,255,255,0.42),rgba(255,255,255,0.12))] shadow-[inset_1px_1px_1px_rgba(255,255,255,0.65),inset_-1px_-1px_1px_rgba(255,255,255,0.35)]"
        />

        <span
          className={cn(
            "relative z-10 inline-flex items-center justify-center px-6 py-3 text-[15px] font-medium tracking-[-0.01em] transition-transform duration-700 group-hover:scale-[0.98] group-active:scale-95",
            innerClassName,
          )}
          style={{
            transitionTimingFunction: "cubic-bezier(0.175, 0.885, 0.32, 1.4)",
          }}
        >
          {children}
        </span>
      </button>
    </>
  );
});
