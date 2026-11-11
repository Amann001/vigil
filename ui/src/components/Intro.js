import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { motion } from "motion/react";
import { useEffect, useRef } from "react";
import "./intro.css";
const SEEN_KEY = "vigil.intro";
const DURATION_MS = 3200;
export function introSeen() {
    try {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches)
            return true;
        return sessionStorage.getItem(SEEN_KEY) === "1";
    }
    catch {
        return false;
    }
}
/**
 * The one orchestrated moment: the name rises out of the dark while the camera travels in
 * from deep space to the shop, then the night watch begins. Once per visit; any key or click
 * skips it.
 */
export function Intro({ onDone }) {
    // The app re-renders with every poll; the timer must not restart each time.
    const done = useRef(onDone);
    done.current = onDone;
    useEffect(() => {
        const finish = () => {
            try {
                sessionStorage.setItem(SEEN_KEY, "1");
            }
            catch {
                /* the intro simply plays again next time */
            }
            done.current();
        };
        const timer = window.setTimeout(finish, DURATION_MS);
        window.addEventListener("keydown", finish);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener("keydown", finish);
        };
    }, []);
    const word = "Vigil";
    return (_jsxs(motion.div, { className: "intro", onClick: onDone, initial: { opacity: 1 }, exit: { opacity: 0, transition: { duration: 1.1, ease: [0.16, 1, 0.3, 1] } }, role: "presentation", children: [_jsx("h1", { className: "intro-word", "aria-label": word, children: [...word].map((letter, i) => (_jsx("span", { className: "rise-mask", children: _jsx(motion.span, { className: "rise-letter", initial: { y: "110%" }, animate: { y: "0%" }, transition: { delay: 0.25 + i * 0.07, duration: 1.1, ease: [0.16, 1, 0.3, 1] }, children: letter }) }, i))) }), _jsx(motion.p, { className: "intro-line", initial: { opacity: 0, y: 10, letterSpacing: "0.2em" }, animate: { opacity: 1, y: 0, letterSpacing: "0.02em" }, transition: { delay: 0.95, duration: 1.4, ease: [0.16, 1, 0.3, 1] }, children: "The AI on-call engineer that never sleeps." }), _jsx(motion.span, { className: "intro-skip", initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { delay: 1.6 }, children: "Click to skip" })] }));
}
