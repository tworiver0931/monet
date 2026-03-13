"use client"
import { AnimatePresence, motion } from "motion/react"
import type React from "react"
import { useMemo } from "react"

export interface BlurRevealProps {
  children: string
  className?: string
  delay?: number
  speedReveal?: number
  speedSegment?: number
  trigger?: boolean
  onAnimationComplete?: () => void
  onAnimationStart?: () => void
  as?: keyof React.JSX.IntrinsicElements
  style?: React.CSSProperties
  inView?: boolean
  once?: boolean
  letterSpacing?: string | number
}

export function BlurReveal({
  children,
  className,
  delay = 0,
  speedReveal = 1.5,
  speedSegment = 0.5,
  trigger = true,
  onAnimationComplete,
  onAnimationStart,
  as = "p",
  style,
  inView = false,
  once = true,
  letterSpacing,
}: BlurRevealProps) {
  const MotionTag = motion[as as keyof typeof motion] as typeof motion.div

  const stagger = 0.03 / speedReveal
  const baseDuration = 0.3 / speedSegment

  // Count total characters (including spaces between words)
  const totalChars = children
    ? children.split(" ").reduce((acc, word, i, arr) => {
        return acc + word.length + (i < arr.length - 1 ? 1 : 0)
      }, 0)
    : 0

  // Pre-compute all character delays once
  const charDelays = useMemo(() => {
    if (totalChars <= 1) return [delay]
    const delays = new Array(totalChars)
    let cumulative = 0
    for (let i = 0; i < totalChars; i++) {
      delays[i] = delay + cumulative
      const t = i / (totalChars - 1)
      const bellCurve = Math.exp(-((t - 0.5) ** 2) / 0.05)
      cumulative += stagger * (1 + 3 * bellCurve)
    }
    return delays
  }, [totalChars, delay, stagger])

  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        delayChildren: 0,
      },
    },
    exit: {
      transition: {
        staggerChildren: stagger,
        staggerDirection: -1,
      },
    },
  }

  // Pre-compute all item variants once
  const allItemVariants = useMemo(() => {
    return charDelays.map((charDelay) => ({
      hidden: { opacity: 0, filter: "blur(12px)", y: 10 },
      visible: {
        opacity: 1,
        filter: "blur(0px)",
        y: 0,
        transition: {
          duration: baseDuration,
          delay: charDelay,
        },
      },
      exit: { opacity: 0, filter: "blur(12px)", y: 10 },
    }))
  }, [charDelays, baseDuration])

  return (
    <AnimatePresence mode="popLayout">
      {trigger && (
        <MotionTag
          initial="hidden"
          whileInView={inView ? "visible" : undefined}
          animate={inView ? undefined : "visible"}
          exit="exit"
          variants={containerVariants}
          viewport={{ once }}
          className={className}
          onAnimationComplete={onAnimationComplete}
          onAnimationStart={onAnimationStart}
          style={style}
        >
          <span className="sr-only">{children}</span>
          {children &&
            (() => {
              let globalIndex = 0
              return children.split(" ").map((word, wordIndex, wordsArray) => (
                <span key={`word-${wordIndex}`} className="inline-block whitespace-nowrap" aria-hidden="true">
                  {word.split("").map((char, charIndex) => {
                    const idx = globalIndex++
                    return (
                      <motion.span
                        key={`char-${wordIndex}-${charIndex}`}
                        variants={allItemVariants[idx]}
                        className="inline-block"
                        style={letterSpacing ? { marginRight: letterSpacing } : undefined}
                      >
                        {char}
                      </motion.span>
                    )
                  })}
                  {wordIndex < wordsArray.length - 1 &&
                    (() => {
                      const idx = globalIndex++
                      return (
                        <motion.span
                          key={`space-${wordIndex}`}
                          variants={allItemVariants[idx]}
                          className="inline-block"
                        >
                          &nbsp;
                        </motion.span>
                      )
                    })()}
                </span>
              ))
            })()}
        </MotionTag>
      )}
    </AnimatePresence>
  )
}
