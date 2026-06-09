import axios from "axios";
import * as cheerio from "cheerio";
import * as fs from "fs/promises";
import * as path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import puppeteer from "puppeteer";
import nodeID3, { type Tags } from "node-id3";

const execFileAsync = promisify(execFile);

// node-id3 is a CJS module; keep usage minimal and avoid type-level coupling

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), ".data");
const CHROMIUM_PATH = process.env.CHROMIUM_PATH;
const SEARCH_URL =
  "https://www.wtap.com/wtap-plus/podcasts/mental-health-mondays/";
// Output locations
const AUDIO_SUBDIR = process.env.AUDIO_SUBDIR || "mp3";
const RSS_OUTPUT_FILENAME = process.env.RSS_OUTPUT_FILENAME || "podcast.xml";
const FEED_BASE_URL = process.env.FEED_BASE_URL || ""; // e.g., https://example.com/podcast

// Feed metadata (override via env)
const FEED_TITLE = process.env.FEED_TITLE || "Mental Health Mondays";
const FEED_AUTHOR = process.env.FEED_AUTHOR || "WTAP";
const FEED_DESCRIPTION =
  process.env.FEED_DESCRIPTION ||
  "Audio feed generated from WTAP Mental Health Mondays videos.";
const FEED_LANGUAGE = process.env.FEED_LANGUAGE || "en-us";
const FEED_COPYRIGHT = process.env.FEED_COPYRIGHT || "";
const FEED_IMAGE_URL = process.env.FEED_IMAGE_URL || "";

interface VideoStream {
  stream_type?: string;
  url?: string;
}

interface PlaylistVideoItem {
  streams?: VideoStream[];
}

interface FusionLeadArt {
  type?: string;
  streams?: VideoStream[];
}

interface FusionGlobalContent {
  promo_items?: {
    lead_art?: FusionLeadArt;
  };
}

interface VideoInfo {
  title: string;
  url: string;
  videoUrl?: string;
}

const POWA_PLAYLIST_API =
  "https://gray-config-prod.api.arc-cdn.net/video/v1/ans/playlists/findByPlaylist";

function pickStreamUrl(streams: VideoStream[] | undefined): string | undefined {
  if (!streams || streams.length === 0) return undefined;
  const mp4 = streams.find((s) => s.stream_type === "mp4" && s.url);
  if (mp4?.url) return mp4.url;
  const ts = streams.find((s) => s.stream_type === "ts" && s.url);
  return ts?.url;
}

async function fetchPlaylistStreamUrls(name: string): Promise<string[]> {
  const url = `${POWA_PLAYLIST_API}?name=${encodeURIComponent(name)}&cb=powaCallback`;
  const response = await axios.get<string>(url, {
    responseType: "text",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
    },
  });
  const jsonStr = response.data.replace(/^[^(]*\(/, "").replace(/\);?\s*$/, "");
  const data = JSON.parse(jsonStr) as { playlistItems?: PlaylistVideoItem[] };
  const items = data.playlistItems ?? [];
  return items
    .map((item) => pickStreamUrl(item.streams))
    .filter((u): u is string => !!u);
}

async function ensureDataDir(): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.mkdir(path.join(DATA_DIR, AUDIO_SUBDIR), { recursive: true });
  } catch (error) {
    console.error("Failed to create .data directory:", error);
  }
}

async function fetchPage(url: string): Promise<string> {
  try {
    const response = await axios.get<string>(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
    });
    return response.data;
  } catch (error) {
    console.error(`Failed to fetch ${url}:`, error);
    throw error;
  }
}

async function searchForVideos(): Promise<VideoInfo[]> {
  console.log("Fetching search results from:", SEARCH_URL);

  let browser;
  try {
    // Use Puppeteer to render JavaScript-heavy page
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.goto(SEARCH_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Wait specifically for episode cards on the index page
    await page
      .waitForSelector("div.card-body", { timeout: 15000 })
      .catch(() => {
        console.log("Episode cards not found yet, proceeding anyway");
      });

    // Get the page content
    const html = await page.content();
    const $ = cheerio.load(html);

    const videos: VideoInfo[] = [];

    const isEpisodeUrl = (href: string): boolean => {
      try {
        const u = href.startsWith("http")
          ? new URL(href)
          : new URL(href, "https://www.wtap.com");
        // Exclude index and known non-episode paths
        if (u.href.replace(/\/?$/, "/") === SEARCH_URL) return false;
        if (u.pathname === "/homepage") return false;
        // Accept article-style URLs: /YYYY/MM/DD/slug/
        return /^\/\d{4}\/\d{2}\/\d{2}\//.test(u.pathname);
      } catch {
        return false;
      }
    };

    // Parse episode cards and extract links
    $("div.card-body").each((_i, card) => {
      const linkEl = $(card).find("a[href]").first();
      const href = linkEl.attr("href")?.trim();
      if (!href) return;

      // Require typical article date-path URLs
      if (!isEpisodeUrl(href)) return;

      const url = href.startsWith("http")
        ? href
        : new URL(href, "https://www.wtap.com").href;

      // Skip if it links back to the index itself
      if (url.replace(/\/?$/, "/") === SEARCH_URL) return;

      // Prefer heading text inside the card, then link text
      const title =
        $(card).find("h1, h2, h3").first().text().trim() ||
        linkEl.text().trim() ||
        "Mental Health Mondays";

      if (!videos.some((v) => v.url === url)) {
        videos.push({ title, url });
      }
    });

    // If nothing found (unexpected), fall back to any anchors on the page that look like article URLs
    if (videos.length === 0) {
      $("a[href]").each((_index, element) => {
        const href = $(element).attr("href")?.trim();
        if (!href) return;
        if (!isEpisodeUrl(href)) return;
        const url = href.startsWith("http")
          ? href
          : new URL(href, "https://www.wtap.com").href;

        const title = $(element).text().trim() || "Mental Health Mondays";
        if (!videos.some((v) => v.url === url)) {
          videos.push({ title, url });
        }
      });
    }

    console.log(`Found ${videos.length} Mental Health Mondays episodes`);
    return videos;
  } catch (error) {
    console.error("Error during search:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function extractVideoUrls(pageUrl: string): Promise<string[]> {
  console.log(`Extracting video URL(s) from: ${pageUrl}`);
  const html = await fetchPage(pageUrl);

  // 1) Try Fusion.globalContent — single video at promo_items.lead_art
  const metadataMatch = html.match(/Fusion\.globalContent=({[\s\S]*?});/);
  if (metadataMatch) {
    try {
      const metadata = JSON.parse(metadataMatch[1]) as FusionGlobalContent;
      const leadArt = metadata.promo_items?.lead_art;
      if (leadArt?.type === "video") {
        const url = pickStreamUrl(leadArt.streams);
        if (url) return [url];
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  const $ = cheerio.load(html);

  // 2) Powa playlist player — multi-part (or named single-item) playlist
  const playlistEl = $('[id^="powa-playlist"]').first();
  const playlistName = playlistEl.attr("data-playlist");
  if (playlistName) {
    try {
      const urls = await fetchPlaylistStreamUrls(playlistName);
      if (urls.length > 0) {
        console.log(
          `Found playlist "${playlistName}" with ${urls.length} part(s)`,
        );
        return urls;
      }
    } catch (error) {
      console.warn(`Failed to fetch playlist "${playlistName}":`, error);
    }
  }

  // 3) Direct <video><source></source></video>
  const videoSrc = $("video source").attr("src") || $("video").attr("src");
  if (videoSrc) return [videoSrc];

  // 4) Look for obvious media URLs in inline scripts
  const scriptsText = $("script")
    .map((_i, el) => $(el).html() || "")
    .get()
    .join("\n");

  const urlFromScripts =
    scriptsText.match(
      /https?:\/\/[^"'\s>]+\.(?:m3u8|mp4)(?:\?[^"'\s>]*)?/i,
    )?.[0] ||
    scriptsText.match(
      /\b(?:file|src|source|url)\b\s*[:=]\s*["'](https?:[^"']+\.(?:m3u8|mp4)[^"']*)["']/i,
    )?.[1];
  if (urlFromScripts) return [urlFromScripts];

  // 5) Check data attributes commonly used by players
  const dataUrl =
    $("[data-video-src]").attr("data-video-src") ||
    $("[data-src]").attr("data-src") ||
    $("[data-url]").attr("data-url");
  if (dataUrl && /\.(?:m3u8|mp4)(?:\?|$)/i.test(dataUrl)) return [dataUrl];

  // 6) Fallback to Puppeteer to capture dynamically loaded media URLs
  let browser: puppeteer.Browser | undefined;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: CHROMIUM_PATH,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    let capturedUrl: string | null = null;

    page.on("response", (resp) => {
      try {
        const u = resp.url();
        if (/\.(?:m3u8|mp4)(?:\?|$)/i.test(u) && resp.status() < 400) {
          if (!capturedUrl) capturedUrl = u;
        }
      } catch {
        // ignore
      }
    });

    await page.goto(pageUrl, { waitUntil: "networkidle2", timeout: 30000 });

    const domUrl = (await page.evaluate(() => {
      const s = document.querySelector<HTMLSourceElement>("video source");
      if (s?.src) return s.src;
      const v = document.querySelector("video");
      if (v?.src) return v.src;
      const i = document.querySelector("iframe");
      if (i?.src && (i.src.includes("youtube") || i.src.includes("vimeo")))
        return i.src;
      return null as unknown as string | null;
    })) as unknown as string | null;

    if (domUrl) return [domUrl];
    if (capturedUrl) return [capturedUrl];
  } catch {
    // ignore puppeteer issues
  } finally {
    if (browser) await browser.close();
  }

  console.warn("Could not find video URL in page");
  return [];
}

interface ArticleMeta {
  title?: string;
  description?: string;
  pubDate?: string;
}

async function fetchArticleMeta(pageUrl: string): Promise<ArticleMeta> {
  try {
    const html = await fetchPage(pageUrl);
    const $ = cheerio.load(html);

    const title =
      $("meta[property='og:title']").attr("content") || $("title").text();
    const description =
      $("meta[name='description']").attr("content") ||
      $("meta[property='og:description']").attr("content") ||
      undefined;

    const pubDate =
      $("meta[property='article:published_time']").attr("content") ||
      $("time[datetime]").attr("datetime") ||
      undefined;

    return { title: title?.trim(), description: description?.trim(), pubDate };
  } catch (error) {
    console.warn("Failed to fetch article metadata:", error);
    return {};
  }
}

async function setFileModTime(
  filePath: string,
  pubDate?: string,
): Promise<void> {
  if (!pubDate) return;
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return;
  try {
    await fs.utimes(filePath, d, d);
    console.log(
      `Set file modification time for ${path.basename(filePath)} to ${d.toISOString()}`,
    );
  } catch (error) {
    console.warn(
      `Failed to set file modification time for ${path.basename(filePath)}`,
      error,
    );
  }
}

function tagAudio(audioPath: string, meta: ArticleMeta): boolean {
  try {
    const tags: Tags = {
      title: meta.title ?? undefined,
      artist: "WTAP",
      album: "Mental Health Mondays",
      comment: {
        language: "eng",
        text: meta.description ?? "",
      },
    };

    if (meta.pubDate) {
      const d = new Date(meta.pubDate);
      if (!Number.isNaN(d.getTime())) {
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        // Use ID3v2.4 recording time (yyyy or yyyy-MM or yyyy-MM-dd are valid)
        tags.recordingTime = `${yyyy}-${mm}-${dd}`;
        // Also set year for ID3v2.3 compatibility
        tags.year = String(yyyy);
        // Set ID3v2.3 date (DDMM)
        tags.date = `${dd}${mm}`;
      }
    }

    const success = nodeID3.update(tags, audioPath);
    if (success === true) {
      console.log(`Tagged audio: ${audioPath}`);
      return true;
    }

    console.warn(`Failed to write ID3 tags for ${audioPath}`);
    return false;
  } catch (error) {
    console.error(`Error tagging audio ${audioPath}:`, error);
    return false;
  }
}

type EpisodeForFeed = {
  file: string; // basename of the mp3
  title: string;
  description: string;
  pub_date: string; // ISO
  explicit: boolean;
  season: number;
  episode_type: "full" | "trailer" | "bonus";
  fileSize?: number; // bytes
  duration?: string; // HH:MM:SS
};

async function downloadFile(url: string, destPath: string): Promise<boolean> {
  try {
    console.log(`Downloading: ${path.basename(destPath)}`);
    const response = await axios.get(url, {
      responseType: "stream",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
      },
      timeout: 60000,
    });

    await pipeline(response.data, createWriteStream(destPath));
    console.log(`Successfully downloaded: ${path.basename(destPath)}`);
    return true;
  } catch (error) {
    console.error(`Failed to download: ${url}`, error);
    try {
      await fs.unlink(destPath);
    } catch {
      // ignore cleanup errors
    }
    return false;
  }
}

function buildFilenameFromPubDate(pubDate?: string): string {
  let dateStr: string | undefined;
  if (pubDate) {
    const d = new Date(pubDate);
    if (!Number.isNaN(d.getTime())) {
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      dateStr = `${yyyy}-${mm}-${dd}`;
    }
  }
  if (!dateStr) {
    dateStr = new Date().toISOString().slice(0, 10);
  }
  return `Mental-Health-Mondays-${dateStr}.mp4`;
}

async function extractAudio(
  videoPaths: string[],
  audioPath: string,
): Promise<boolean> {
  try {
    if (videoPaths.length === 1) {
      console.log(`Extracting audio from: ${path.basename(videoPaths[0])}`);
      await execFileAsync("ffmpeg", [
        "-i",
        videoPaths[0],
        "-q:a",
        "9",
        "-map",
        "a",
        audioPath,
        "-y",
      ]);
    } else {
      console.log(
        `Extracting and concatenating audio from ${videoPaths.length} parts`,
      );
      const args: string[] = [];
      for (const p of videoPaths) args.push("-i", p);
      const filter =
        videoPaths.map((_, i) => `[${i}:a]`).join("") +
        `concat=n=${videoPaths.length}:v=0:a=1[out]`;
      args.push(
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-q:a",
        "9",
        audioPath,
        "-y",
      );
      await execFileAsync("ffmpeg", args);
    }
    console.log(`Successfully extracted audio to: ${path.basename(audioPath)}`);
    return true;
  } catch (error) {
    console.error(`Failed to extract audio:`, error);
    return false;
  }
}

async function produceEpisodeAudio(
  videoUrls: string[],
  baseFilename: string,
): Promise<boolean> {
  const audioPath = path.join(
    DATA_DIR,
    AUDIO_SUBDIR,
    baseFilename.replace(/\.mp4$/i, ".mp3"),
  );

  try {
    await fs.stat(audioPath);
    console.log(`Audio already exists: ${path.basename(audioPath)}`);
    return true;
  } catch {
    // audio doesn't exist, continue
  }

  const baseNoExt = baseFilename.replace(/\.mp4$/i, "");
  const partFilenames =
    videoUrls.length === 1
      ? [baseFilename]
      : videoUrls.map((_, i) => `${baseNoExt}.part${i + 1}.mp4`);
  const partPaths = partFilenames.map((f) => path.join(DATA_DIR, f));

  for (let i = 0; i < videoUrls.length; i++) {
    const exists = await fs
      .stat(partPaths[i])
      .then(() => true)
      .catch(() => false);
    if (exists) {
      console.log(`Part already downloaded: ${partFilenames[i]}`);
      continue;
    }
    const ok = await downloadFile(videoUrls[i], partPaths[i]);
    if (!ok) return false;
  }

  const extracted = await extractAudio(partPaths, audioPath);
  if (!extracted) return false;

  for (const p of partPaths) {
    try {
      await fs.unlink(p);
    } catch {
      // ignore cleanup errors
    }
  }

  return true;
}

async function probeDurationSeconds(filePath: string): Promise<number | null> {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const seconds = parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : null;
  } catch {
    return null;
  }
}

function formatDurationHHMMSS(totalSeconds: number): string {
  const sec = Math.floor(totalSeconds);
  const h = Math.floor(sec / 3600)
    .toString()
    .padStart(2, "0");
  const m = Math.floor((sec % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const s = Math.floor(sec % 60)
    .toString()
    .padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function writeRssFeed(episodes: EpisodeForFeed[]): Promise<void> {
  // Sort newest first for feed readers
  const items = [...episodes].sort(
    (a, b) => new Date(b.pub_date).getTime() - new Date(a.pub_date).getTime(),
  );
  const lastBuild = items[0]?.pub_date
    ? new Date(items[0].pub_date).toUTCString()
    : new Date().toUTCString();

  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(
    `<rss version="2.0"\n  xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">`,
  );
  lines.push(`  <channel>`);
  lines.push(`    <title>${xmlEscape(FEED_TITLE)}</title>`);
  if (FEED_BASE_URL) lines.push(`    <link>${xmlEscape(FEED_BASE_URL)}</link>`);
  lines.push(`    <description>${xmlEscape(FEED_DESCRIPTION)}</description>`);
  lines.push(`    <language>${xmlEscape(FEED_LANGUAGE)}</language>`);
  if (FEED_COPYRIGHT)
    lines.push(`    <copyright>${xmlEscape(FEED_COPYRIGHT)}</copyright>`);
  lines.push(`    <lastBuildDate>${lastBuild}</lastBuildDate>`);
  lines.push(`    <itunes:author>${xmlEscape(FEED_AUTHOR)}</itunes:author>`);
  lines.push(`    <itunes:explicit>no</itunes:explicit>`);
  if (FEED_IMAGE_URL) {
    lines.push(`    <image>`);
    lines.push(`      <url>${xmlEscape(FEED_IMAGE_URL)}</url>`);
    lines.push(`      <title>${xmlEscape(FEED_TITLE)}</title>`);
    if (FEED_BASE_URL)
      lines.push(`      <link>${xmlEscape(FEED_BASE_URL)}</link>`);
    lines.push(`    </image>`);
    lines.push(`    <itunes:image href="${xmlEscape(FEED_IMAGE_URL)}" />`);
  }

  for (let episodeNumber = 1; episodeNumber <= items.length; episodeNumber++) {
    const ep = items[items.length - episodeNumber];
    const pubDate = new Date(ep.pub_date).toUTCString();
    const enclosureUrl = [
      FEED_BASE_URL?.replace(/\/?$/, ""),
      AUDIO_SUBDIR,
      ep.file,
    ]
      .filter(Boolean)
      .join("/");
    const guid = enclosureUrl || ep.file;
    const enclosureLength = ep.fileSize ? String(ep.fileSize) : "0";

    lines.push(`    <item>`);
    lines.push(`      <title>${xmlEscape(ep.title)}</title>`);
    lines.push(`      <description>${xmlEscape(ep.description)}</description>`);
    lines.push(`      <pubDate>${pubDate}</pubDate>`);
    lines.push(
      `      <guid isPermaLink="${FEED_BASE_URL ? "true" : "false"}">${xmlEscape(guid)}</guid>`,
    );
    lines.push(
      `      <enclosure url="${xmlEscape(enclosureUrl)}" length="${enclosureLength}" type="audio/mpeg" />`,
    );
    lines.push(`      <itunes:season>1</itunes:season>`);
    lines.push(`      <itunes:episode>${episodeNumber}</itunes:episode>`);
    lines.push(
      `      <itunes:explicit>${ep.explicit ? "yes" : "no"}</itunes:explicit>`,
    );
    if (ep.duration)
      lines.push(`      <itunes:duration>${ep.duration}</itunes:duration>`);
    lines.push(`    </item>`);
  }

  lines.push(`  </channel>`);
  lines.push(`</rss>`);

  const outPath = path.join(DATA_DIR, RSS_OUTPUT_FILENAME);
  await fs.writeFile(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote RSS feed: ${outPath}`);
}

async function main(): Promise<void> {
  try {
    await ensureDataDir();

    const videos = await searchForVideos();

    if (videos.length === 0) {
      console.log("No Mental Health Mondays episodes found");
      return;
    }

    const episodesForFeed: EpisodeForFeed[] = [];

    for (const video of videos) {
      console.log(`\nProcessing: ${video.title}`);

      const videoUrls = await extractVideoUrls(video.url);
      if (videoUrls.length === 0) {
        console.warn(`Skipping ${video.title} - could not extract video URL`);
        continue;
      }

      // Fetch article metadata first to derive filename from publication date
      const meta = await fetchArticleMeta(video.url);
      const filename = buildFilenameFromPubDate(meta.pubDate);
      const audioPath = path.join(
        DATA_DIR,
        AUDIO_SUBDIR,
        filename.replace(/\.mp4$/i, ".mp3"),
      );

      const produced = await produceEpisodeAudio(videoUrls, filename);
      if (!produced) {
        console.warn(
          `Skipping tagging for ${filename} - audio production failed`,
        );
        continue;
      }

      // Tag audio if it exists (reusing fetched metadata)
      try {
        await fs.stat(audioPath);
        tagAudio(audioPath, meta);
        await setFileModTime(audioPath, meta.pubDate);

        // Gather file stats and optional duration
        const st = await fs.stat(audioPath);
        const durSec = await probeDurationSeconds(audioPath);

        // Prepare feed episode entry
        const feedEp: EpisodeForFeed = {
          file: path.basename(audioPath),
          title: meta.title ?? "Mental Health Mondays",
          description: meta.description ?? "",
          pub_date: (meta.pubDate
            ? new Date(meta.pubDate)
            : new Date()
          ).toISOString(),
          explicit: false,
          season: 1,
          episode_type: "full",
          fileSize: st.size,
          duration: durSec ? formatDurationHHMMSS(durSec) : undefined,
        };
        episodesForFeed.push(feedEp);
      } catch {
        console.warn(`Audio file not found, skipping tag for ${filename}`);
      }
    }

    // Generate RSS feed
    await writeRssFeed(episodesForFeed);

    console.log("\nScraping complete!");
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

void main();
