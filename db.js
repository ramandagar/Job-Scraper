import Database from "better-sqlite3";

const db = new Database(process.env.DB_FILE || "jobs.db");
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    job_id       TEXT PRIMARY KEY,
    title        TEXT,
    company      TEXT,
    location     TEXT,
    posted_date  TEXT,
    url          TEXT,
    tag          TEXT,          -- which course/search this matched
    fetched_at   TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_tag ON jobs(tag);
`);

const upsert = db.prepare(`
  INSERT INTO jobs (job_id, title, company, location, posted_date, url, tag, fetched_at)
  VALUES (@jobId, @title, @company, @location, @postedDate, @url, @tag, @fetchedAt)
  ON CONFLICT(job_id) DO UPDATE SET
    title=excluded.title, company=excluded.company, location=excluded.location,
    posted_date=excluded.posted_date, url=excluded.url,
    tag=excluded.tag, fetched_at=excluded.fetched_at
`);

/** Save a batch of jobs for a given tag. */
export function saveJobs(jobs, tag, fetchedAt) {
  const tx = db.transaction((rows) => {
    for (const j of rows) upsert.run({ ...j, tag, fetchedAt });
  });
  tx(jobs);
}

/** Read jobs for a tag (or all), newest first. */
export function getJobs({ tag, limit = 50 } = {}) {
  if (tag) {
    return db
      .prepare(`SELECT * FROM jobs WHERE tag = ? ORDER BY fetched_at DESC LIMIT ?`)
      .all(tag, limit);
  }
  return db
    .prepare(`SELECT * FROM jobs ORDER BY fetched_at DESC LIMIT ?`)
    .all(limit);
}

export default db;
