import fetch from "node-fetch";

// Helpers
function resolveUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function shouldSkipScript(src) {
  const skipList = [
    "google-analytics", "googletagmanager", "googlesyndication",
    "facebook.net", "connect.facebook", "twitter.com/widgets",
    "platform.twitter", "linkedin.com", "disqus.com",
    "addthis.com", "sharethis.com", "hotjar.com",
    "clarity.ms", "doubleclick.net", "adsbygoogle"
  ];
  return skipList.some(s => src.includes(s));
}

async function fetchText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; CodePeek/1.0)" },
      timeout: 5000,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function inlineResources(html, baseUrl) {
  // Inline external CSS <link> tags
  const linkRegex = /<link[^>]+rel=["']stylesheet["'][^>]*href=["']([^"']+)["'][^>]*\/?>/gi;
  const cssPromises = [];
  const cssMatches = [];
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = resolveUrl(baseUrl, match[1]);
    cssMatches.push({ full: match[0], url: href });
    cssPromises.push(fetchText(href));
  }

  const cssResults = await Promise.all(cssPromises);
  for (let i = cssMatches.length - 1; i >= 0; i--) {
    const css = cssResults[i];
    if (css) {
      html = html.replace(cssMatches[i].full, `<style>/* inlined: ${cssMatches[i].url} */\n${css}</style>`);
    }
  }

  // Inline external JS <script src> tags (skip analytics/ads)
  const scriptRegex = /<script[^>]+src=["']([^"']+)["'][^>]*><\/script>/gi;
  const jsPromises = [];
  const jsMatches = [];

  while ((match = scriptRegex.exec(html)) !== null) {
    const src = resolveUrl(baseUrl, match[1]);
    if (!shouldSkipScript(src)) {
      jsMatches.push({ full: match[0], url: src });
      jsPromises.push(fetchText(src));
    }
  }

  const jsResults = await Promise.all(jsPromises);
  for (let i = jsMatches.length - 1; i >= 0; i--) {
    const js = jsResults[i];
    if (js) {
      html = html.replace(jsMatches[i].full, `<script>/* inlined: ${jsMatches[i].url} */\n${js}<\/script>`);
    }
  }

  // Convert relative image/asset src to absolute URLs
  html = html.replace(/(src=["'])(?!https?:\/\/|data:|\/\/)(.*?)(["'])/gi, (_, q1, path, q2) => {
    return `${q1}${resolveUrl(baseUrl, path)}${q2}`;
  });

  // Convert relative href (for <a>, <link> non-CSS) to absolute
  html = html.replace(/(href=["'])(?!https?:\/\/|data:|\/\/|#|mailto:|tel:)(.*?)(["'])/gi, (_, q1, path, q2) => {
    return `${q1}${resolveUrl(baseUrl, path)}${q2}`;
  });

  return html;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { type, url, code, imageData, prompt, currentCode } = req.body;

  // ─── CASE 1: Raw code paste ──────────────────────────────────────────────
  // No API call needed, just return the code as-is
  if (type === "code") {
    return res.status(200).json({ html: code });
  }

  // ─── CASE 2: URL fetch ───────────────────────────────────────────────────
  // Fetch HTML, inline resources, return directly — NO Gemini needed
  if (type === "url") {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        },
        timeout: 10000,
      });

      if (!response.ok) {
        return res.status(400).json({ error: `Failed to fetch URL: ${response.status} ${response.statusText}` });
      }

      const rawHtml = await response.text();
      const baseUrl = new URL(url).origin;

      // Inline CSS, JS, fix relative paths
      const inlinedHtml = await inlineResources(rawHtml, url);

      return res.status(200).json({ html: inlinedHtml });

    } catch (err) {
      return res.status(500).json({ error: `URL fetch failed: ${err.message}` });
    }
  }

  // ─── CASE 3 & 4: Gemini Vision (screenshot) or AI Editor ────────────────
  // These require the Gemini API key
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: "Gemini API key not configured" });
  }

  const GEMINI_MODEL = "gemini-3-flash-preview";
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  // ─── CASE 3: Screenshot → HTML (Gemini Vision) ──────────────────────────
  if (type === "image") {
    try {
      const base64 = imageData.replace(/^data:image\/\w+;base64,/, "");
      const mimeType = imageData.match(/^data:(image\/\w+);base64,/)?.[1] || "image/png";

      const geminiPayload = {
        contents: [
          {
            parts: [
              {
                inline_data: { mime_type: mimeType, data: base64 },
              },
              {
                text: `You are an expert web developer. Analyze this website screenshot and generate complete, production-ready HTML/CSS/JS code that replicates this design as closely as possible.

Requirements:
- Output ONLY the complete HTML document, starting with <!DOCTYPE html>
- Include all CSS inline in a <style> tag in the <head>
- Include all JavaScript inline in a <script> tag before </body>
- Make it fully self-contained (no external dependencies)
- Match the layout, colors, typography, and spacing as accurately as possible
- Use semantic HTML5 elements
- Make it responsive

Output ONLY the HTML code. No explanations, no markdown, no code fences.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      };

      const geminiRes = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      });

      const geminiData = await geminiRes.json();

      if (!geminiRes.ok) {
        return res.status(500).json({ error: geminiData.error?.message || "Gemini API error" });
      }

      let generatedCode = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      // Strip any markdown code fences if present
      generatedCode = generatedCode.replace(/^```html?\n?/i, "").replace(/```\s*$/i, "").trim();

      return res.status(200).json({ html: generatedCode });

    } catch (err) {
      return res.status(500).json({ error: `Image analysis failed: ${err.message}` });
    }
  }

  // ─── CASE 4: AI Editor ───────────────────────────────────────────────────
  if (type === "edit") {
    try {
      const geminiPayload = {
        contents: [
          {
            parts: [
              {
                text: `You are an expert web developer. You will be given existing HTML code and an edit instruction. Apply the requested changes and return the complete updated HTML.

Current HTML code:
\`\`\`html
${currentCode}
\`\`\`

Edit instruction: ${prompt}

Requirements:
- Return ONLY the complete updated HTML document
- Preserve all existing functionality unless explicitly asked to change it
- Apply the requested changes accurately
- Output ONLY the HTML code. No explanations, no markdown, no code fences.`,
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
        },
      };

      const geminiRes = await fetch(GEMINI_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(geminiPayload),
      });

      const geminiData = await geminiRes.json();

      if (!geminiRes.ok) {
        return res.status(500).json({ error: geminiData.error?.message || "Gemini API error" });
      }

      let editedCode = geminiData.candidates?.[0]?.content?.parts?.[0]?.text || "";
      editedCode = editedCode.replace(/^```html?\n?/i, "").replace(/```\s*$/i, "").trim();

      return res.status(200).json({ html: editedCode });

    } catch (err) {
      return res.status(500).json({ error: `AI edit failed: ${err.message}` });
    }
  }

  return res.status(400).json({ error: "Invalid request type" });
}
