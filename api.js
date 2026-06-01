import express from "express";
import { getJobs, getJobById, saveDetails } from "./db.js";
import { fetchJobDetail } from "./scraper.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your course platform's frontend to call this.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

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
