import express, { json } from "express";
import cors from "cors";
import { chromium } from "playwright";
import pLimit from "p-limit";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { getTVSubtitleVTT } from "./utils/tvSubtitles.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

export const OPENSUB_API_KEY = process.env.OPENSUB_API_KEY;
export const TMDB_API_KEY = process.env.TMDB_API_KEY;
export const TMDB_BEARER_TOKEN = process.env.TMDB_BEARER_TOKEN;

export const headers = {
  Authorization: `Bearer ${TMDB_BEARER_TOKEN}`,
  "Content-Type": "application/json;charset=utf-8",
};

app.use(cors());
app.use(json());

// Removed dead providers (.xyz and .net)
const PROVIDERS = [
  "https://vidsrc.in",
  "https://vidsrc.pm",
];

export const LANGUAGE_NAMES = {
  en: "English",
};

export const COMMON_LANGUAGES = Object.keys(LANGUAGE_NAMES);

let browser;

// In-memory cache
const cache = new Map();

// Cleanup cache every 5 mins
setInterval(() => {
  const now = Date.now();

  for (const [key, value] of cache.entries()) {
    if (now - value.timestamp > 1000 * 60 * 15) {
      cache.delete(key);
    }
  }
}, 1000 * 60 * 5);

// Limit concurrent scraping
const limit = pLimit(2);

function isSubtitle(url) {
  // Ignore thumbnail sprite tracks
  if (url.includes("thumbnails.vtt")) return false;

  return (
    /\.(vtt|srt)(\?.*)?$/.test(url) ||
    url.includes(".vtt") ||
    url.includes(".srt")
  );
}

async function scrapeProvider(domain, url) {
  const start = Date.now();

  console.log(`\n[${domain}] Starting scrape for URL: ${url}`);

  const context = await browser.newContext({
    viewport: {
      width: 1366,
      height: 768,
    },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();

  let hlsUrl = null;
  const subtitles = [];

  try {
    // Intercept requests
    await page.route("**/*", (route) => {
      const reqUrl = route.request().url();

      // Capture HLS streams
      if (
        !hlsUrl &&
        reqUrl.includes(".m3u8") &&
        !reqUrl.includes("thumbnail")
      ) {
        hlsUrl = reqUrl;
        console.log(`[${domain}] Found HLS URL: ${hlsUrl}`);
      }

      // Capture subtitles
      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
        console.log(`[${domain}] Found subtitle URL: ${reqUrl}`);
      }

      route.continue();
    });

    // Also listen for dynamic requests
    page.on("request", (request) => {
      const reqUrl = request.url();

      if (isSubtitle(reqUrl) && !subtitles.includes(reqUrl)) {
        subtitles.push(reqUrl);
        console.log(`[${domain}] Dynamic subtitle found: ${reqUrl}`);
      }
    });

    // Optional response listener for future-proofing
    page.on("response", async (response) => {
      try {
        const responseUrl = response.url();

        if (
          !hlsUrl &&
          responseUrl.includes(".m3u8") &&
          !responseUrl.includes("thumbnail")
        ) {
          hlsUrl = responseUrl;
          console.log(`[${domain}] Response HLS found: ${hlsUrl}`);
        }
      } catch {}
    });

    page.on("frameattached", (frame) => {
      console.log(`[${domain}] Frame attached: ${frame.url()}`);
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log(`[${domain}] Page loaded`);

    const selectors = [
      "#the_frame",
      "iframe",
      ".iframe-container iframe",
      ".player iframe",
      "[src*='embed']",
    ];

    let frameDiv = null;

    for (const selector of selectors) {
      try {
        frameDiv = await page.waitForSelector(selector, {
          timeout: 5000,
        });

        if (frameDiv) {
          console.log(`[${domain}] Found player selector: ${selector}`);
          break;
        }
      } catch {}
    }

    if (frameDiv) {
      const box = await frameDiv.boundingBox();

      if (box) {
        const clickX = box.x + box.width / 2;
        const clickY = box.y + box.height / 2;

        console.log(
          `[${domain}] Clicking at (${clickX.toFixed(1)}, ${clickY.toFixed(
            1
          )})`
        );

        await page.mouse.move(clickX, clickY);
        await page.mouse.click(clickX, clickY);
      } else {
        console.warn(`[${domain}] Using JS click fallback`);

        await page.evaluate(() => {
          const el =
            document.querySelector("#the_frame") ||
            document.querySelector("iframe");

          if (el) el.click();
        });
      }

      // Wait for network activity
      await page.waitForTimeout(7000);

      // Extra wait for HLS if not found yet
      if (!hlsUrl) {
        await page
          .waitForResponse((resp) => resp.url().includes(".m3u8"), {
            timeout: 7000,
          })
          .catch(() => {
            console.warn(`[${domain}] No .m3u8 detected within timeout`);
          });
      }

      // Extra subtitle wait
      if (subtitles.length === 0) {
        console.warn(`[${domain}] No subtitles found yet, waiting extra 5s`);
        await page.waitForTimeout(5000);
      }
    } else {
      console.warn(`[${domain}] No player selector found`);
    }

    await page.close();
    await context.close();

    // Only fail if BOTH stream and subtitles are missing
    if (!hlsUrl && subtitles.length === 0) {
      throw new Error("No stream or subtitles extracted");
    }

    console.log(
      `[${domain}] Finished in ${(Date.now() - start) / 1000}s`
    );

    return {
      success: !!hlsUrl,
      hls_url: hlsUrl,
      subtitles,
      error: null,
    };
  } catch (error) {
    await page.close().catch(() => {});
    await context.close().catch(() => {});

    console.error(`[${domain}] Error: ${error.message}`);

    return {
      success: false,
      hls_url: null,
      subtitles: [],
      error: error.message,
    };
  }
}

// Extract endpoint
app.get("/extract", async (req, res) => {
  const type = req.query.type || "movie";
  const tmdb_id = req.query.tmdb_id;
  const season = req.query.season ? parseInt(req.query.season) : undefined;
  const episode = req.query.episode ? parseInt(req.query.episode) : undefined;

  if (!tmdb_id) {
    return res.status(400).json({
      success: false,
      error: "tmdb_id query param is required",
      results: {},
    });
  }

  if (type === "tv" && (season == null || episode == null)) {
    return res.status(400).json({
      success: false,
      error: "season and episode query params are required for TV shows",
      results: {},
    });
  }

  const cacheKey = JSON.stringify(req.query);

  const cached = cache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < 1000 * 60 * 15) {
    console.log("Serving cached response");
    return res.json(cached.response);
  }

  const urls = PROVIDERS.reduce((acc, domain) => {
    acc[domain] =
      type === "tv"
        ? `${domain}/embed/tv?tmdb=${tmdb_id}&season=${season}&episode=${episode}`
        : `${domain}/embed/movie/${tmdb_id}`;

    return acc;
  }, {});

  try {
    const resultsArr = await Promise.all(
      Object.entries(urls).map(([domain, url]) =>
        limit(async () => {
          try {
            const result = await scrapeProvider(domain, url);
            return [domain, result];
          } catch (err) {
            console.error(`[${domain}] Final error: ${err.message}`);

            return [
              domain,
              {
                success: false,
                hls_url: null,
                subtitles: [],
                error: err.message,
              },
            ];
          }
        })
      )
    );

    const results = Object.fromEntries(resultsArr);

    // Success if ANY provider works
    const success = Object.values(results).some((r) => r.hls_url);

    // Best provider result
    const bestResult = Object.values(results).find((r) => r.hls_url);

    const response = {
      success,
      stream_found: !!bestResult,
      hls_url: bestResult?.hls_url || null,
      subtitles: bestResult?.subtitles || [],
      results,
    };

    cache.set(cacheKey, {
      timestamp: Date.now(),
      response,
    });

    res.json(response);
  } catch (err) {
    console.error("Unexpected server error:", err.message);

    res.status(500).json({
      success: false,
      error: "Unexpected server error",
      results: {},
    });
  }
});

/**
 * TMDB -> IMDb
 */
async function getIMDbIdFromTMDB(tmdb_id, type = "movie") {
  const url = `https://api.themoviedb.org/3/${type}/${tmdb_id}/external_ids?api_key=${TMDB_API_KEY}`;

  const response = await fetch(url, { headers });

  if (!response.ok) {
    throw new Error("Failed to fetch IMDb ID from TMDB");
  }

  const json = await response.json();

  return json.imdb_id || null;
}

/**
 * Subtitle Search
 */
async function searchSubtitles(imdb_id) {
  const res = await fetch(
    `https://api.opensubtitles.com/api/v1/subtitles?imdb_id=${imdb_id}&per_page=100&page=1`,
    {
      headers: {
        "Api-Key": OPENSUB_API_KEY,
        "User-Agent": "DVerse v1.0.0",
      },
    }
  );

  if (!res.ok) {
    console.error("[OpenSubtitles] Request failed");
    return [];
  }

  const json = await res.json();

  if (!json.data || json.data.length === 0) {
    return [];
  }

  return (json.data || [])
    .filter(
      (item) =>
        item.attributes?.files?.[0]?.file_id &&
        COMMON_LANGUAGES.includes(item.attributes.language)
    )
    .map((item) => {
      const file = item.attributes.files[0];
      const lang = item.attributes.language;

      return {
        language: lang,
        language_name: LANGUAGE_NAMES[lang] || lang,
        file_id: file.file_id,
        download_count: item.attributes.download_count || 0,
      };
    })
    .sort((a, b) => b.download_count - a.download_count)
    .slice(0, 2);
}

/**
 * Get subtitle download URL
 */
async function getSubtitleDownloadUrl(file_id) {
  const res = await fetch("https://api.opensubtitles.com/api/v1/download", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": OPENSUB_API_KEY,
      "User-Agent": "DVerse v1.0.0",
    },
    body: JSON.stringify({ file_id }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("[OpenSubtitles] Failed:", text);
    throw new Error("Subtitle download URL fetch failed");
  }

  const json = await res.json();

  return json.link;
}

/**
 * Movie subtitles endpoint
 */
app.get("/movie-subtitles", async (req, res) => {
  const { tmdb_id, type = "movie" } = req.query;

  if (!tmdb_id) {
    return res
      .status(400)
      .json({ success: false, error: "tmdb_id is required" });
  }

  try {
    const imdb_id = await getIMDbIdFromTMDB(tmdb_id, type);

    if (!imdb_id) {
      return res
        .status(404)
        .json({ success: false, error: "IMDb ID not found" });
    }

    const baseList = await searchSubtitles(imdb_id);

    const subtitles = await Promise.all(
      baseList.map(async (sub) => {
        try {
          const url = await getSubtitleDownloadUrl(sub.file_id);

          return {
            language: sub.language,
            language_name: sub.language_name,
            url,
          };
        } catch {
          return null;
        }
      })
    );

    res.json({
      success: true,
      subtitles: subtitles.filter(Boolean),
      meta: {
        tmdb_id,
        imdb_id,
        type,
      },
    });
  } catch (err) {
    console.error("[/movie-subtitles] Error:", err.message);

    res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

/**
 * TV subtitles endpoint
 */
app.get("/tv-subtitles", async (req, res) => {
  const { title, season, episode, type } = req.query;

  try {
    if (type === "tv") {
      const vtt = await getTVSubtitleVTT(title, season, episode);

      if (!vtt) {
        return res.status(404).send("No subtitle found");
      }

      return res
        .set("Content-Type", "text/vtt")
        .send(vtt);
    }

    res.status(400).send("Invalid type provided");
  } catch (err) {
    console.error("Subtitle API Error:", err.message);
    res.status(500).send("Internal server error");
  }
});

/**
 * Subtitle proxy
 */
app.get("/subtitle-proxy", async (req, res) => {
  const fileUrl = req.query.url;

  if (!fileUrl) {
    return res.status(400).send("Missing subtitle URL");
  }

  try {
    const subtitleRes = await fetch(fileUrl);
    const srt = await subtitleRes.text();

    const vtt =
      "WEBVTT\n\n" +
      srt
        .replace(/\r+/g, "")
        .replace(/^\s+|\s+$/g, "")
        .split("\n")
        .map((line) =>
          line.replace(
            /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g,
            "$1:$2:$3.$4"
          )
        )
        .join("\n");

    res.setHeader("Content-Type", "text/vtt");
    res.send(vtt);
  } catch (err) {
    console.error("Subtitle Proxy Error:", err.message);
    res.status(500).send("Failed to convert subtitle");
  }
});

app.get("/", (req, res) => {
  res.send(
    "🎬 D. Verse VidSrc Extractor API is running. Visit /extract, /movie-subtitles or /tv-subtitles"
  );
});

// Launch browser once
(async () => {
  browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
  });
})();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Closing browser...");

  if (browser) {
    await browser.close();
  }

  process.exit();
});

process.on("SIGTERM", async () => {
  console.log("Closing browser...");

  if (browser) {
    await browser.close();
  }

  process.exit();
});