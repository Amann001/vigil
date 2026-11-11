// Records the demo video (docs/demo/vigil-demo.mp4): drives the war room's public replay
// through the recorded incident in headless Chrome, with captions and a visible pointer drawn
// into the page, then assembles the frames into a 60 fps MP4 with ffmpeg.
//
//   npm run build
//   python -m http.server 8040 --bind 127.0.0.1 --directory dist    # no API: the replay plays
//   node scripts/record-video.mjs                                   # needs Chrome and ffmpeg
import puppeteer from "puppeteer-core";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";

const URL = process.env.TOUR_URL ?? "http://127.0.0.1:8040/#/";
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = "video-frames";
const VIDEO = process.argv[2] ?? "vigil-demo.mp4";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--hide-scrollbars"],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));

const OVERLAY = `
  .tour-caption { position: fixed; right: 32px; bottom: 30px; z-index: 9999; max-width: 470px;
    padding: 16px 20px; border-radius: 14px; background: rgb(10 16 40 / 0.72);
    border: 1px solid rgb(232 237 255 / 0.12); backdrop-filter: blur(14px);
    font: 500 19px/1.4 "Geist Variable", "Geist", system-ui, sans-serif; color: #e8edff;
    opacity: 0; transform: translateY(10px); transition: opacity .6s cubic-bezier(.16,1,.3,1), transform .6s cubic-bezier(.16,1,.3,1); }
  .tour-caption.is-on { opacity: 1; transform: none; }
  .tour-caption small { display: block; margin-bottom: 4px; font-size: 14px; color: #ffa53d; font-weight: 600; }
  .tour-pointer { position: fixed; z-index: 10000; width: 22px; height: 22px; margin: -11px 0 0 -11px;
    border-radius: 50%; border: 2px solid #e8edff; background: rgb(232 237 255 / 0.18);
    box-shadow: 0 0 18px rgb(232 237 255 / 0.5); pointer-events: none; left: 50%; top: 110%;
    transition: left .9s cubic-bezier(.65,0,.35,1), top .9s cubic-bezier(.65,0,.35,1), transform .15s; }
  .tour-pointer.is-press { transform: scale(0.7); }
  .replay-note { display: none !important; }
`;

async function setup() {
  await page.evaluate((css) => {
    if (document.querySelector(".tour-caption")) return;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    const cap = document.createElement("div");
    cap.className = "tour-caption";
    const ptr = document.createElement("div");
    ptr.className = "tour-pointer";
    document.body.append(cap, ptr);
  }, OVERLAY);
}

async function caption(text, label = "") {
  await page.evaluate(async (text, label) => {
    const cap = document.querySelector(".tour-caption");
    if (cap.classList.contains("is-on")) {
      cap.classList.remove("is-on");
      await new Promise((r) => setTimeout(r, 450));
    }
    if (!text) return;
    cap.innerHTML = (label ? `<small>${label}</small>` : "") + text;
    cap.classList.add("is-on");
  }, text, label);
}

async function click(selector, { pause = 500 } = {}) {
  const el = await page.waitForSelector(selector, { visible: true, timeout: 120000 });
  await el.evaluate((e) => e.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  await sleep(400);
  const box = await el.boundingBox();
  await page.evaluate((x, y) => {
    const p = document.querySelector(".tour-pointer");
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
  }, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(1000);
  await page.evaluate(() => document.querySelector(".tour-pointer").classList.add("is-press"));
  await el.click();
  await sleep(160);
  await page.evaluate(() => document.querySelector(".tour-pointer").classList.remove("is-press"));
  await sleep(pause);
}

async function pointerAway() {
  await page.evaluate(() => {
    const p = document.querySelector(".tour-pointer");
    p.style.left = "70%";
    p.style.top = "110%";
  });
}

const textIs = (selector, pattern) =>
  page.waitForFunction(
    (s, p) => [...document.querySelectorAll(s)].some((e) => new RegExp(p).test(e.textContent)),
    { timeout: 240000, polling: 200 },
    selector,
    pattern,
  );

await page.goto(URL, { waitUntil: "networkidle0" });
// Every frame Chrome paints is saved with its timestamp; the video is assembled afterwards,
// so slow encoding can never drop frames.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT);
const cdp = await page.createCDPSession();
const shots = [];
cdp.on("Page.screencastFrame", (f) => {
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
  const name = `${String(shots.length).padStart(6, "0")}.jpg`;
  writeFileSync(`${OUT}/${name}`, Buffer.from(f.data, "base64"));
  shots.push([name, f.metadata.timestamp]);
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
const rec = { stop: async () => {
  await cdp.send("Page.stopScreencast");
  const end = Date.now() / 1000;
  const lines = shots.map(([n, t], i) => `file '${n}'
duration ${((shots[i + 1]?.[1] ?? end) - t).toFixed(4)}`);
  writeFileSync(`${OUT}/list.txt`, lines.join("\n") + `\nfile '${shots.at(-1)[0]}'\n`);
  console.log("frames", shots.length, "seconds", (end - shots[0][1]).toFixed(1));
} };
const t0 = Date.now();
const mark = (what) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), what);

await setup();
mark("intro");
await sleep(7500);
await caption("A small online shop, running live. Each star is a service; each spark is a real request between them.", "What you are watching");
await sleep(6500);
await caption("Someone has quietly made Orders leak memory. Nobody tells Vigil.", "The fault");
await textIs(".status-title", "wrong");
mark("alert");
await caption("Vigil's anomaly detector notices on its own and raises the alarm. A team of AI agents starts investigating.", "Detected");
await sleep(5000);
await caption("");
await click("a.button[href^='#/incident']", { pause: 300 }).catch(() => click(".status a[href^='#/incident']"));
await pointerAway();
mark("incident");
await sleep(1200);
await caption("A supervisor agent asks questions; specialists read the logs, metrics and recent deploys to answer them. Every step shows up as it happens.", "Investigating");
await page.waitForSelector(".decision-send", { visible: true, timeout: 240000 });
mark("review");
await sleep(1500);
await caption("Diagnosis: Orders is leaking memory. The proposed fix is a restart, but nothing changes until a person approves it.", "Waiting for you");
await page.evaluate(() => document.querySelector(".story-title")?.scrollIntoView({ behavior: "smooth" }));
await sleep(6000);
await click(".segmented button:first-child");
await click(".options .option");
await caption("The reviewer confirms the diagnosis and approves the restart.", "Approved");
await click(".decision-send", { pause: 300 });
await pointerAway();
await page.waitForSelector(".recovery", { visible: true, timeout: 240000 });
mark("fixed");
await caption("Orders restarts. Its memory drops from 419 MB back to normal, and Vigil writes the incident report for next time.", "Fixed");
await page.evaluate(() => document.querySelector(".recovery")?.scrollIntoView({ behavior: "smooth", block: "center" }));
await sleep(8000);
await caption("");
await click("a.brand", { pause: 300 });
await pointerAway();
mark("watch");
await textIs(".status-title", "back");
await sleep(4000);
await caption("");
await click(".watchbar a[href='#/scores'], nav a[href='#/scores']", { pause: 300 });
await pointerAway();
mark("scores");
await caption("Tested on six scenarios written by someone else: every incident diagnosed and fixed right, with no false alarms.", "Measured");
for (let i = 0; i < 6; i++) {
  await page.mouse.wheel({ deltaY: 260 });
  await sleep(1300);
}
await sleep(1500);
await caption("");
await click("a.brand", { pause: 300 });
await pointerAway();
await sleep(3500);
await caption("");
// The closing card reuses the intro's own styles, so it matches the opening.
await page.evaluate(() => {
  const card = document.createElement("div");
  card.className = "intro";
  card.style.cssText = "background:radial-gradient(60% 55% at 50% 50%, rgb(4 7 20 / 0.55), rgb(4 7 20 / 0.97));opacity:0;transition:opacity 1.4s cubic-bezier(.16,1,.3,1);cursor:default";
  card.innerHTML = `<h1 class="intro-word">Vigil</h1>
    <p class="intro-line">The AI on-call engineer that never sleeps.</p>
    <p class="intro-line" style="font-size:17px;color:#545e86;margin-top:6px">Detects with ML, investigates with a team of LLM agents, fixes only with a human's approval.<br>Python, LangGraph, PostgreSQL + pgvector, ONNX, React Three Fiber. Free tiers only.</p>`;
  document.body.append(card);
  requestAnimationFrame(() => requestAnimationFrame(() => (card.style.opacity = "1")));
});
await sleep(7000);
mark("end");
await rec.stop();
await browser.close();

// Each frame is shown for as long as it was on screen, then resampled to a steady 60 fps.
const seconds = (shots.at(-1)[1] - shots[0][1]).toFixed(2);
const ffmpeg = spawnSync("ffmpeg", [
  "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${OUT}/list.txt`,
  "-vf", `fps=60,fade=t=in:st=0:d=0.6,fade=t=out:st=${seconds - 1}:d=1.2,format=yuv420p`,
  "-c:v", "libx264", "-crf", "25", "-preset", "slower", "-movflags", "+faststart", VIDEO,
], { stdio: "inherit" });
if (ffmpeg.status === 0) rmSync(OUT, { recursive: true, force: true });
console.log(ffmpeg.status === 0 ? `wrote ${VIDEO}` : "ffmpeg failed; frames kept in " + OUT);
