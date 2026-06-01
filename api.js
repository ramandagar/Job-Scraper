import express from "express";
import { getJobs } from "./db.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Allow your course platform's frontend to call this.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", process.env.CORS_ORIGIN || "*");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

// GET /api/jobs?course=react&limit=20
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

app.listen(PORT, () => console.log(`Jobs API listening on :${PORT}`));
