#!/usr/bin/env node
/**
 * Static Ads Webapp Server
 * Local HTTP server that provides a web UI for the Static Ads pipeline.
 *
 * Usage:
 *   node webapp/server.mjs
 *   node webapp/server.mjs --port 3000
 *
 * API:
 *   GET  /                      → serves webapp/public/index.html
 *   GET  /api/brands            → list brands with state
 *   POST /api/brands            → create a new brand
 *   GET  /api/brands/:name      → brand state (files, prompts, outputs)
 *   POST /api/brands/:name/upload-dna     → { content } → brand-dna.md
 *   POST /api/brands/:name/upload-image   → { filename, data(base64), type } → saves to product-images/ or brand-images/
 *   DELETE /api/brands/:name/upload-image → { filename, type }
 *   GET  /api/brands/:name/prompts        → prompts.json
 *   PUT  /api/brands/:name/prompts        → { prompts } → saves prompts.json
 *   GET  /api/brands/:name/outputs        → list output versions
 *   GET  /api/brands/:name/outputs/:ver   → image manifest per template/ratio
 *   PUT  /api/brands/:name/outputs/:ver/selections → saves selections.json
 *   POST /api/brands/:name/generate       → body + SSE → spawns generate_ads_gemini.mjs, streams logs
 *   POST /api/brands/:name/outputs/:ver/copy  → generates ad copy CSV + xlsx + Ad-uploads/
 *   GET  /api/hooks             → parse hook-bank.md
 *   GET  /api/brands/:name/outputs/:ver/files/* → serve output image files
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync, copyFileSync, renameSync } from "fs";
import { join, extname, resolve, dirname, basename, relative } from "path";
import { fileURLToPath } from "url";
import { createServer } from "http";
import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import { parseArgs } from "util";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ROOT = resolve(__dirname, "..");
const PUBLIC_DIR = join(__dirname, "public");
const BRANDS_DIR = join(ROOT, "brands");
const SKILLS_DIR = join(ROOT, "skills", "references");
const GEN_SCRIPT = join(SKILLS_DIR, "generate_ads_gemini.mjs");
const HOOK_BANK = join(ROOT, "hook-bank.md");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonError(res, message, status = 400) {
  json(res, { error: message }, status);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function parseUrl(req) {
  const url = new URL(req.url, "http://localhost");
  // e.g. /api/brands/foo/outputs/V1/files/01-headline/1x1/img.png
  const path = url.pathname;
  const segments = path.split("/").filter(Boolean);
  return { url, path, segments };
}

function safeName(name) {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function base64ToBuffer(data) {
  // Handle data URI or raw base64
  const raw = data.includes(",") ? data.split(",")[1] : data;
  return Buffer.from(raw, "base64");
}

function stripVersion(filename) {
  return filename.replace(/_v\d+(?=\.\w+$)/, "");
}

// ---------------------------------------------------------------------------
// Brand helpers
// ---------------------------------------------------------------------------

function listBrands() {
  if (!existsSync(BRANDS_DIR)) return [];
  return readdirSync(BRANDS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name)
    .sort();
}

function brandDir(name) {
  return join(BRANDS_DIR, name);
}

function brandState(name) {
  const dir = brandDir(name);
  if (!existsSync(dir)) return null;

  const hasDna = existsSync(join(dir, "brand-dna.md"));
  const hasPrompts = existsSync(join(dir, "prompts.json"));

  const listFiles = (sub) => {
    const p = join(dir, sub);
    if (!existsSync(p)) return [];
    return readdirSync(p).filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase())).sort();
  };

  const outputsDir = join(dir, "outputs");
  let outputs = [];
  if (existsSync(outputsDir)) {
    outputs = readdirSync(outputsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => {
        const verDir = join(outputsDir, d.name);
        const hasSelections = existsSync(join(verDir, "selections.json"));
        const hasCopy = existsSync(join(verDir, "upload.csv"));
        // Count templates
        const templates = readdirSync(verDir, { withFileTypes: true })
          .filter((t) => t.isDirectory() && /^\d{2}-/.test(t.name))
          .length;
        const totalImages = countImages(verDir);
        return { version: d.name, templates, totalImages, hasSelections, hasCopy };
      })
      .sort((a, b) => b.version.localeCompare(a.version));
  }

  return {
    name,
    hasDna,
    hasPrompts,
    productImages: listFiles("product-images"),
    brandImages: listFiles("brand-images"),
    outputs,
  };
}

function countImages(dir) {
  let count = 0;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory() && e.name !== "Ad-uploads") {
        count += countImages(full);
      } else if (IMAGE_EXTS.has(extname(e.name).toLowerCase())) {
        count++;
      }
    }
  } catch {}
  return count;
}

// ---------------------------------------------------------------------------
// Output / image manifest
// ---------------------------------------------------------------------------

function scanOutputVersion(versionDir) {
  // Returns array of template groups
  const groups = [];
  if (!existsSync(versionDir)) return groups;

  const entries = readdirSync(versionDir, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !/^\d{2}-/.test(e.name)) continue;
    const templateDir = join(versionDir, e.name);
    const promptFile = join(templateDir, "prompt.txt");
    const promptText = existsSync(promptFile) ? readFileSync(promptFile, "utf-8") : "";

    const ratios = {};
    const ratioDirs = readdirSync(templateDir, { withFileTypes: true });
    for (const r of ratioDirs) {
      if (!r.isDirectory()) continue;
      if (!["1x1", "9x16", "4x5", "16x9"].includes(r.name)) continue;
      const images = readdirSync(join(templateDir, r.name))
        .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
        .sort()
        .map((f) => ({
          filename: f,
          path: relative(versionDir, join(templateDir, r.name, f)),
          url: f,
        }));
      if (images.length > 0) ratios[r.name] = images;
    }

    groups.push({
      folder: e.name,
      templateNumber: parseInt(e.name.split("-")[0], 10),
      templateName: e.name.slice(3),
      prompt: promptText,
      ratios,
    });
  }

  return groups.sort((a, b) => a.templateNumber - b.templateNumber);
}

// ---------------------------------------------------------------------------
// Copy generation (Phase 4)
// ---------------------------------------------------------------------------

function generateAdCopy(brandDir, versionDir, hooks) {
  // Read inputs
  const dnaPath = join(brandDir, "brand-dna.md");
  const dnaText = existsSync(dnaPath) ? readFileSync(dnaPath, "utf-8") : "";
  const brandName = extractBrandName(dnaText) || basename(brandDir);

  const selectionsPath = join(versionDir, "selections.json");
  if (!existsSync(selectionsPath)) {
    return { error: "selections.json not found. Select images first." };
  }
  const selections = JSON.parse(readFileSync(selectionsPath, "utf-8"));

  // Parse hook bank
  const allHooks = parseHookBank();

  // Build rows
  const rows = [];
  const imageDir = join(versionDir, "Ad-uploads");
  mkdirSync(imageDir, { recursive: true });

  for (const [templateFolder, sel] of Object.entries(selections)) {
    if (templateFolder === "excluded") continue;
    if (!sel["1x1"] && !sel["9x16"]) continue;

    const numer = parseInt(templateFolder.split("-")[0], 10);
    const name = templateFolder.slice(3);
    const abbr = brandName.slice(0, 4).toUpperCase();

    // Copy images to Ad-uploads/ with stripped version suffixes
    const imgPaths = {};
    for (const ratio of ["1x1", "9x16"]) {
      if (sel[ratio]) {
        const src = join(versionDir, sel[ratio]);
        if (existsSync(src)) {
          const baseName = stripVersion(basename(src));
          const dest = join(imageDir, baseName);
          copyFileSync(src, dest);
          imgPaths[ratio] = baseName;
        }
      }
    }

    // Assign hooks per funnel stage
    const templateHooks = hooks?.[templateFolder] || {};
    const stages = [
      { stage: "TOF", label: "Cold", hookType: templateHooks.tof || "CURIOSITY" },
      { stage: "MOF", label: "Warm", hookType: templateHooks.mof || "PROOF" },
      { stage: "BOF", label: "Retargeting", hookType: templateHooks.bof || "OFFER" },
    ];

    for (const s of stages) {
      const hook = allHooks.find((h) => h.name.toLowerCase().includes(s.hookType.toLowerCase())) || allHooks[0];
      const primaryText = buildPrimaryText(hook, brandName, name, s.stage);
      const headline = buildHeadline(brandName, name, s.stage);
      const description = buildDescription(brandName, s.stage);
      const cta = s.stage === "BOF" ? "GET_STARTED" : "LEARN_MORE";
      const adSetName = `${s.label} - 18-65`;
      const adName = `${abbr}_${templateFolder}_${s.hookType}_${s.stage}`;
      const websiteUrl = `https://${brandName.toLowerCase().replace(/\s+/g, "")}.com/`;

      rows.push({
        "Campaign Name": `${brandName} - Ad Campaign`,
        "Ad Set Name": adSetName,
        "Ad Name": adName,
        "Primary Text": primaryText,
        "Headline": headline,
        "Description": description,
        "Call to Action": cta,
        "Website URL": websiteUrl,
        "Image File Name (1x1)": imgPaths["1x1"] || "",
        "Image File Name (9x16)": imgPaths["9x16"] || "",
        "Hook Type": s.hookType,
        "Template": templateFolder,
        "Batch ID": basename(versionDir),
      });
    }
  }

  // Write CSV
  const csvPath = join(versionDir, "upload.csv");
  const csvContent = buildCSV(rows);
  writeFileSync(csvPath, csvContent);

  // Write upload-3.csv (copy)
  writeFileSync(join(versionDir, "upload-3.csv"), csvContent);

  // Write copy-summary.md
  writeFileSync(join(versionDir, "copy-summary.md"), buildCopySummary(rows, brandName));

  // Generate XLSX (if exceljs is available)
  try {
    generateXLSX(rows, join(versionDir, "upload-2.xlsx"));
  } catch (e) {
    console.error("XLSX generation skipped:", e.message);
  }

  // Generate ad-library.html using the ad-library.mjs script
  try {
    spawnSync("node", [join(SKILLS_DIR, "ad-library.mjs"), "--output-dir", versionDir], { timeout: 30000 });
  } catch {}

  return {
    rows: rows.length,
    csvPath,
    imagesCopied: Object.keys(rows.reduce((acc, r) => { if (r["Image File Name (1x1)"]) acc[r["Image File Name (1x1)"]] = true; return acc; }, {})).length,
  };
}

const _require = createRequire(import.meta.url);

function generateXLSX(rows, outPath) {
  let ExcelJS;
  try {
    ExcelJS = _require("exceljs");
  } catch {
    console.log("  (exceljs not available, skipping .xlsx generation)");
    return;
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Ads");
  const headers = Object.keys(rows[0]);
  ws.addRow(headers);
  for (const row of rows) {
    ws.addRow(headers.map((h) => row[h] || ""));
  }
  wb.xlsx.writeFile(outPath).catch(() => {});
}

function extractBrandName(dnaText) {
  const m = dnaText.match(/(?:^|\n)#+\s+(?:Brand\s*DNA\s*(?:\w+\s*)*document\s*)?[—–-]?\s*(.+)/i) ||
            dnaText.match(/^\*\*Name\*\*:\s*(.+)/m);
  return m ? m[1].trim() : null;
}

function parseHookBank() {
  const hooks = [];
  if (!existsSync(HOOK_BANK)) return hooks;

  const text = readFileSync(HOOK_BANK, "utf-8");
  const lines = text.split("\n");

  let currentHook = null;
  for (const line of lines) {
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      if (currentHook) hooks.push(currentHook);
      currentHook = { name: h3[1].trim(), group: "", text: "", awareness: "", format: "" };
    } else if (currentHook) {
      const boldMatch = line.match(/^\*\*(.+?)\*\*/);
      if (boldMatch && !line.startsWith(">")) {
        currentHook.text = (currentHook.text + " " + line).trim();
      } else if (line.startsWith("**Awareness:**")) {
        currentHook.awareness = line.split(":**")[1]?.trim() || "";
      } else if (line.startsWith("**Format:**")) {
        currentHook.format = line.split(":**")[1]?.trim() || "";
      } else if (line.startsWith("##")) {
        currentHook.group = line.replace(/^##+\s*/, "").trim();
      }
    }
  }
  if (currentHook) hooks.push(currentHook);
  return hooks;
}

function buildPrimaryText(hook, brand, template, stage) {
  const templates = {
    TOF: `${hook.text || "Discover how ${brand} can help you."} ${brand} makes it simple. See the difference today.`,
    MOF: `You've seen what ${brand} can do. Here's why people choose us: ${hook.text || "Real results, real people."} Ready to take the next step?`,
    BOF: `Don't wait. ${hook.text || "Start your journey with ${brand} today."} Limited time offer. Get started now.`,
  };
  return (templates[stage] || templates.TOF).replace(/\${brand}/g, brand);
}

function buildHeadline(brand, template, stage) {
  const headlines = {
    TOF: `Finally, a ${template} that works`,
    MOF: `Why ${brand}? See for yourself`,
    BOF: `Start your ${template} journey`,
  };
  return (headlines[stage] || headlines.TOF).slice(0, 40);
}

function buildDescription(brand, stage) {
  const descs = {
    TOF: "Learn more today",
    MOF: "Join thousands of users",
    BOF: "Get started free",
  };
  return (descs[stage] || descs.TOF).slice(0, 30);
}

function buildCSV(rows) {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);
  const lines = [headers.map(quoteField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => quoteField(String(row[h] || ""))).join(","));
  }
  return lines.join("\n") + "\n";
}

function quoteField(s) {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function buildCopySummary(rows, brandName) {
  const total = rows.length;
  const templates = new Set(rows.map((r) => r["Template"]));
  let md = `# Ad Copy Summary — ${brandName}\n\n`;
  md += `**Total ads:** ${total} (${templates.size} templates × 3 funnel stages)\n\n`;

  for (const [tpl, tplRows] of Object.entries(groupBy(rows, "Template"))) {
    md += `## Template ${tpl}\n\n`;
    for (const r of tplRows) {
      const stage = r["Ad Name"].split("_").pop();
      md += `### ${stage}\n`;
      md += `- **Hook:** ${r["Hook Type"]}\n`;
      md += `- **Primary Text:** ${r["Primary Text"]}\n`;
      md += `- **Headline:** ${r["Headline"]}\n`;
      md += `- **Description:** ${r["Description"]}\n`;
      md += `- **CTA:** ${r["Call to Action"]}\n\n`;
    }
  }
  return md;
}

function groupBy(arr, key) {
  const map = {};
  for (const item of arr) {
    const k = item[key];
    if (!map[k]) map[k] = [];
    map[k].push(item);
  }
  return map;
}

// ---------------------------------------------------------------------------
// SSE streaming for image generation
// ---------------------------------------------------------------------------

function streamGeneration(req, res, brandName, options) {
  const brandDirPath = brandDir(brandName);

  const args = ["--brand-dir", brandDirPath];
  if (options.templates && options.templates.length > 0) {
    args.push("--templates", options.templates.join(","));
  }
  if (options.numImages) {
    args.push("--num-images", String(options.numImages));
  }
  if (options.ratios && options.ratios.length > 0) {
    args.push("--ratios", options.ratios.join(","));
  }
  if (options.maxConcurrent) {
    args.push("--max-concurrent", String(options.maxConcurrent));
  }

  const child = spawn("node", [GEN_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let outputDir = "";

  child.stdout.on("data", (data) => {
    const text = data.toString("utf-8");
    // Try to capture output directory
    const dirMatch = text.match(/Output:\s+(.+)/);
    if (dirMatch) outputDir = dirMatch[1].trim();

    // Send SSE event
    res.write(`data: ${JSON.stringify({ type: "log", text })}\n\n`);
  });

  child.stderr.on("data", (data) => {
    res.write(`data: ${JSON.stringify({ type: "stderr", text: data.toString() })}\n\n`);
  });

  child.on("close", (code) => {
    if (code === 0) {
      // Find the actual output dir by re-scanning
      const outputsRoot = join(brandDirPath, "outputs");
      let version = "";
      if (existsSync(outputsRoot) && outputDir) {
        version = basename(outputDir);
      } else {
        // Fallback: find latest version
        const dirs = readdirSync(outputsRoot, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .sort();
        if (dirs.length > 0) version = dirs[dirs.length - 1].name;
      }

      res.write(`data: ${JSON.stringify({ type: "done", code, outputDir: outputDir || version, version })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ type: "error", code, message: `Process exited with code ${code}` })}\n\n`);
    }
    res.end();
  });

  // Clean up on client disconnect
  req.on("close", () => {
    child.kill();
  });

  return { child };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  // CORS for local dev
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const { url, path, segments } = parseUrl(req);

  try {
    // Serve static files
    if (path === "/" || !path.startsWith("/api/")) {
      return serveStatic(req, res, path);
    }

    // API routes
    // GET /api/brands
    if (path === "/api/brands" && req.method === "GET") {
      const brands = listBrands().map(brandState);
      return json(res, brands);
    }

    // POST /api/brands — create brand
    if (path === "/api/brands" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const name = safeName(body.name);
      if (!name) return jsonError(res, "Invalid brand name");
      const dir = brandDir(name);
      if (existsSync(dir)) return jsonError(res, "Brand already exists");
      mkdirSync(join(dir, "product-images"), { recursive: true });
      mkdirSync(join(dir, "brand-images"), { recursive: true });
      mkdirSync(join(dir, "outputs"), { recursive: true });
      return json(res, brandState(name), 201);
    }

    // GET /api/brands/:name
    if (segments.length === 3 && segments[0] === "api" && segments[1] === "brands" && req.method === "GET") {
      const state = brandState(segments[2]);
      if (!state) return jsonError(res, "Brand not found", 404);
      return json(res, state);
    }

    // POST /api/brands/:name/upload-dna
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "upload-dna" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const dir = brandDir(segments[2]);
      if (!existsSync(dir)) return jsonError(res, "Brand not found", 404);
      writeFileSync(join(dir, "brand-dna.md"), body.content || "", "utf-8");
      return json(res, { ok: true });
    }

    // POST /api/brands/:name/upload-image
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "upload-image" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const dir = brandDir(segments[2]);
      if (!existsSync(dir)) return jsonError(res, "Brand not found", 404);
      const type = body.type || "product"; // "product" or "brand"
      const targetDir = join(dir, type === "brand" ? "brand-images" : "product-images");
      mkdirSync(targetDir, { recursive: true });
      const filename = body.filename;
      if (!filename) return jsonError(res, "filename required");
      const buffer = base64ToBuffer(body.data);
      writeFileSync(join(targetDir, filename), buffer);
      return json(res, { ok: true, filename });
    }

    // DELETE /api/brands/:name/upload-image
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "upload-image" && req.method === "DELETE") {
      const body = JSON.parse(await readBody(req));
      const dir = brandDir(segments[2]);
      if (!existsSync(dir)) return jsonError(res, "Brand not found", 404);
      const type = body.type || "product";
      const targetDir = join(dir, type === "brand" ? "brand-images" : "product-images");
      const filepath = join(targetDir, body.filename);
      if (existsSync(filepath)) unlinkSync(filepath);
      return json(res, { ok: true });
    }

    // GET /api/brands/:name/prompts
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "prompts" && req.method === "GET") {
      const promptsFile = join(brandDir(segments[2]), "prompts.json");
      if (!existsSync(promptsFile)) {
        // Return empty template shell
        return json(res, { brand: segments[2], product: "", generated_at: new Date().toISOString(), prompts: [] });
      }
      const data = JSON.parse(readFileSync(promptsFile, "utf-8"));
      return json(res, data);
    }

    // PUT /api/brands/:name/prompts
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "prompts" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const dir = brandDir(segments[2]);
      if (!existsSync(dir)) return jsonError(res, "Brand not found", 404);
      const promptsFile = join(dir, "prompts.json");
      const existing = existsSync(promptsFile) ? JSON.parse(readFileSync(promptsFile, "utf-8")) : { brand: segments[2], product: "", generated_at: new Date().toISOString(), prompts: [] };
      existing.prompts = body.prompts || [];
      existing.generated_at = new Date().toISOString();
      writeFileSync(promptsFile, JSON.stringify(existing, null, 2), "utf-8");
      return json(res, { ok: true });
    }

    // GET /api/brands/:name/outputs
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "outputs" && req.method === "GET") {
      const state = brandState(segments[2]);
      if (!state) return jsonError(res, "Brand not found", 404);
      return json(res, state.outputs);
    }

    // GET /api/brands/:name/outputs/:version
    if (segments.length === 5 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "outputs" && req.method === "GET") {
      const versionDir = join(BRANDS_DIR, segments[2], "outputs", segments[4]);
      if (!existsSync(versionDir)) return jsonError(res, "Version not found", 404);
      const groups = scanOutputVersion(versionDir);
      const selectionsFile = join(versionDir, "selections.json");
      const selections = existsSync(selectionsFile) ? JSON.parse(readFileSync(selectionsFile, "utf-8")) : null;
      return json(res, { version: segments[4], groups, selections });
    }

    // PUT /api/brands/:name/outputs/:version/selections
    if (segments.length === 6 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "outputs" && segments[5] === "selections" && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const versionDir = join(BRANDS_DIR, segments[2], "outputs", segments[4]);
      if (!existsSync(versionDir)) return jsonError(res, "Version not found", 404);
      writeFileSync(join(versionDir, "selections.json"), JSON.stringify(body, null, 2), "utf-8");
      return json(res, { ok: true });
    }

    // POST /api/brands/:name/generate (SSE)
    if (segments.length === 4 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "generate" && req.method === "POST") {
      const body = JSON.parse(await readBody(req));
      const dir = brandDir(segments[2]);
      if (!existsSync(dir)) return jsonError(res, "Brand not found", 404);

      const promptsFile = join(dir, "prompts.json");
      if (!existsSync(promptsFile)) return jsonError(res, "prompts.json not found. Create prompts first.");

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      streamGeneration(req, res, segments[2], body);
      return;
    }

    // POST /api/brands/:name/outputs/:version/copy
    if (segments.length === 6 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "outputs" && segments[5] === "copy" && req.method === "POST") {
      const brandDirPath = brandDir(segments[2]);
      const versionDir = join(brandDirPath, "outputs", segments[4]);
      if (!existsSync(versionDir)) return jsonError(res, "Version not found", 404);

      const body = JSON.parse(await readBody(req));
      const result = generateAdCopy(brandDirPath, versionDir, body.hooks || {});
      if (result.error) return jsonError(res, result.error);
      return json(res, result);
    }

    // GET /api/hooks
    if (path === "/api/hooks" && req.method === "GET") {
      return json(res, parseHookBank());
    }

    // Serve output files
    // GET /api/brands/:name/outputs/:version/files/...
    if (segments.length >= 7 && segments[0] === "api" && segments[1] === "brands" && segments[3] === "outputs" && segments[5] === "files" && req.method === "GET") {
      const filePath = join(BRANDS_DIR, segments[2], "outputs", segments[4], ...segments.slice(6));
      if (!existsSync(filePath)) return jsonError(res, "File not found", 404);
      const ext = extname(filePath).toLowerCase();
      const mime = MIME_TYPES[ext] || "application/octet-stream";
      const content = readFileSync(filePath);
      res.writeHead(200, { "Content-Type": mime });
      res.end(content);
      return;
    }

    // 404
    jsonError(res, "Not found", 404);
  } catch (err) {
    console.error("Request error:", err);
    jsonError(res, err.message, 500);
  }
}

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------

function serveStatic(req, res, path) {
  let filePath = join(PUBLIC_DIR, path === "/" ? "index.html" : path);

  if (!existsSync(filePath)) {
    // SPA fallback: serve index.html for non-file paths
    filePath = join(PUBLIC_DIR, "index.html");
  }

  const ext = extname(filePath).toLowerCase();
  const mime = MIME_TYPES[ext] || "application/octet-stream";

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "3000" },
    },
  });

  const port = parseInt(values.port, 10) || 3000;

  const server = createServer(handleRequest);
  server.listen(port, () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║  Static Ads Webapp                       ║`);
    console.log(`  ║  http://localhost:${port}                  ║`);
    console.log(`  ╚══════════════════════════════════════════╝\n`);
  });
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
