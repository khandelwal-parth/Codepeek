export default async function handler(req, res) {
  const { url } = req.query;

  if (!url) return res.status(400).json({ error: "Missing url parameter" });

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return res.status(400).json({ error: "Invalid URL" });
  }

  // block non-http(s)
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(403).json({ error: "Protocol not allowed" });
  }

  // block private/internal IPs
  const host = parsed.hostname;
  const blocked = [
    "localhost", "127.", "0.0.0.0",
    "10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
    "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
    "169.254.",  // AWS metadata endpoint
    "::1", "fc00:", "fd",
  ];
  if (blocked.some(b => host.startsWith(b) || host === b.replace(".", ""))) {
    return res.status(403).json({ error: "Blocked host" });
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
    });
    const contentType = response.headers.get("content-type") || "text/css";
    const body = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", contentType);
    res.status(200).send(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
