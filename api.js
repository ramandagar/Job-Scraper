import "dotenv/config"; // load .env before anything reads process.env
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import {
  getJobs, getJobById, saveDetails, getTags,
  getSearches, addSearch, deleteSearch, saveJobs,
} from "./db.js";
import { fetchJobDetail, scrapeJobs } from "./scraper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Allow your course platform's frontend to call this.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const slugify = (s) =>
  s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// Serve the GUI (public/index.html) at the root URL.
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({ ok: true }));

// List of available course tags (for the GUI dropdown).
app.get("/api/courses", (_req, res) => {
  try {
    res.json({ courses: getTags() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Search management (used by the GUI "Manage" panel) ---

// List configured searches.
app.get("/api/searches", (_req, res) => {
  try {
    res.json({ searches: getSearches() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a search, then scrape it immediately so jobs appear right away.
app.post("/api/searches", async (req, res) => {
  try {
    const keywords = (req.body.keywords || "").trim();
    const location = (req.body.location || "India").trim();
    if (!keywords) return res.status(400).json({ error: "keywords required" });

    const tag = (req.body.tag && slugify(req.body.tag)) || slugify(keywords);
    const search = addSearch({ tag, keywords, location });

    // Immediate first scrape (the worker handles periodic refreshes after).
    const jobs = await scrapeJobs({
      keywords, location, maxResults: 40,
      datePosted: "week", maxAgeDays: 7, collapseSimilar: true,
    });
    saveJobs(jobs, tag, new Date().toISOString());

    res.json({ search, scraped: jobs.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a search (and its jobs).
app.delete("/api/searches/:tag", (req, res) => {
  try {
    deleteSearch(req.params.tag, true);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs?course=react&limit=20  -> list (no descriptions, cheap)
app.get("/api/jobs", (req, res) => {
  const tag = req.query.course;
  const limit = Math.min(Number(req.query.limit) || 50, 100);
  try {
    const jobs = getJobs({ tag, limit });
    res.json({ count: jobs.length, jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id  -> full detail. Fetched from LinkedIn on first open,
// then cached in the DB so repeat opens are instant and cost no requests.
app.get("/api/jobs/:id", async (req, res) => {
  try {
    const job = getJobById(req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Lazily fetch + cache the description the first time it's opened.
    if (!job.description) {
      try {
        const detail = await fetchJobDetail(job.job_id);
        saveDetails(job.job_id, detail);
        Object.assign(job, {
          description: detail.description,
          seniority: detail.seniority,
          employment_type: detail.employmentType,
          job_function: detail.jobFunction,
          industries: detail.industries,
          applicants: detail.applicants,
        });
      } catch (err) {
        // Return the job without details rather than failing the request.
        console.error(`Detail fetch failed for ${job.job_id}:`, err.message);
      }
    }
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Jobs API listening on :${PORT}`));
