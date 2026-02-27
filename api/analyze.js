export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'API key not configured on server' });

  try {
    const { type, imageBase64, url, code } = req.body;

    // ── CASE 1: Code paste → return as-is ──
    if (type === 'code') {
      return res.status(200).json({ code });
    }

    // ── CASE 2: URL only → fetch source via CORS proxy ──
    if (type === 'url') {
      const proxies = [
        `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
        `https://corsproxy.io/?${encodeURIComponent(url)}`,
      ];
      let sourceCode = null;
      for (const proxy of proxies) {
        try {
          const r = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
          if (r.ok) {
            const data = await r.json().catch(() => null);
            sourceCode = data?.contents || await r.text();
            if (sourceCode) break;
          }
        } catch {}
      }
      if (!sourceCode) return res.status(502).json({ error: 'Could not fetch URL. Try pasting the source code directly.' });H
      return res.status(200).json({ code: sourceCode });
    }

    // ── CASE 3: Image (+ optional URL) → Gemini ──
    if (type === 'image') {
      let urlSourceCode = null;
      let resolvedUrl = url || null;

      // Step 1: If no URL provided, ask Gemini to extract one from the image
      if (!resolvedUrl) {
        const extractRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
          {
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
          }
        );
        const extractData = await extractRes.json();
        const extracted = extractData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (extracted && extracted !== 'NONE' && extracted.startsWith('http')) {
          resolvedUrl = extracted;
        }
      }

      // Step 2: If we have a URL (provided or extracted), fetch the source
      if (resolvedUrl) {
        try {
          const proxies = [
            `https://api.allorigins.win/get?url=${encodeURIComponent(resolvedUrl)}`,
            `https://corsproxy.io/?${encodeURIComponent(resolvedUrl)}`,
          ];
          for (const proxy of proxies) {
            try {
              const r = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
              if (r.ok) {
                const data = await r.json().catch(() => null);
                urlSourceCode = data?.contents || await r.text();
                if (urlSourceCode) break;
              }
            } catch {}
          }
        } catch {}
      }

      // Step 3: Build Gemini prompt with image + optional source code
      const promptParts = [
        { inline_data: { mime_type: 'image/jpeg', data: imageBase64 } }
      ];

      let textPrompt = `You are an expert UI-to-code engineer. Analyze this screenshot carefully.`;
      if (urlSourceCode) {
        textPrompt += `\n\nI also have the actual source code of this page:\n\`\`\`html\n${urlSourceCode.substring(0, 15000)}\n\`\`\`\n\nUse BOTH the screenshot AND the source code to recreate this UI as accurately as possible.`;
      } else if (resolvedUrl) {
        textPrompt += `\n\nThis screenshot is from: ${resolvedUrl}. Use the visual information to reconstruct the UI.`;
      }
      textPrompt += `\n\nGenerate clean, complete, production-ready HTML + CSS + JavaScript that recreates this UI as accurately as possible. Include all visible text, colors, fonts, layout, spacing, and interactive elements. Return ONLY the complete HTML code, nothing else, no explanation, no markdown code blocks.`;

      promptParts.push({ text: textPrompt });

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: promptParts }] })
        }
      );

      const geminiData = await geminiRes.json();
      if (geminiData.error) return res.status(500).json({ error: geminiData.error.message });

      let generatedCode = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      generatedCode = generatedCode.replace(/^```html\n?/i, '').replace(/^```\n?/, '').replace(/\n?```$/, '').trim();

      return res.status(200).json({ code: generatedCode, detectedUrl: resolvedUrl });
    }

    // ── CASE 4: AI Edit ──
    if (type === 'edit') {
      const { currentCode, instruction } = req.body;
      const editRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: `You are an expert frontend developer. Here is the current HTML/CSS/JS code:\n\`\`\`html\n${currentCode}\n\`\`\`\n\nThe user wants to make this change: "${instruction}"\n\nReturn the complete updated HTML code with the changes applied. Return ONLY the complete HTML, no explanation, no markdown code blocks.`
              }]
            }]
          })
        }
      );
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
