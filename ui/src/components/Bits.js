import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from "motion/react";
import { Fragment, useId } from "react";
/** Text that rises into place letter by letter: used once per screen, for its headline. */
export function RisingText({ text, className, delay = 0 }) {
    const words = text.split(" ");
    let index = 0;
    return (_jsx("span", { className: className, "aria-label": text, children: words.map((word, w) => (_jsxs(Fragment, { children: [_jsx("span", { className: "rise-word", "aria-hidden": "true", children: [...word].map((letter) => {
                        const i = index++;
                        return (_jsx("span", { className: "rise-mask", children: _jsx(motion.span, { className: "rise-letter", initial: { y: "105%" }, animate: { y: "0%" }, transition: { delay: delay + i * 0.022, duration: 0.85, ease: [0.16, 1, 0.3, 1] }, children: letter }) }, i));
                    }) }), w < words.length - 1 && " "] }, `${word}-${w}`))) }));
}
/** A small line chart of a metric's last ten minutes. Gaps (no data) break the line. */
export function Sparkline({ values, tone = "calm", height = 34, width = 150, }) {
    const id = useId();
    const present = values.filter((v) => v !== null);
    if (present.length < 2)
        return _jsx("svg", { width: width, height: height, className: "spark spark-empty", "aria-hidden": "true" });
    const max = Math.max(...present);
    const min = Math.min(...present);
    const span = max - min || max || 1;
    const x = (i) => (i / (values.length - 1)) * width;
    const y = (v) => height - 3 - ((v - min) / span) * (height - 6);
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
    return (_jsxs("svg", { width: width, height: height, viewBox: `0 0 ${width} ${height}`, className: `spark spark-${tone}`, "aria-hidden": "true", children: [_jsx("defs", { children: _jsxs("linearGradient", { id: id, x1: "0", x2: "0", y1: "0", y2: "1", children: [_jsx("stop", { offset: "0", stopColor: "currentColor", stopOpacity: "0.28" }), _jsx("stop", { offset: "1", stopColor: "currentColor", stopOpacity: "0" })] }) }), _jsx("path", { d: area, fill: `url(#${id})` }), _jsx("path", { d: line, fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinejoin: "round" }), _jsx("circle", { cx: x(lastIndex), cy: y(values[lastIndex]), r: "2.6", fill: "currentColor" })] }));
}
export function Panel({ children, className = "", delay = 0, as = "section", label, }) {
    const Tag = motion[as];
    return (_jsx(Tag, { className: `panel ${className}`, "aria-label": label, 
        // No filter animation here: a filter on the panel would stop its backdrop blur working.
        initial: { opacity: 0, y: 14 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: 8, transition: { duration: 0.2 } }, transition: { delay, duration: 0.7, ease: [0.16, 1, 0.3, 1] }, children: children }));
}
