# Static Ads Webapp — Architecture

A local webapp (`webapp/`) that provides a browser UI for the 4-phase ad pipeline. Built with zero dependencies (Node built-in `http` module + vanilla HTML/CSS/JS).

---

## 1. What It Does

One screen that lets you walk through all 4 pipeline phases with clicks instead of CLI commands:

1. **Brand DNA** — upload `brand-dna.md` + product/brand images (research stays in Claude Code)
2. **Prompts** — review, edit, add custom prompts; load the 50 template library
3. **Generate** — configure templates/ratios/count, run generation with live SSE log stream, browse & select images
4. **Copy & Export** — load selections, generate ad copy (TOF/MOF/BOF), export CSV + XLSX

---

## 2. Architecture

```
webapp/
├── server.mjs          # Node HTTP server — API routes + static files + SSE streaming
├── package.json        # "type": "module"
├── public/
│   ├── index.html      # SPA shell (4-tab layout)
│   ├── app.css         # Dark theme styles
│   └── app.js          # All frontend logic (fetch API, SSE, DOM)
```

### Backend (`server.mjs`)

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Serves `public/index.html` |
| `/api/brands` | GET | List all brands with state |
| `/api/brands` | POST | Create a new brand |
| `/api/brands/:name` | GET | Brand state (hasDna, hasPrompts, outputs, images) |
| `/api/brands/:name/upload-dna` | POST | Save brand-dna.md |
| `/api/brands/:name/upload-image` | POST | Upload product/brand image (base64 JSON) |
| `/api/brands/:name/upload-image` | DELETE | Delete uploaded image |
| `/api/brands/:name/prompts` | GET | Read prompts.json |
| `/api/brands/:name/prompts` | PUT | Save prompts.json |
| `/api/brands/:name/generate` | POST | Spawn `generate_ads_gemini.mjs`, stream logs via SSE |
| `/api/brands/:name/outputs` | GET | List output versions |
| `/api/brands/:name/outputs/:ver` | GET | Image manifest (templates + ratios + files) |
| `/api/brands/:name/outputs/:ver/selections` | PUT | Save selections.json |
| `/api/brands/:name/outputs/:ver/copy` | POST | Generate CSV + XLSX + Ad-uploads |
| `/api/brands/:name/outputs/:ver/files/*` | GET | Serve output images |
| `/api/hooks` | GET | Parse hook-bank.md |

### Frontend (vanilla JS SPA)

- **Tab bar**: 4 phases as top tabs
- **State**: single `state` object tracking brand, prompts, selections, outputs
- **SSE**: uses `ReadableStream` from `fetch()` response body to stream generation logs
- **Image browser**: cards with radio-dot selection, lightbox, version switcher

---

## 3. Data Flow

```
Phase 1 (manual/brand-dna.md + images) ──→ Phase 2 (prompts editor) ──→ Phase 3 (generate)
     ↑                                       ↑                              │
     │                                       │                              ↓
  User pastes DNA                        User edits prompts          Image gen via SSE
                                                                           │
                                                                           ↓
                                                              Image browser + selection
                                                                           │
                                                                           ↓
                                                                   Phase 4 (copy gen)
                                                                           │
                                                                           ↓
                                                                   upload.csv + xlsx
```

---

## 4. Key Design Decisions

| Decision | Choice |
|---|---|
| Dependencies | Zero — Node built-in `http`, vanilla JS/HTML/CSS |
| Phase 1 automation | Manual upload — research stays in Claude Code |
| Phase 3 integration | Spawns `generate_ads_gemini.mjs` as child process, streams stdout via SSE |
| Image serving | API routes serve files from `brands/*/outputs/*/` |
| File uploads | Base64 JSON POST (avoids multipart parsing dependency) |
| Gallery | Integrated into webapp — no standalone `gallery.html` |
| XLSX | Uses `exceljs` from parent project if available (optional) |

---

## 5. Running the Webapp

```bash
# From project root
node webapp/server.mjs

# Custom port
node webapp/server.mjs --port 3000
```

Then open http://localhost:3000 in a browser.

---

## 6. Data Contracts

Stable file formats the webapp reads/writes:

| File | Format | Producer |
|---|---|---|
| `brand-dna.md` | Section-based markdown | Phase 1 (manual/agent) |
| `prompts.json` | `{ brand, product, prompts: [{ template_number, template_name, prompt, reference_images[], notes }] }` | Phase 2 (editor) |
| `outputs/{date}-V{n}/` | Directory per run | Phase 3 (generation script) |
| `selections.json` | `{ template: { ratio: path }, excluded: [] }` | Phase 3 (image browser) |
| `upload.csv` | Ads Uploader CSV | Phase 4 (copy gen) |
| `upload-2.xlsx` | Excel version of CSV | Phase 4 (copy gen) |
| `copy-summary.md` | Human-readable copy summary | Phase 4 (copy gen) |
| `Ad-uploads/` | Cleaned image files | Phase 4 (copy gen) |

---

## 7. Future Growth

- **Smarter Phase 2**: fill prompt templates from brand-dna.md automatically
- **Template library endpoint**: server serves the 50 templates from SKILL.md
- **Re-generation**: "regenerate this template" button per image group
- **Brand index page**: dashboard showing all brands with status indicators
- **Export ad-library.html**: spawn `ad-library.mjs` after copy generation
- **`run.json` manifest**: auto-generated metadata per output version for cleaner version switching
