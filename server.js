import express from "express";
import multer from "multer";
import crypto from "crypto";

const app = express();
const PORT = process.env.PORT || 3000;
const API_URL = (process.env.SURPLUS_API_URL || "https://api.surplusintelligence.ai").replace(/\/$/, "");
const DEFAULT_VIDEO_MODEL = process.env.SURPLUS_VIDEO_MODEL || "veo3-fast-image-to-video";
const modelS = {
  "nano-banana-pro-edit": "nano-banana-pro-edit",
  "nano-banana-2-edit": "nano-banana-2-edit"
};

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }
});

const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 8, fileSize: 8 * 1024 * 1024 }
});

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

function requireKey(res) {
  if (!process.env.SURPLUS_API_KEY) {
    res.status(500).json({ error: "SURPLUS_API_KEY is not configured in Coolify." });
    return false;
  }
  return true;
}

async function surplus(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.SURPLUS_API_KEY}`,
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers,
      signal: AbortSignal.timeout(180000)
    });
  } catch (err) {
    throw new Error(
      `Surplus connection failed: ${
        err?.cause?.message || err?.cause?.code || err?.message || "unknown network error"
      }`
    );
  }

  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || data?.message || `Surplus API returned ${response.status}`
    );
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

function dataUri(file) {
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

function detectMimeFromBase64(b64) {
  try {
    const head = Buffer.from(b64.slice(0, 64), "base64");
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
    if (head.toString("ascii", 0, 4) === "RIFF" && head.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  } catch {}
  return "image/png";
}

app.get("/api/config", (_req, res) => {
  res.json({
    defaultVideoModel: DEFAULT_VIDEO_MODEL,
    imageModels: modelS
  });
});

// ---------------- VIDEO ----------------

app.post("/api/generate", videoUpload.single("image"), async (req, res) => {
  try {
    if (!requireKey(res)) return;

    const prompt = String(req.body.prompt || "").trim();
    const model = String(req.body.model || DEFAULT_VIDEO_MODEL).trim();
    const aspectRatio = String(req.body.aspect_ratio || "16:9").trim();

    if (!prompt) return res.status(400).json({ error: "Prompt is required." });
    if (!req.file) return res.status(400).json({ error: "Reference image is required." });
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "Uploaded file must be an image." });
    }

    const result = await surplus("/v1/video/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify({
        model,
        prompt,
        image_url: dataUri(req.file),
        aspect_ratio: aspectRatio
      })
    });

    res.status(202).json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || "Video generation request failed.",
      details: err.data || undefined
    });
  }
});

app.get("/api/status/:id", async (req, res) => {
  try {
    if (!requireKey(res)) return;
    const result = await surplus(
      `/v1/video/generations/${encodeURIComponent(req.params.id)}`,
      { method: "GET" }
    );
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || "Status check failed.",
      details: err.data || undefined
    });
  }
});

// ---------------- IMAGE ----------------
// IMPORTANT:
// nano-banana-2-edit is sent to the documented EDIT endpoint.
// For multiple references, Surplus expects objects:
// {url:"...", role:"start"} and {url:"...", role:"reference"}.

app.post("/api/generate-image", imageUpload.array("images", 8), async (req, res) => {
  try {
    if (!requireKey(res)) return;

    const prompt = String(req.body.prompt || "").trim();
    const model = String(req.body.model || "nano-banana-2-edit").trim();
    const resolution = String(req.body.resolution || "2K").toUpperCase();
    const files = Array.isArray(req.files) ? req.files : [];

    if (!modelS[model]) {
      return res.status(400).json({ error: "Unsupported image model." });
    }

    if (!prompt) return res.status(400).json({ error: "Prompt is required." });
    if (files.length === 0) {
      return res.status(400).json({
        error: "Nano Banana 2 Edit requires at least one reference image."
      });
    }
    if (!["1K", "2K", "4K"].includes(resolution)) {
      return res.status(400).json({ error: "Resolution must be 1K, 2K or 4K." });
    }
    if (files.some(file => !file.mimetype.startsWith("image/"))) {
      return res.status(400).json({ error: "All reference files must be images." });
    }

    const totalRawBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalRawBytes > 7 * 1024 * 1024) {
      return res.status(413).json({
        error: "Combined reference images are too large. Keep their total under about 7 MB."
      });
    }

    let body;

    if (files.length === 1) {
      // Exact single-image shape shown in Surplus docs.
      body = {
        model,
        prompt,
        image: dataUri(files[0]),
        resolution,
        response_format: "b64_json"
      };
    } else {
      // First uploaded image is used internally as the starting image.
      // Remaining images are sent as references. The UI does not label them.
      body = {
        model,
        prompt,
        input_images: files.map((file, index) => ({
          url: dataUri(file),
          role: index === 0 ? "start" : "reference"
        })),
        resolution,
        response_format: "b64_json"
      };
    }

    const result = await surplus("/v1/images/edits", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID()
      },
      body: JSON.stringify(body)
    });

    const data = (Array.isArray(result?.data) ? result.data : []).map(item => {
      if (item?.b64_json) {
        return {
          b64_json: item.b64_json,
          mime_type: detectMimeFromBase64(item.b64_json)
        };
      }
      if (item?.url) return { url: item.url };
      return item;
    });

    res.json({
      created: result?.created,
      model,
      usedReferences: files.length,
      data
    });

  } catch (err) {
    res.status(err.status || 500).json({
      error: err.message || "Image generation request failed.",
      details: err.data || undefined
    });
  }
});

app.get("/health", (_req, res) => res.status(200).send("ok"));

app.use((err, _req, res, _next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ error: "One uploaded image is too large. Maximum 8 MB per file." });
  }
  if (err?.code === "LIMIT_FILE_COUNT") {
    return res.status(400).json({ error: "Maximum 8 reference images." });
  }
  res.status(500).json({ error: err?.message || "Unexpected server error." });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Surplus AI Studio running on port ${PORT}`);
});
