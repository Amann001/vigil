// Captures the site's two pictures from the public replay in headless Chrome:
//   public/shots/incident.webp  the product shot on the home page: the recorded incident's page
//                               at the moment it waits for a person
//   public/og.png               the preview shown when the site's link is shared: the hero
// A real screen of the product rather than a drawing of one, so it can never promise more than
// the product does. Re-run it after a visible change to the incident page.
//
//   npm run build
//   node scripts/capture-shot.mjs                # needs Chrome
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";
import { serve } from "./serve-replay.mjs";

const PORT = 8042;
const SITE = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "public/shots/incident.webp";

const server = await serve(PORT);
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-angle=d3d11", "--hide-scrollbars"],
  defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1.5 },
});
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => sessionStorage.setItem("vigil.intro", "1"));
  await page.goto(`${SITE}/war-room`, { waitUntil: "networkidle0" });
  // Jump the replay to its diagnosis, then open the incident it is waiting on.
  await page.waitForSelector(".replay-marker");
  await page.$$eval(".replay-marker", (markers) => markers.find((m) => m.textContent === "Diagnosis").click());
  await page.waitForFunction(() => /leaking memory/i.test(document.querySelector(".status-title")?.textContent ?? ""), {
    timeout: 20000,
  });
  await page.click("a.button-primary[href^='/incidents/']");
  await page.waitForSelector(".decision-send", { visible: true, timeout: 20000 });
  // The replay's own banner and the grain are for visitors, not for a still picture.
  await page.addStyleTag({ content: ".replay-bar, .replay-note, .grain { display: none !important; }" });
  await new Promise((r) => setTimeout(r, 2500)); // let the camera settle on the star
  mkdirSync("public/shots", { recursive: true });
  await page.screenshot({ path: OUT, type: "webp", quality: 82 });
  console.log(`wrote ${OUT}`);

  // The share preview: 1200 x 630, the size LinkedIn, Slack and X expect.
  await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
  await page.goto(`${SITE}/`, { waitUntil: "networkidle0" });
  await page.addStyleTag({ content: ".grain, .scroll-cue, .hero-hint, .replay-bar, .cursor { display: none !important; }" });
  await new Promise((r) => setTimeout(r, 4000)); // the headline rises and the camera settles
  await page.screenshot({ path: "public/og.png", type: "png" });
  console.log("wrote public/og.png");
} finally {
  await browser.close();
  server.close();
}
