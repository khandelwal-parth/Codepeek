const PROXY = 'https://codepeek-renderer.onrender.com/proxy?url=';

// ── Clean fetched HTML ──
function cleanHTML(html, baseUrl) {
  try {
    const base = baseUrl.endsWith('/') ? baseUrl : baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);
    html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}">`);
  } catch {}

  // Proxy external stylesheets through renderer so CORS is bypassed
  // handles: <link rel="stylesheet" href="..."> in both attribute orders
  html = html.replace(/<link([^>]*?)>/gi, (match, attrs) => {
    if (!/rel=["']stylesheet["']/i.test(attrs)) return match;
    return match.replace(/(href=["'])([^"']+)(["'])/i, (m, pre, href, post) => {
      if (!href.startsWith('http')) return m;
      return `${pre}${PROXY}${encodeURIComponent(href)}${post}`;
    });
  });

  return html;
}

// ── In-memory rate limiter (10 requests per minute per IP) ──
const rateLimitMap = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 1000;

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > RATE_WINDOW) {
    entry.count = 1;
    entry.start = now;
  } else {
    entry.count++;
  }
  rateLimitMap.set(ip, entry);
  return entry.count <= RATE_LIMIT;
}

const RENDERER_URL = 'https://codepeek-renderer.onrender.com';
const MODEL = 'gemini-3-flash-preview';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured on server' });

  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;

  try {
    const { type, imageBase64, url, code } = req.body;

    // ── CASE 1: Code paste ──
    if (type === 'code') {
      return res.status(200).json({ code });
    }

    // ── CASE 2: URL → Puppeteer renderer ──
    if (type === 'url') {
      let sourceCode = null;

      try {
        const r = await fetch(`${RENDERER_URL}/render`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url }),
          signal: AbortSignal.timeout(35000)
        });
        if (r.ok) {
          const data = await r.json();
          sourceCode = data.code || null;
        }
      } catch {}

      if (!sourceCode) {
        try {
          const r = await fetch(url, {
            signal: AbortSignal.timeout(10000),
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
          });
          if (r.ok) sourceCode = await r.text();
        } catch {}
      }

      if (!sourceCode) {
        try {
          const r = await fetch(`https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            const data = await r.json().catch(() => null);
            sourceCode = data?.contents || null;
          }
        } catch {}
      }

      if (!sourceCode) return res.status(502).json({ error: 'Could not fetch URL. Try pasting the source code directly.' });

      sourceCode = cleanHTML(sourceCode, url);
      return res.status(200).json({ code: sourceCode });
    }

    // ── CASE 3: Image (+ optional URL) → Gemini ──
    if (type === 'image') {
      let urlSourceCode = null;
      let resolvedUrl = url || null;

      if (!resolvedUrl) {
        const extractRes = await fetch(GEMINI_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } },
                { text: 'Look at this screenshot. If you can see a URL, domain name, or website address anywhere in the image (in the browser address bar, in text, in a logo, anywhere), extract and return ONLY the full URL starting with https://. If you cannot find any URL, return exactly the word: NONE' }
              ]
            }]
          })
        });
        const extractData = await extractRes.json();
        const extracted = extractData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (extracted && extracted !== 'NONE' && extracted.startsWith('http')) {
          resolvedUrl = extracted;
        }
      }

      if (resolvedUrl) {
        try {
          const r = await fetch(`${RENDERER_URL}/render`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: resolvedUrl }),
            signal: AbortSignal.timeout(35000)
          });
          if (r.ok) {
            const data = await r.json();
            urlSourceCode = data.code || null;
          }
        } catch {}

        if (!urlSourceCode) {
          try {
            const r = await fetch(resolvedUrl, {
              signal: AbortSignal.timeout(10000),
              headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
            });
            if (r.ok) urlSourceCode = await r.text();
          } catch {}
        }
      }

      const promptParts = [{ inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }];
      let textPrompt = `You are an expert UI-to-code engineer. Analyze this screenshot carefully.`;
      if (urlSourceCode) {
        textPrompt += `\n\nI also have the actual source code of this page:\n\`\`\`html\n${urlSourceCode.substring(0, 15000)}\n\`\`\`\n\nUse BOTH the screenshot AND the source code to recreate this UI as accurately as possible.`;
      } else if (resolvedUrl) {
        textPrompt += `\n\nThis screenshot is from: ${resolvedUrl}. Use the visual information to reconstruct the UI.`;
      }
      textPrompt += `\n\nGenerate clean, complete, production-ready HTML + CSS + JavaScript that recreates this UI as accurately as possible. Include all visible text, colors, fonts, layout, spacing, and interactive elements. Return ONLY the complete HTML code, nothing else, no explanation, no markdown code blocks.`;
      promptParts.push({ text: textPrompt });

      const geminiRes = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: promptParts }] })
      });

      const geminiData = await geminiRes.json();
      if (geminiData.error) return res.status(500).json({ error: geminiData.error.message });

      let generatedCode = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      generatedCode = generatedCode.replace(/^```html\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();

      return res.status(200).json({ code: generatedCode, detectedUrl: resolvedUrl });
    }

    // ── CASE 4: AI Edit ──
    if (type === 'edit') {
      const { currentCode, instruction } = req.body;
      const editRes = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `You are an expert frontend developer. Here is the current HTML/CSS/JS code:\n\`\`\`html\n${currentCode}\n\`\`\`\n\nThe user wants to make this change: "${instruction}"\n\nReturn the complete updated HTML code with the changes applied. Return ONLY the complete HTML, no explanation, no markdown code blocks.`
            }]
          }]
        })
      });
      const editData = await editRes.json();
      if (editData.error) return res.status(500).json({ error: editData.error.message });
      let editedCode = editData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      editedCode = editedCode.replace(/^```html\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
      return res.status(200).json({ code: editedCode });
    }

    return res.status(400).json({ error: 'Invalid request type' });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
