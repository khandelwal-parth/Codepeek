import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

export const config = {
  maxDuration: 60,
};

const REV_SLIDER_EXTENSIONS = [
  "revolution.extension.slideanims.min.js",
  "revolution.extension.actions.min.js",
  "revolution.extension.layeranimation.min.js",
  "revolution.extension.kenburn.min.js",
  "revolution.extension.navigation.min.js",
];

function injectRevSliderFix(html, siteUrl) {
  try {
    const origin = new URL(siteUrl).origin;

    // Check if this page uses RevSlider
    if (!html.includes("revslider") && !html.includes("revolution")) return html;

    // Find the RevSlider plugin base path from the existing HTML
    const pluginPathMatch = html.match(/["'](https?:\/\/[^"']+\/revslider\/public\/assets\/js\/)/);
    const pluginBase = pluginPathMatch
      ? pluginPathMatch[1]
      : `${origin}/wp-content/plugins/revslider/public/assets/js/`;

    const extensionScripts = REV_SLIDER_EXTENSIONS.map(
      (ext) => `<script type="text/javascript" src="${pluginBase}extensions/${ext}"></script>`
    ).join("\n");

    // Inject before </head>
    if (html.includes("</head>")) {
      return html.replace("</head>", `${extensionScripts}\n</head>`);
    }

    // Fallback: inject after <head>
    return html.replace(/<head([^>]*)>/i, `<head$1>\n${extensionScripts}`);
  } catch {
    return html;
  }
}

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(
        "https://github.com/Sparticuz/chromium/releases/download/v123.0.0/chromium-v123.0.0-pack.tar"
      ),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Block heavy assets to stay within timeout budget
    await page.setRequestInterception(true);
    page.on("request", (interceptedReq) => {
      const type = interceptedReq.resourceType();
      if (["image", "media", "font"].includes(type)) {
        interceptedReq.abort();
      } else {
        interceptedReq.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });

    // Extra wait for JS-heavy sites
    await new Promise((r) => setTimeout(r, 2000));

    let html = await page.content();

    // Inject base href so srcdoc resolves relative URLs correctly
    if (!html.includes("<base")) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${url}">`);
    }

    // Inject RevSlider extensions if needed
    html = injectRevSliderFix(html, url);

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ html });
  } catch (err) {
    console.error("Render error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
}
