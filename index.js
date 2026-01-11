const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const { BlobServiceClient } = require("@azure/storage-blob");
const { CosmosClient } = require("@azure/cosmos");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: "10mb" }));

/**
 * ===== REQUIRED ENV VARS in Azure Web App Configuration =====
 * AZURE_STORAGE_CONNECTION_STRING = (from Storage account access keys)
 * BLOB_CONTAINER = photos
 *
 * COSMOS_ENDPOINT = (from Cosmos DB Keys)
 * COSMOS_KEY = (from Cosmos DB Keys)
 * COSMOS_DB = snaphub
 * COSMOS_CONTAINER = photos
 *
 * CORS_ORIGINS = https://photostorages.z36.web.core.windows.net
 */

const PORT = process.env.PORT || 3000;

const CORS_ORIGINS = (process.env.CORS_ORIGINS || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (CORS_ORIGINS.includes("*")) return callback(null, true);
      if (CORS_ORIGINS.includes(origin)) return callback(null, true);
      return callback(new Error("CORS blocked: " + origin));
    }
  })
);

const AZURE_STORAGE_CONNECTION_STRING = process.env.AZURE_STORAGE_CONNECTION_STRING;
const BLOB_CONTAINER = process.env.BLOB_CONTAINER || "photos";

const COSMOS_ENDPOINT = process.env.COSMOS_ENDPOINT;
const COSMOS_KEY = process.env.COSMOS_KEY;
const COSMOS_DB = process.env.COSMOS_DB || "snaphub";
const COSMOS_CONTAINER = process.env.COSMOS_CONTAINER || "photos";

function must(name, value) {
  if (!value) throw new Error(`Missing env var: ${name}`);
}

let blobContainerClient;
let cosmosContainer;

async function init() {
  must("AZURE_STORAGE_CONNECTION_STRING", AZURE_STORAGE_CONNECTION_STRING);
  const blobService = BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING);
  blobContainerClient = blobService.getContainerClient(BLOB_CONTAINER);
  await blobContainerClient.createIfNotExists();

  must("COSMOS_ENDPOINT", COSMOS_ENDPOINT);
  must("COSMOS_KEY", COSMOS_KEY);

  const cosmosClient = new CosmosClient({ endpoint: COSMOS_ENDPOINT, key: COSMOS_KEY });
  const { database } = await cosmosClient.databases.createIfNotExists({ id: COSMOS_DB });

  const { container } = await database.containers.createIfNotExists({
    id: COSMOS_CONTAINER,
    partitionKey: { paths: ["/id"] }
  });

  cosmosContainer = container;
  console.log("✅ Connected: Blob + Cosmos");
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "SnapHub API" });
});

/**
 * POST /api/photos
 * FormData:
 * - file (image)
 * - title
 * - caption
 * - location
 * - people (comma separated)
 */
app.post("/api/photos", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Missing file" });

    const { title, caption, location, people } = req.body;

    const id = uuidv4();
    const ext = (req.file.originalname || "").split(".").pop() || "jpg";
    const blobName = `${id}.${ext}`;

    const blockBlob = blobContainerClient.getBlockBlobClient(blobName);
    await blockBlob.uploadData(req.file.buffer, {
      blobHTTPHeaders: { blobContentType: req.file.mimetype || "image/jpeg" }
    });

    const doc = {
      id,
      blobName,
      imageUrl: blockBlob.url,
      title: title || "",
      caption: caption || "",
      location: location || "",
      people: people ? people.split(",").map(p => p.trim()).filter(Boolean) : [],
      createdAt: new Date().toISOString(),
      comments: [],
      avgRating: 0,
      ratingCount: 0
    };

    await cosmosContainer.items.create(doc);

    res.status(201).json(doc);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Upload failed", details: e.message });
  }
});

/**
 * GET /api/photos?q=search
 */
app.get("/api/photos", async (req, res) => {
  try {
    const q = (req.query.q || "").toLowerCase().trim();

    const { resources } = await cosmosContainer.items
      .query("SELECT * FROM c ORDER BY c.createdAt DESC")
      .fetchAll();

    const filtered = !q
      ? resources
      : resources.filter(p => {
          const hay = [
            p.title,
            p.caption,
            p.location,
            ...(p.people || [])
          ].join(" ").toLowerCase();
          return hay.includes(q);
        });

    res.json(filtered);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fetch failed", details: e.message });
  }
});

/**
 * GET /api/photos/:id
 */
app.get("/api/photos/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { resource } = await cosmosContainer.item(id, id).read();
    if (!resource) return res.status(404).json({ error: "Not found" });
    res.json(resource);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Fetch failed", details: e.message });
  }
});

/**
 * POST /api/photos/:id/comments
 * JSON: { name, comment, rating }
 */
app.post("/api/photos/:id/comments", async (req, res) => {
  try {
    const id = req.params.id;
    const { name, comment, rating } = req.body;

    if (!comment || !String(comment).trim()) {
      return res.status(400).json({ error: "Comment is required" });
    }

    const r = Number(rating || 0);
    const safeRating = Number.isFinite(r) ? Math.max(0, Math.min(5, r)) : 0;

    const { resource } = await cosmosContainer.item(id, id).read();
    if (!resource) return res.status(404).json({ error: "Not found" });

    const newComment = {
      id: uuidv4(),
      name: (name || "Anonymous").trim(),
      comment: String(comment).trim(),
      rating: safeRating,
      createdAt: new Date().toISOString()
    };

    resource.comments = Array.isArray(resource.comments) ? resource.comments : [];
    resource.comments.unshift(newComment);

    if (safeRating > 0) {
      const total = (resource.avgRating || 0) * (resource.ratingCount || 0) + safeRating;
      const count = (resource.ratingCount || 0) + 1;
      resource.ratingCount = count;
      resource.avgRating = Math.round((total / count) * 10) / 10;
    }

    await cosmosContainer.item(id, id).replace(resource);
    res.status(201).json(resource);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Comment failed", details: e.message });
  }
});

init()
  .then(() => {
    app.listen(PORT, () => console.log("✅ API running on port", PORT));
  })
  .catch(err => {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  });