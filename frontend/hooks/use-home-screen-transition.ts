"use client";

import { useContext } from "react";
import { HomeScreenTransitionContext } from "@/components/home-screen-transition";

export function useHomeScreenTransition() {
  const context = useContext(HomeScreenTransitionContext);

  if (!context) {
    throw new Error(
      "useHomeScreenTransition must be used within HomeScreenTransitionProvider",
    );
  }

  return context;
}
