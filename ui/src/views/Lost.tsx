import { motion } from "motion/react";
import { RisingText } from "../components/Bits";
import { href } from "../lib/route";
import "./lost.css";

/** An address that is not a page. */
export function Lost() {
  return (
    <main className="lost">
      <h1>
        <RisingText text="Lost in space." />
      </h1>
      <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }}>
        There is no page at this address. The shop is still being watched, though.
      </motion.p>
      <motion.div className="lost-links" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.7 }}>
        <a className="button button-primary" href={href({ page: "watch" })}>
          Go to the war room
        </a>
        <a className="button button-ghost" href={href({ page: "home" })}>
          Home
        </a>
      </motion.div>
    </main>
  );
}
