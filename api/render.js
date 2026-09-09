import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  let browser = null;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1440, height: 900 },
      executablePath: await chromium.executablePath(
        "https://github.com/Sparticuz/chromium/releases/download/v123.0.0/chromium-v123.0.0-pack.tar"
      ),
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // 1. Block heavy video media to save server execution time
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.resourceType() === "media") {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });

    // 2. Trigger Scroll Hydration (GSAP / Framer Motion / Lazy Loading)
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 400;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;

          if (totalHeight >= scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 60);
      });
    });

    await new Promise((r) => setTimeout(r, 1000));

    // 3. Freeze WebGL / Canvas / Map Components into Static Images
    await page.evaluate(() => {
      // Find canvas/map elements that fail on cross-domain
      const canvases = document.querySelectorAll("canvas");
      canvases.forEach((canvas) => {
        try {
          const dataUrl = canvas.toDataURL("image/png");
          const img = document.createElement("img");
          img.src = dataUrl;
          img.style.cssText = canvas.style.cssText;
          img.className = canvas.className;
          canvas.parentNode.replaceChild(img, canvas);
        } catch (e) {
          console.warn("Canvas export failed due to CORS pollution", e);
        }
      });

      // Strip blocking third-party iframes to prevent "refused to connect" errors
      const iframes = document.querySelectorAll("iframe");
      iframes.forEach((iframe) => {
        const placeholder = document.createElement("div");
        placeholder.style.cssText =
          "padding: 24px; background: #f8f9fa; border: 1px dashed #ced4da; text-align: center; color: #6c757d; font-family: sans-serif; font-size: 13px; border-radius: 6px;";
        placeholder.innerHTML = `<strong>Embedded Frame Removed</strong><br><span style="font-size:11px;">(${iframe.src || 'External Content'})</span>`;
        if (iframe.parentNode) {
          iframe.parentNode.replaceChild(placeholder, iframe);
        }
      });
    });

    // 4. Inlining CSS stylesheets directly into <style> blocks
    await page.evaluate(async () => {
      const cssLinks = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
      for (const link of cssLinks) {
        try {
          const response = await fetch(link.href);
          if (response.ok) {
            const cssText = await response.text();
            const styleEl = document.createElement("style");
            styleEl.textContent = cssText;
            if (link.parentNode) {
              link.parentNode.replaceChild(styleEl, link);
            }
          }
        } catch (e) {
          // Fallback to absolute remote link if CORS blocks direct CSS text fetch
          link.href = new URL(link.getAttribute("href"), document.baseURI).href;
        }
      }
    });

    let html = await page.content();

    // Ensure image paths & relative URLs point directly to full HTTPS targets
    if (!html.includes("<base")) {
      html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${url}">`);
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).json({ html });
  } catch (err) {
    console.error("Render error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (browser) await browser.close();
  }
}
