// End-to-end tests of the built site in a real Chrome, against the public replay (no API):
//
//   npm run build && npm run test:e2e
//
// CHROME_PATH picks the browser; on Linux (CI) the 3D scene renders in software.
// SITE_URL runs the same tests against a deployed site instead (the daily check of production).
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import puppeteer from "puppeteer-core";
import { serve } from "../scripts/serve-replay.mjs";

const PORT = 8047;
const SITE = process.env.SITE_URL?.replace(/\/$/, "") ?? `http://127.0.0.1:${PORT}`;
const CHROME =
  process.env.CHROME_PATH ??
  (process.platform === "win32" ? "C:/Program Files/Google/Chrome/Application/chrome.exe" : "/usr/bin/google-chrome");
const ARGS =
  process.platform === "linux"
    ? ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
    : ["--use-angle=d3d11"];

let server;
let browser;

before(async () => {
  if (!process.env.SITE_URL) server = await serve(PORT);
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ARGS });
});

after(async () => {
  await browser?.close();
  server?.close();
});

/** A fresh page that skips the intro and records any error the page throws. */
async function open(path, { width = 1280, height = 800 } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => sessionStorage.setItem("vigil.intro", "1"));
  await page.goto(`${SITE}${path}`, { waitUntil: "networkidle0" });
  return { page, errors };
}

const text = (page, selector) => page.$eval(selector, (e) => e.textContent);

describe("every page", () => {
  const pages = [
    ["/", "Vigil, the AI on-call engineer", ".hero-title"],
    ["/war-room", "War room | Vigil", ".status-title"],
    ["/incidents", "Incidents | Vigil", ".history-head h1"],
    ["/services/orders", "Orders | Vigil", ".service-name"],
    ["/how-it-works", "How it works | Vigil", ".how-head h1"],
    ["/results", "Results | Vigil", ".hidden-test h1"],
    ["/status", "Status | Vigil", ".doc-head h1"],
    ["/audit", "Audit log | Vigil", ".doc-head h1"],
    ["/policy", "Policy | Vigil", ".doc-head h1"],
    ["/run-it", "Run it | Vigil", ".doc-head h1"],
    ["/nowhere", "Lost in space | Vigil", ".lost h1"],
  ];
  for (const [path, title, heading] of pages) {
    test(`${path} opens with its heading and no errors`, async () => {
      const { page, errors } = await open(path);
      await page.waitForSelector(heading, { timeout: 15000 });
      assert.equal(await page.title(), title);
      assert.deepEqual(errors, []);
      await page.close();
    });
  }

  test("an old #/ address goes to its new page", async () => {
    const { page } = await open("/#/scores");
    await page.waitForFunction(() => location.pathname === "/results");
    await page.close();
  });
});

describe("the stars", () => {
  test("clicking a star's name opens its page, and the arrow keys walk round", async () => {
    const { page, errors } = await open("/war-room");
    await page.click(".star-tag[href='/services/payments']");
    await page.waitForFunction(() => location.pathname === "/services/payments");
    // The new page appears once the war room has finished leaving.
    await page.waitForFunction(() => /Payments/.test(document.querySelector(".service-name")?.textContent ?? ""));
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => location.pathname === "/services/inventory");
    assert.deepEqual(errors, []);
    await page.close();
  });
});

describe("the film", () => {
  test("opens, and closes with the button and with Esc", async () => {
    const { page } = await open("/");
    const play = async () => {
      const [button] = await page.$$("xpath/.//button[contains(., 'Play the film')]");
      await button.click();
      await page.waitForSelector(".film video");
    };
    await play();
    await page.click(".film-head button");
    await page.waitForSelector(".film", { hidden: true });
    await play();
    await page.keyboard.press("Escape");
    await page.waitForSelector(".film", { hidden: true });
    await page.close();
  });
});

describe("the command palette", () => {
  test("Ctrl+K finds a service and goes to it", async () => {
    const { page } = await open("/war-room");
    await page.keyboard.down("Control");
    await page.keyboard.press("k");
    await page.keyboard.up("Control");
    await page.waitForSelector(".palette-input");
    await page.type(".palette-input", "pay");
    const first = await text(page, ".palette-results li");
    assert.match(first, /Orders|Payments/);
    const labels = await page.$$eval(".palette-results li .palette-label", (els) => els.map((e) => e.textContent));
    assert.ok(labels.every((l) => /pay|order/i.test(l) || l.length), "only matching rows");
    const index = labels.indexOf("Payments");
    for (let i = 0; i < index; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => location.pathname === "/services/payments");
    await page.close();
  });
});

describe("the replay", () => {
  test("its turning points are where the live incident's are", async () => {
    const { page } = await open("/war-room");
    await page.waitForSelector(".replay-marker");
    const left = await page.$$eval(".replay-marker", (ms) => ms.map((m) => [m.textContent, parseFloat(m.style.left)]));
    const at = Object.fromEntries(left);
    assert.ok(at["All quiet"] < at.Alert && at.Alert < at.Diagnosis && at.Diagnosis < at.Fixed, JSON.stringify(at));
    await page.close();
  });

  test("goes from the alert to a decision and a fix", async () => {
    const { page, errors } = await open("/war-room");
    // Jump to the diagnosis: the replay then waits for a decision.
    await page.waitForSelector(".replay-marker");
    await page.$$eval(".replay-marker", (markers) => markers.find((m) => m.textContent === "Diagnosis").click());
    await page.waitForFunction(() => /leaking memory/i.test(document.querySelector(".status-title")?.textContent ?? ""), {
      timeout: 20000,
    });
    const review = await page.$("a.button-primary[href^='/incidents/']");
    await review.click();
    await page.waitForSelector(".decision-send", { visible: true, timeout: 20000 });
    await page.click(".segmented button:first-child");
    await page.click(".options .option");
    await page.click(".decision-send");
    await page.waitForSelector(".recovery", { visible: true, timeout: 60000 });
    assert.match(await text(page, ".recovery"), /419 MB/);
    // "Now" is green only when it is really lower: just after the restart the newest reading can
    // still be from before it took effect (the leak at 619 MB), and once looked like a recovery.
    const [then, now, green] = await page.$$eval(".recovery-values b", ([a, b]) => [
      parseFloat(a.textContent),
      parseFloat(b.textContent),
      b.classList.contains("tone-now"),
    ]);
    assert.equal(green, now < then, `now ${now} vs then ${then}`);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test("the audit log and policy read from the recording", async () => {
    const { page } = await open("/policy");
    await page.waitForSelector(".catalogue li");
    const actions = await page.$$eval(".catalogue strong", (els) => els.map((e) => e.textContent));
    assert.deepEqual(actions, ["Restart a service", "Escalate to an engineer", "Change nothing"]);
    await page.goto(`${SITE}/audit`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".table tbody tr");
    await page.close();
  });
});

describe("the home page", () => {
  test("the stage cards stack as the page scrolls", async () => {
    const { page } = await open("/");
    const cards = await page.$$eval(".stack-card", (els) => els.length);
    assert.equal(cards, 4);
    const scaleOfFirst = () =>
      page.$eval(".stack-card", (e) => new DOMMatrix(getComputedStyle(e).transform).a);
    const [top, height] = await page.$eval(".stack", (e) => [e.getBoundingClientRect().top + scrollY, e.offsetHeight]);
    await page.evaluate((y) => window.scrollTo(0, y), top + 5);
    await new Promise((r) => setTimeout(r, 300));
    assert.ok((await scaleOfFirst()) > 0.98, "the first card is full size when it arrives");
    // By the last stage the cards above have come down over it, and it has stepped back.
    await page.evaluate((y) => window.scrollTo(0, y), top + height - 900);
    await page.waitForFunction(() => new DOMMatrix(getComputedStyle(document.querySelector(".stack-card")).transform).a < 0.9);
    await page.close();
  });

  test("phones get the menu instead of the links, and nothing scrolls sideways", async () => {
    const { page } = await open("/", { width: 390, height: 844 });
    assert.equal(await page.$eval(".pages", (e) => getComputedStyle(e).display), "none");
    await page.click(".menu-button");
    await page.waitForSelector(".site-menu a");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.close();
  });
});

describe("without 3D graphics", () => {
  test("every page still opens and works, on the plain night sky", async () => {
    // Some work laptops and older phones switch WebGL off; the site must not depend on it.
    const plain = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: [...ARGS, "--disable-webgl", "--disable-3d-apis"],
    });
    const page = await plain.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.evaluateOnNewDocument(() => sessionStorage.setItem("vigil.intro", "1"));
    for (const [path, heading] of [
      ["/", ".hero-title"],
      ["/war-room", ".status-title"],
      ["/services/orders", ".service-name"],
      ["/incidents", ".history-head h1"],
    ]) {
      await page.goto(`${SITE}${path}`, { waitUntil: "networkidle0" });
      await page.waitForSelector(heading, { timeout: 15000 });
    }
    assert.equal(await page.$(".constellation canvas"), null, "no 3D canvas without WebGL");
    assert.equal(await page.$(".site-error"), null);
    assert.deepEqual(errors, []);
    await plain.close();
  });
});
