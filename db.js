import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "jobs.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    job_id          TEXT PRIMARY KEY,
    title           TEXT,
    company         TEXT,
    location        TEXT,
    posted_date     TEXT,
    url             TEXT,
    tag             TEXT,          -- which course/search this matched
    fetched_at      TEXT,
    description     TEXT,
    seniority       TEXT,
    employment_type TEXT,
    job_function    TEXT,
    industries      TEXT,
    applicants      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_tag ON jobs(tag);
`);

// Auto-migrate: add any columns missing from an older DB created before
// the detail fields existed (so an existing jobs.db upgrades in place).
const existingCols = new Set(
  db.prepare("PRAGMA table_info(jobs)").all().map((c) => c.name)
);
for (const col of [
  "description",
  "seniority",
  "employment_type",
  "job_function",
  "industries",
  "applicants",
]) {
  if (!existingCols.has(col)) db.exec(`ALTER TABLE jobs ADD COLUMN ${col} TEXT`);
}

const upsert = db.prepare(`
  INSERT INTO jobs (
    job_id, title, company, location, posted_date, url, tag, fetched_at,
    description, seniority, employment_type, job_function, industries, applicants
  ) VALUES (
    @jobId, @title, @company, @location, @postedDate, @url, @tag, @fetchedAt,
    @description, @seniority, @employmentType, @jobFunction, @industries, @applicants
  )
  ON CONFLICT(job_id) DO UPDATE SET
    title=excluded.title, company=excluded.company, location=excluded.location,
    posted_date=excluded.posted_date, url=excluded.url,
    tag=excluded.tag, fetched_at=excluded.fetched_at,
    description=excluded.description, seniority=excluded.seniority,
    employment_type=excluded.employment_type, job_function=excluded.job_function,
    industries=excluded.industries, applicants=excluded.applicants
`);

/** Save a batch of jobs for a given tag. Missing detail fields default to "". */
export function saveJobs(jobs, tag, fetchedAt) {
  const tx = db.transaction((rows) => {
    for (const j of rows) {
      upsert.run({
        description: "",
        seniority: "",
        employmentType: "",
        jobFunction: "",
        industries: "",
        applicants: "",
        ...j,
        tag,
        fetchedAt,
      });
    }
  });
  tx(jobs);
}

/**
 * Read jobs for a tag (or all), newest first.
 * Only returns jobs posted within the last `maxAgeDays` days (default 7).
 */
export function getJobs({ tag, limit = 50, maxAgeDays = 7 } = {}) {
  const cutoff = `-${maxAgeDays} days`;
  if (tag) {
    return db
      .prepare(
        `SELECT * FROM jobs
         WHERE tag = ? AND posted_date >= date('now', ?)
         ORDER BY posted_date DESC LIMIT ?`
      )
      .all(tag, cutoff, limit);
  }
  return db
    .prepare(
      `SELECT * FROM jobs
       WHERE posted_date >= date('now', ?)
       ORDER BY posted_date DESC LIMIT ?`
    )
    .all(cutoff, limit);
}

/** Read a single job by id (used for on-demand detail loading). */
export function getJobById(jobId) {
  return db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).get(jobId);
}

/** Save the detail fields for one job (fetched lazily when a user opens it). */
const saveDetailStmt = db.prepare(`
  UPDATE jobs SET
    description=@description, seniority=@seniority, employment_type=@employmentType,
    job_function=@jobFunction, industries=@industries, applicants=@applicants
  WHERE job_id=@jobId
`);
export function saveDetails(jobId, detail) {
  return saveDetailStmt.run({
    description: "",
    seniority: "",
    employmentType: "",
    jobFunction: "",
    industries: "",
    applicants: "",
    ...detail,
    jobId,
  }).changes;
}

/** Delete jobs older than `maxAgeDays` so the DB doesn't grow forever. */
export function deleteOld(maxAgeDays = 7) {
  return db
    .prepare(`DELETE FROM jobs WHERE posted_date < date('now', ?)`)
    .run(`-${maxAgeDays} days`).changes;
}

export default db;
