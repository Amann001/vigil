import { motion, useReducedMotion, useScroll, useSpring, useTransform } from "motion/react";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import "./motion.css";

/*
  The site's motion vocabulary, kept small so every page moves the same way:
  - RollText: a label that rolls up to a copy of itself on hover.
  - Reveal: a heading whose words rise into view, line by line, the first time it is seen.
  - Magnetic: a control that leans a little towards the pointer.
  - Parallax: content that drifts at its own speed as the page scrolls.
  - useSmoothScroll: weighted, inertial scrolling for long pages (Lenis).
  All of them stand still for visitors who ask for reduced motion.
*/

export function RollText({ children }: { children: string }) {
  return (
    <span className="roll">
      <span className="roll-a">{children}</span>
      <span className="roll-b" aria-hidden="true">
        {children}
      </span>
    </span>
  );
}

export function Reveal({ text, className, as = "h2" }: { text: string; className?: string; as?: "h2" | "h3" | "p" }) {
  const reduce = useReducedMotion();
  const Tag = motion[as];
  const words = text.split(" ");
  return (
    <Tag className={className} initial="hidden" whileInView="shown" viewport={{ once: true, margin: "-10% 0px" }}>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true">
        {words.map((word, i) => (
          // The space sits outside the mask: at the end of an inline-block it would be dropped.
          <Fragment key={i}>
            <span className="reveal-mask">
              <motion.span
                className="reveal-word"
                variants={{
                  hidden: { y: reduce ? 0 : "110%" },
                  shown: { y: 0, transition: { duration: 0.9, delay: i * 0.045, ease: [0.16, 1, 0.3, 1] } },
                }}
              >
                {word}
              </motion.span>
            </span>
            {i < words.length - 1 && " "}
          </Fragment>
        ))}
      </span>
    </Tag>
  );
}

export function Magnetic({ children, strength = 0.28 }: { children: ReactNode; strength?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pull, setPull] = useState({ x: 0, y: 0 });
  const reduce = useReducedMotion();
  return (
    <motion.span
      ref={ref}
      className="magnetic"
      onPointerMove={(e) => {
        if (reduce || e.pointerType !== "mouse") return;
        const box = ref.current!.getBoundingClientRect();
        setPull({
          x: (e.clientX - (box.left + box.width / 2)) * strength,
          y: (e.clientY - (box.top + box.height / 2)) * strength,
        });
      }}
      onPointerLeave={() => setPull({ x: 0, y: 0 })}
      animate={pull}
      transition={{ type: "spring", stiffness: 240, damping: 16, mass: 0.6 }}
    >
      {children}
    </motion.span>
  );
}

/** Moves its content by `distance` pixels (up when positive) over the time it crosses the screen. */
export function Parallax({ children, distance = 80, className }: { children: ReactNode; distance?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], reduce ? [0, 0] : [distance / 2, -distance / 2]);
  const smooth = useSpring(y, { stiffness: 120, damping: 30 });
  return (
    <motion.div ref={ref} className={className} style={{ y: smooth }}>
      {children}
    </motion.div>
  );
}

/** Weighted, inertial scrolling while `on` (the home page). Off for reduced motion and touch. */
export function useSmoothScroll(on: boolean) {
  useEffect(() => {
    if (!on || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    let stop = () => {};
    import("lenis").then(({ default: Lenis }) => {
      const lenis = new Lenis({ duration: 1.15, smoothWheel: true });
      const tick = (time: number) => {
        lenis.raf(time);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      stop = () => {
        cancelAnimationFrame(frame);
        lenis.destroy();
      };
    });
    return () => stop();
  }, [on]);
}
