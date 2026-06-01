import "dotenv/config"; // load .env before anything reads process.env
import cron from "node-cron";
import { scrapeJobs } from "./scraper.js";
import { saveJobs, deleteOld, getSearches } from "./db.js";

async function runOnce() {
  const stamp = new Date().toISOString();
  // Searches are managed dynamically from the GUI and stored in the DB.
  const searches = getSearches();
  console.log(`[${stamp}] Starting scrape run (${searches.length} searches)...`);

  for (const { tag, keywords, location } of searches) {
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
