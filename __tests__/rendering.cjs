/*
 * File: __tests__/rendering.cjs
 * Desc: Bounded, offline checks for the public MD renderer contract.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium, firefox, webkit } = require("playwright");
const engine = process.env.BROWSER_ENGINE || "chromium";
assert.ok(["chromium", "firefox", "webkit"].includes(engine), "Unsupported BROWSER_ENGINE");

test("MD library", { timeout: 30000 }, async (t) => {
  const browser = await { chromium, firefox, webkit }[engine].launch({
    timeout: 10000,
    ...(engine === "chromium" ? { channel: process.env.BROWSER_CHANNEL, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {})
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Load authored files directly; CDN availability is not part of this contract.
  await page.route("**/*", (route) => route.abort());
  // ===== BROWSER FIXTURE =====
  await page.setContent(
    /* HTML */ `<!doctype html><meta charset="UTF-8" />
      <div id="viewer"></div>`
  );
  await page.addStyleTag({ path: path.join(__dirname, "../md.css") });
  await page.addScriptTag({ path: path.join(__dirname, "../md.js") });
  await page.evaluate(() => {
    window.root = document.getElementById("viewer");
  });

  // ===== RENDERING BEHAVIOR =====
  await t.test("renders headings, lists, emphasis, and fenced source", async () => {
    const source = "# Core\n\n**strong**\n\n- first\n- second\n\n```js\nconst n = 1;\n```";
    await page.evaluate((source) => byMDviewer(root, source, { animations: false }), source);
    assert.equal(await page.locator(".byMDcontent h1").textContent(), "Core");
    assert.equal(await page.locator(".byMDcontent strong").textContent(), "strong");
    assert.equal(await page.locator(".byMDcontent li").count(), 2);
    assert.match(await page.locator(".byMDcontent pre").textContent(), /const n = 1;/);
  });

  await t.test("prefixed documents keep their own heading links and preserve host links", async () => {
    const anchors = await page.evaluate(() => {
      const markdown = "[First](#install) [Again](#install-1) [Host](#contact)\n\n## Install\n\n## Install";
      const other = document.body.appendChild(document.createElement("section"));
      byMDviewer(other, markdown);
      byMDviewer(root, markdown, { headingIdPrefix: "guide-" });
      const ids = [...root.querySelectorAll("h2")].map((heading) => heading.id);
      const links = [...root.querySelectorAll(".byMDlink")].map((link) => link.getAttribute("href"));
      const original = other.querySelector("h2").id;
      other.remove();
      return { ids, links, original };
    });
    assert.deepEqual(anchors, {
      ids: ["guide-install", "guide-install-1"],
      links: ["#guide-install", "#guide-install-1", "#contact"],
      original: "install"
    });
  });

  await t.test("bare links retain balanced delimiters and leave trailing punctuation in the text", async () => {
    const url = "https://example.test/a(b)[c]";
    for (const suffix of ["))", "]]!"]) {
      const tokens = await page.evaluate((source) => byMDviewer.parseInline(source), url + suffix);
      assert.equal(tokens[0].url, url);
      assert.equal(tokens[0].to, url.length);
      assert.equal(tokens[1].text, suffix);
    }
  });

  await t.test("keeps HTML and unsafe links inert", async () => {
    await page.evaluate(() =>
      byMDviewer(
        root,
        `<img src=x onerror="window.injected=1">

[bad](javascript:alert(1))`
      )
    );
    assert.equal(await page.locator("#viewer img, #viewer script, #viewer a[href^='javascript:']").count(), 0);
    assert.equal(await page.evaluate(() => window.injected), undefined);
  });

  await t.test("the header previews and copies rendered text or the current Markdown", async (t) => {
    t.after(() => page.evaluate(() => root.style.removeProperty("width")));
    await page.evaluate(() => {
      root.style.width = "18rem";
      byMDviewer(root, "# stale");
      byMDviewer(root, "# current\r\n");
      window.copied = null;
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.copied = text;
          }
        }
      });
    });
    assert.equal(await page.locator(".byMDcontent h1").textContent(), "current");
    const copy = page.locator(".byVIEWcopy");
    // Layout offsets exclude the button's press animation.
    const layout = () => copy.evaluate((button) => ({
      top: button.offsetTop,
      height: button.offsetHeight,
      width: button.offsetWidth
    }));
    const idle = await layout();
    await copy.hover();
    assert.equal(await copy.innerText(), "Copy");
    await copy.click();
    assert.equal(await page.evaluate(() => window.copied), "current");
    assert.equal(await copy.innerText(), "Copied!");
    const feedback = await layout();
    assert.equal(feedback.top, idle.top);
    assert.equal(feedback.height, idle.height);
    assert.ok(feedback.width > idle.width);
    await page.keyboard.down("Shift");
    assert.equal(await copy.innerText(), "Copy MD");
    assert.equal(await copy.getAttribute("title"), "Copy text (Shift+click for Markdown)");
    await copy.click();
    assert.equal(await page.evaluate(() => window.copied), "# current\r\n");
    await page.keyboard.up("Shift");
    assert.equal(await copy.innerText(), "Copy");
  });

  await t.test("loads a source URL through the public API", async () => {
    const url = "https://files.test/sample";
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/plain",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: "# Rendered file"
      })
    );
    const displayed = await page.evaluate(async (url) => {
      const viewer = byMDviewer(root, url);
      return (await viewer.ready) && root.textContent;
    }, url);
    assert.match(displayed, /Rendered file/);
  });

  await t.test("synchronous Markdown can replace a pending URL", async () => {
    const rendered = await page.evaluate(async () => {
      const old = byMDviewer(root, "./pending.md");
      byMDviewer(root, "# Current");
      return old.ready;
    });
    assert.equal(rendered, false);
    assert.equal(await page.getByRole("heading", { name: "Current" }).count(), 1);
  });

  assert.deepEqual(errors, [], "No uncaught browser errors");
});
