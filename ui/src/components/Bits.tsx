import { motion } from "motion/react";
import { Fragment, useId } from "react";

/** Text that rises into place letter by letter: used once per screen, for its headline. */
export function RisingText({ text, className, delay = 0 }: { text: string; className?: string; delay?: number }) {
  const words = text.split(" ");
  let index = 0;
  return (
    <span className={className}>
      {/* The readable text for screen readers; the animated letters below are hidden from them.
          (aria-label is not allowed on a plain span, so it is real, visually hidden text.) */}
      <span className="visually-hidden">{text}</span>
      {words.map((word, w) => (
        <Fragment key={`${word}-${w}`}>
        <span className="rise-word" aria-hidden="true">
          {[...word].map((letter) => {
            const i = index++;
            return (
              <span key={i} className="rise-mask">
                <motion.span
                  className="rise-letter"
                  initial={{ y: "105%" }}
                  animate={{ y: "0%" }}
                  transition={{ delay: delay + i * 0.022, duration: 0.85, ease: [0.16, 1, 0.3, 1] }}
                >
                  {letter}
                </motion.span>
              </span>
            );
          })}
        </span>
        {w < words.length - 1 && " "}
        </Fragment>
      ))}
    </span>
  );
}

/** A small line chart of a metric's last ten minutes. Gaps (no data) break the line. */
export function Sparkline({
  values,
  tone = "calm",
  height = 34,
  width = 150,
}: {
  values: (number | null)[];
  tone?: "calm" | "sodium" | "flare" | "aurora";
  height?: number;
  width?: number;
}) {
  const id = useId();
  const present = values.filter((v): v is number => v !== null);
  if (present.length < 2) return <svg width={width} height={height} className="spark spark-empty" aria-hidden="true" />;
  const max = Math.max(...present);
  const min = Math.min(...present);
  const span = max - min || max || 1;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - 3 - ((v - min) / span) * (height - 6);
  let line = "";
  let started = false;
  values.forEach((v, i) => {
    if (v === null) {
      started = false;
      return;
    }
    line += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    started = true;
  });
  const lastIndex = values.findLastIndex((v) => v !== null);
  const area = `${line}L${x(lastIndex).toFixed(1)},${height}L${x(values.findIndex((v) => v !== null)).toFixed(1)},${height}Z`;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={`spark spark-${tone}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <circle cx={x(lastIndex)} cy={y(values[lastIndex] as number)} r="2.6" fill="currentColor" />
    </svg>
  );
}

export function Panel({
  children,
  className = "",
  delay = 0,
  as = "section",
  label,
}: {
  children: React.ReactNode;
  className?: string;
  delay?: number;
  as?: "section" | "aside" | "div";
  label?: string;
}) {
  const Tag = motion[as];
  return (
    <Tag
      className={`panel ${className}`}
      aria-label={label}
      // No filter animation here: a filter on the panel would stop its backdrop blur working.
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 8, transition: { duration: 0.2 } }}
      transition={{ delay, duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </Tag>
  );
}
