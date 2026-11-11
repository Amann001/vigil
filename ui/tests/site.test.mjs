// End-to-end tests of the built site in a real Chrome, against the public replay (no API):
//
//   npm run build && npm run test:e2e
//
// CHROME_PATH picks the browser; on Linux (CI) the 3D scene renders in software.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import puppeteer from "puppeteer-core";
import { serve } from "../scripts/serve-replay.mjs";

const PORT = 8047;
const SITE = `http://127.0.0.1:${PORT}`;
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
  server = await serve(PORT);
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
  test("the deck turns as the page scrolls", async () => {
    const { page } = await open("/");
    const front = () => page.$eval(".deck-card.is-front h3", (e) => e.textContent);
    const deck = await page.$eval(".story-team", (e) => [e.getBoundingClientRect().top + scrollY, e.offsetHeight - innerHeight]);
    await page.evaluate((y) => window.scrollTo(0, y), deck[0] + 5);
    await page.waitForSelector(".deck-card.is-front");
    const first = await front();
    await page.evaluate((y) => window.scrollTo(0, y), deck[0] + deck[1] * 0.85);
    await page.waitForFunction((was) => document.querySelector(".deck-card.is-front h3")?.textContent !== was, {}, first);
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
