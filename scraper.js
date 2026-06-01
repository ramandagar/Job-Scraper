import axios from "axios";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import { HttpsProxyAgent } from "https-proxy-agent";

const GUEST_SEARCH =
  "https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search";
const GUEST_DETAIL =
  "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting";

// LinkedIn "date posted" filter (f_TPR). Value is r<seconds>.
const DATE_FILTERS = {
  day: "r86400",
  week: "r604800",
  month: "r2592000",
};

/** True if dateStr (YYYY-MM-DD) is within the last `days` days. */
function withinDays(dateStr, days) {
  if (!dateStr) return false;
  const posted = new Date(dateStr);
  if (isNaN(posted)) return false;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return posted >= cutoff;
}

// Rotate a few realistic UAs to look less bot-like.
const USER_AGENTS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
];

const pickUA = (i) => USER_AGENTS[i % USER_AGENTS.length];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Proxies. Set EITHER:
//   PROXIES="http://user:pass@host1:port,http://user:pass@host2:port"  (comma-separated, rotated)
//   HTTPS_PROXY="http://user:pass@host:port"                            (single proxy)
// Leave both unset to scrape directly from the server's own IP.
// Residential/rotating proxies (Webshare, IPRoyal, Smartproxy) are what
// keep you from being blocked at scale.
const PROXIES = (process.env.PROXIES || process.env.HTTPS_PROXY || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (PROXIES.length) {
  console.log(`Using ${PROXIES.length} proxy/proxies (rotating).`);
} else {
  console.log("No proxy set — scraping from the server's own IP.");
}

/** Build an axios client; rotates through PROXIES by request index. */
function client(i) {
  const cfg = {
    timeout: 20000,
    headers: {
      "User-Agent": pickUA(i),
      Accept: "text/html,application/xhtml+xml",
      "Accept-Language": "en-US,en;q=0.9",
    },
  };
  if (PROXIES.length) {
    const url = PROXIES[i % PROXIES.length]; // round-robin
    cfg.httpsAgent = new HttpsProxyAgent(url);
    cfg.proxy = false; // let the agent handle it, not axios's own logic
  }
  return axios.create(cfg);
}

/**
 * GET with retry + exponential backoff. On a retryable failure (429/999/5xx/
 * network), it rotates to the next proxy and waits longer each time.
 */
async function httpGet(url, baseIdx) {
  const maxAttempts = PROXIES.length > 1 ? Math.min(PROXIES.length, 4) : 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await client(baseIdx + attempt).get(url); // +attempt => next proxy
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const retryable = !status || status === 429 || status === 999 || status >= 500;
      if (!retryable) throw err; // e.g. 404 — no point retrying
      const wait = 2000 * 2 ** attempt + Math.random() * 1000; // 2s, 4s, 8s...
      console.warn(
        `  ⚠ ${status || err.code} on request — retry ${attempt + 1}/${maxAttempts} in ${Math.round(wait)}ms`
      );
      await sleep(wait);
    }
  }
  throw lastErr;
}

/**
 * Fetch one page of job cards (10 per page).
 * @param {string} keywords - e.g. "React Developer"
 * @param {string} location - e.g. "India"
 * @param {number} start - 0, 10, 20, ...
 */
async function fetchSearchPage(keywords, location, start, i, datePosted) {
  const params = new URLSearchParams({ keywords, location, start: String(start) });
  if (DATE_FILTERS[datePosted]) params.set("f_TPR", DATE_FILTERS[datePosted]);
  const url = `${GUEST_SEARCH}?${params.toString()}`;
  const { data } = await httpGet(url, i);
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

/** Fetch the full description + metadata for one job. */
export async function fetchJobDetail(jobId, i = 0) {
  const { data } = await httpGet(`${GUEST_DETAIL}/${jobId}`, i);
  const $ = cheerio.load(data);

  // The "job criteria" block is a list of labeled items; read it by label
  // so we're not relying on a fixed order.
  const criteria = {};
  $(".description__job-criteria-item").each((_, el) => {
    const label = $(el).find(".description__job-criteria-subheader").text().trim();
    const value = $(el).find(".description__job-criteria-text").text().trim();
    if (label) criteria[label] = value;
  });

  return {
    description: $(".show-more-less-html__markup").text().trim(),
    seniority: criteria["Seniority level"] || "",
    employmentType: criteria["Employment type"] || "",
    jobFunction: criteria["Job function"] || "",
    industries: criteria["Industries"] || "",
    applicants: $(".num-applicants__caption").text().trim(),
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
  datePosted = "week", // 'day' | 'week' | 'month' — filters at the LinkedIn query
  maxAgeDays = 7, // safety net: drop anything older than this
  collapseSimilar = true, // collapse same title+company postings (multi-city noise)
}) {
  const seenIds = new Set(); // job_ids we've already processed this run
  const seenSimilar = new Set(); // title|company keys, for collapsing duplicates
  const jobs = [];

  let start = 0;
  let emptyStreak = 0; // consecutive pages that added nothing new
  const MAX_PAGES = 40; // hard cap so we never loop forever

  for (let page = 0; page < MAX_PAGES && jobs.length < maxResults; page++) {
    let cards;
    try {
      cards = await fetchSearchPage(keywords, location, start, page, datePosted);
    } catch (err) {
      console.error(`Search page failed at start=${start}:`, err.response?.status || err.message);
      break; // likely rate-limited (429) — stop, don't hammer
    }
    if (cards.length === 0) break; // genuinely out of results

    let added = 0;
    for (const job of cards) {
      if (!job.jobId || seenIds.has(job.jobId)) continue; // dedupe by id (overlap fix)
      seenIds.add(job.jobId);

      if (maxAgeDays && !withinDays(job.postedDate, maxAgeDays)) continue; // freshness

      if (collapseSimilar) {
        const key = `${job.title}|${job.company}`.toLowerCase();
        if (seenSimilar.has(key)) continue; // collapse multi-city duplicates
        seenSimilar.add(key);
      }

      jobs.push(job);
      added++;
      if (jobs.length >= maxResults) break;
    }

    // Advance by however many cards LinkedIn actually returned (page size
    // varies) — NOT a fixed 10, which is what caused the pagination drift.
    start += cards.length;

    // If a page brought nothing new, LinkedIn is looping us the same results.
    // Stop after two such pages instead of spinning.
    if (added === 0) {
      if (++emptyStreak >= 2) break;
    } else {
      emptyStreak = 0;
    }

    await sleep(1500 + Math.random() * 1500); // be polite: ~1.5–3s between pages
  }

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
