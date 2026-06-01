import cron from "node-cron";
import { scrapeJobs } from "./scraper.js";
import { saveJobs } from "./db.js";

// Each search maps to a `tag` your course platform queries by (?course=react).
// In production, load these from your courses table.
const SEARCHES = [
  { tag: "react", keywords: "React Developer", location: "India" },
  { tag: "data-analyst", keywords: "Data Analyst", location: "India" },
  { tag: "backend", keywords: "Backend Developer", location: "India" },
];

async function runOnce() {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] Starting scrape run...`);

  for (const { tag, keywords, location } of SEARCHES) {
    try {
      const jobs = await scrapeJobs({ keywords, location, maxResults: 50 });
      saveJobs(jobs, tag, stamp);
      console.log(`  ✓ ${tag} (${keywords}/${location}): ${jobs.length} jobs saved`);
    } catch (err) {
      console.error(`  ✗ ${tag}: ${err.message}`);
    }
    // space out searches so we don't hammer LinkedIn
    await new Promise((r) => setTimeout(r, 5000));
  }

  console.log(`[${new Date().toISOString()}] Done.`);
}

// Run immediately on boot, then on a schedule.
await runOnce();

// Every 6 hours. Adjust the cron expression as needed.
cron.schedule(process.env.CRON_SCHEDULE || "0 */6 * * *", runOnce);
console.log("Worker running. Next scrape per schedule:", process.env.CRON_SCHEDULE || "0 */6 * * *");
