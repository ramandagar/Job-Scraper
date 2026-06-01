import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";

const GUEST_SEARCH =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const GUEST_DETAIL =
  "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

// Rotate a few realistic UAs to look less bot-like.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

const pickUA = (i) => USER_AGENTS[i % USER_AGENTS.length];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// If you scale up, set HTTPS_PROXY to a rotating residential proxy URL.
// e.g. http://user:pass@proxy-host:port
const proxyUrl = process.env.HTTPS_PROXY || null;

function client(i) {
  return axios.create({
    timeout: 15000,
    headers: {
      "User-Agent": pickUA(i),
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
    // axios picks up HTTPS_PROXY automatically, but you can also pass `proxy` here.
  });
}

/**
 * Fetch one page of job cards (10 per page).
 * @param {string} keywords - e.g. "React Developer"
 * @param {string} location - e.g. "India"
 * @param {number} start - 0, 10, 20, ...
 */
async function fetchSearchPage(keywords, location, start, i) {
  const params = new URLSearchParams({ keywords, location, start: String(start) });
  const url = `${GUEST_SEARCH}?${params.toString()}`;
  const { data } = await client(i).get(url);
  const $ = cheerio.load(data);

  const jobs = [];
  $("li").each((_, el) => {
    const card = $(el);
    const title = card.find(".base-search-card__title").text().trim();
    if (!title) return;

    const company = card.find(".base-search-card__subtitle").text().trim();
    const loc = card.find(".job-search-card__location").text().trim();
    const link = card.find("a.base-card__full-link").attr("href") || "";
    const posted = card.find("time").attr("datetime") || "";
    const urn = card.find(".base-card").attr("data-entity-urn") || "";
    const jobId = urn.split(":").pop() || link.match(/-(\d+)\?/)?.[1] || "";

    jobs.push({
      jobId,
      title,
      company,
      location: loc,
      postedDate: posted,
      url: link.split("?")[0],
    });
  });
  return jobs;
}

/** Fetch the full description for one job. */
async function fetchJobDetail(jobId, i) {
  const { data } = await client(i).get(`${GUEST_DETAIL}/${jobId}`);
  const $ = cheerio.load(data);
  return {
    description: $(".show-more-less-html__markup").text().trim(),
    seniority: $(".description__job-criteria-text").eq(0).text().trim(),
    employmentType: $(".description__job-criteria-text").eq(1).text().trim(),
  };
}

/**
 * Main entry: scrape up to `maxResults` jobs for a search.
 * Set withDetails=true to also fetch each job's description (slower).
 */
export async function scrapeJobs({
  keywords,
  location,
  maxResults = 50,
  withDetails = false,
}) {
  const all = [];
  let start = 0;
  let req = 0;

  while (all.length < maxResults) {
    let page;
    try {
      page = await fetchSearchPage(keywords, location, start, req++);
    } catch (err) {
      console.error(`Search page failed at start=${start}:`, err.response?.status || err.message);
      break; // likely rate-limited (429) — stop or back off
    }
    if (page.length === 0) break; // no more results
    all.push(...page);
    start += 10;
    await sleep(1500 + Math.random() * 1500); // be polite: ~1.5–3s between pages
  }

  const jobs = all.slice(0, maxResults);

  if (withDetails) {
    const limit = pLimit(3); // max 3 concurrent detail requests
    await Promise.all(
      jobs.map((job, idx) =>
        limit(async () => {
          try {
            Object.assign(job, await fetchJobDetail(job.jobId, idx));
            await sleep(800 + Math.random() * 800);
          } catch (err) {
            console.error(`Detail failed for ${job.jobId}:`, err.response?.status || err.message);
          }
        })
      )
    );
  }

  return jobs;
}

// --- demo run ---
if (import.meta.url === `file://${process.argv[1]}`) {
  const jobs = await scrapeJobs({
    keywords: process.argv[2] || "React Developer",
    location: process.argv[3] || "India",
    maxResults: 30,
    withDetails: false,
  });
  console.log(`Found ${jobs.length} jobs:\n`);
  console.log(JSON.stringify(jobs, null, 2));
}
