"use client";

import bgImg from "@/public/bg-img.webp";
import { motion } from "motion/react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Signature } from "@/components/signature";
import { BlurReveal } from "@/components/blur-reveal";
import { useHomeScreenTransition } from "@/components/home-screen-transition";
import { LiquidGlassButton } from "@/components/ui/liquid-glass";

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL || "http://localhost:8000";

export default function Home() {
  const router = useRouter();
  const [isCreating, setIsCreating] = useState(false);
  const [isLeavingHome, setIsLeavingHome] = useState(false);
  const { beginHomeTransition, cancelHomeTransition } =
    useHomeScreenTransition();

  async function handleStart() {
    if (isCreating) {
      return;
    }

    setIsCreating(true);
    setIsLeavingHome(true);
    beginHomeTransition(bgImg.src);

    try {
      const res = await fetch(`${BACKEND_URL}/api/create-session`, {
        method: "POST",
      });

      if (!res.ok) {
        throw new Error(`Failed to create session: ${res.status}`);
      }

      const { sessionId, userId } = await res.json();
      router.push(`/chats/${sessionId}?userId=${userId}`);
    } catch (error) {
      console.error("Failed to create session:", error);
      cancelHomeTransition();
      setIsCreating(false);
      setIsLeavingHome(false);
    }
  }

  return (
    <div className="relative flex h-dvh flex-col overflow-hidden">
      <div className="absolute inset-0">
        <Image src={bgImg} alt="" fill className="object-cover" priority />
      </div>

      <div
        className={`isolate flex h-full grow flex-col transition-all duration-700 ease-out ${
          isLeavingHome
            ? "pointer-events-none scale-95 opacity-0 blur-sm"
            : "scale-100 opacity-100 blur-0"
        }`}
      >
        <div className="flex grow flex-col items-center justify-center px-4">
          <span className="mb-6 inline-flex shrink-0 items-center rounded-full border-[0.5px] border-[#BABABA] px-3.5 py-1.5 text-black">
            <span className="text-center text-base text-neutral-900">
              <BlurReveal as="span" delay={1.5} speedReveal={4} inView>
                Powered by
              </BlurReveal>{" "}
              <BlurReveal
                as="span"
                className="font-semibold"
                delay={1.68}
                speedReveal={2}
                inView
              >
                Gemini
              </BlurReveal>
              <BlurReveal as="span" delay={2.27} speedReveal={4} inView>
                .
              </BlurReveal>
            </span>
          </span>

          <Signature
            text="Monet"
            fontSize={54}
            imageUrl="/title-text-img.webp"
            duration={1}
            inView
          />

          <BlurReveal
            delay={0.6}
            speedReveal={3}
            className="mt-10 max-w-md text-center text-2xl font-medium text-neutral-900"
          >
            The realtime canvas where sketch and talk become software.
          </BlurReveal>

          <motion.div
            initial={{ opacity: 0, y: 10, filter: "blur(4px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.5, delay: 2, ease: "easeOut" }}
          >
            <LiquidGlassButton
              onClick={handleStart}
              disabled={isCreating}
              className="mt-8 hover:-translate-y-0.5"
              innerClassName="min-w-[144px]"
            >
              <span className="font-semibold text-neutral-800">
                Start Building
              </span>
            </LiquidGlassButton>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

export const runtime = "edge";
