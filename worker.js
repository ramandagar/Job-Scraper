import "dotenv/config"; // load .env before anything reads process.env
import cron from "node-cron";
import { scrapeJobs } from "./scraper.js";
import { saveJobs, deleteOld } from "./db.js";

// Each search maps to a `tag` your course platform queries by (?course=network-engineer).
// In production, load these from your courses table. These are networking-domain roles —
// edit the keywords/tags to match the exact courses you sell.
const SEARCHES = [
  { tag: "network-engineer", keywords: "Network Engineer", location: "India" },
  { tag: "network-admin", keywords: "Network Administrator", location: "India" },
  { tag: "network-security", keywords: "Network Security Engineer", location: "India" },
  { tag: "cloud-network", keywords: "Cloud Network Engineer", location: "India" },
];

async function runOnce() {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] Starting scrape run...`);

  for (const { tag, keywords, location } of SEARCHES) {
    try {
      const jobs = await scrapeJobs({
        keywords,
        location,
        maxResults: 40,
        withDetails: false, // list only — descriptions fetched lazily by the API
        datePosted: "week", // only jobs from the last 7 days
        maxAgeDays: 7,
        collapseSimilar: true, // drop multi-city duplicate postings
      });
      saveJobs(jobs, tag, stamp);
      console.log(`  ✓ ${tag} (${keywords}/${location}): ${jobs.length} jobs saved`);
    } catch (err) {
      console.error(`  ✗ ${tag}: ${err.message}`);
    }
    // space out searches so we don't hammer LinkedIn
    await new Promise((r) => setTimeout(r, 5000));
  }

  const removed = deleteOld(7);
  console.log(`[${new Date().toISOString()}] Done. Cleaned ${removed} stale jobs.`);
}

// Run immediately on boot, then on a schedule.
await runOnce();

// Every 6 hours. Adjust the cron expression as needed.
cron.schedule(process.env.CRON_SCHEDULE || "0 */6 * * *", runOnce);
console.log("Worker running. Next scrape per schedule:", process.env.CRON_SCHEDULE || "0 */6 * * *");
