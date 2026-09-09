import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = (process.env.SURPLUS_API_URL || "https://api.surplusintelligence.ai").replace(/\/$/, "");
const DEFAULT_MODEL = process.env.SURPLUS_VIDEO_MODEL || "veo3-fast-image-to-video";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 6 * 1024 * 1024 }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function requireKey(res) {
  if (!process.env.SURPLUS_API_KEY) {
    res.status(500).json({ error: "SURPLUS_API_KEY is not configured on the server." });
    return false;
  }
  return true;
}

async function surplus(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.SURPLUS_API_KEY}`,
    ...(options.headers || {})
  };

  const response = await fetch(`${API_URL}${path}`, { ...options, headers });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.message || `Surplus API returned ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

app.get("/api/config", (_req, res) => {
  res.json({ defaultModel: DEFAULT_MODEL });
});

app.post("/api/generate", upload.single("image"), async (req, res) => {
  try {
    if (!requireKey(res)) return;

    const prompt = String(req.body.prompt || "").trim();
    const model = String(req.body.model || DEFAULT_MODEL).trim();
    const aspectRatio = String(req.body.aspect_ratio || "16:9").trim();

    if (!prompt) return res.status(400).json({ error: "Prompt is required." });
    if (!req.file) return res.status(400).json({ error: "Reference image is required." });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image." });
    }

    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

    const body = {
      model,
      prompt,
      image_url: dataUrl,
      aspect_ratio: aspectRatio,
    };

    const result = await surplus("/v1/video/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify(body)
    });

    res.status(202).json(result);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: err.message || "Generation request failed.",
      details: err.data || undefined
    });
  }
});

app.get("/api/status/:id", async (req, res) => {
  try {
    if (!requireKey(res)) return;
    const id = encodeURIComponent(req.params.id);
    const result = await surplus(`/v1/video/generations/${id}`, { method: "GET" });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(err.status || 500).json({
      error: err.message || "Status check failed.",
      details: err.data || undefined
    });
  }
});

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "Image is too large. Maximum upload size is 6 MB." });
  }
  console.error(err);
  res.status(500).json({ error: err?.message || "Unexpected server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Surplus Veo UI running on port ${PORT}`);
});
