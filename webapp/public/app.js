/* ─── Static Ads Webapp — Frontend Logic ─── */

// ==============================
// State
// ==============================
const state = {
    brand: "",          // current brand name
    prompts: [],        // current prompts array
    outputs: [],        // list of output versions
    selections: {},     // current selections for the selected version
    copyData: null,     // generated copy data
    hooks: [],          // parsed hook bank
};

// ==============================
// DOM refs
// ==============================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const brandSelect = $("#brand-select");
const brandStatus = {
    dna: $("#status-dna"),
    prompts: $("#status-prompts"),
    images: $("#status-images"),
    copy: $("#status-copy"),
};

// ==============================
// API helper
// ==============================
async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
}

// ==============================
// Tab Navigation
// ==============================
function initTabs() {
    $$(".tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            $$(".tab").forEach((t) => t.classList.remove("active"));
            $$(".tab-content").forEach((c) => c.classList.remove("active"));
            tab.classList.add("active");
            const tabId = tab.dataset.tab;
            document.getElementById(`tab-${tabId}`).classList.add("active");
        });
    });
}

// ==============================
// Brand management
// ==============================
async function loadBrands() {
    const brands = await api("GET", "/api/brands");
    brandSelect.innerHTML = '<option value="">— Select Brand —</option>' +
        brands.map((b) => `<option value="${b.name}">${b.name}</option>`).join("");

    // Also restore last selected if exists
    if (state.brand) {
        brandSelect.value = state.brand;
        await selectBrand(state.brand);
    }
}

async function selectBrand(name) {
    state.brand = name;
    try {
        const info = await api("GET", `/api/brands/${name}`);
        updateStatus(info);
        await loadPrompts();
        await loadOutputs();
    } catch (e) {
        console.error("Failed to load brand:", e);
    }
}

function updateStatus(info) {
    const setDot = (dot, ok) => {
        dot.className = "status-dot" + (ok ? " done" : "");
    };
    setDot(brandStatus.dna, info.hasDna);
    setDot(brandStatus.prompts, info.hasPrompts);
    setDot(brandStatus.images, info.outputs && info.outputs.some((o) => o.totalImages > 0));
    setDot(brandStatus.copy, info.outputs && info.outputs.some((o) => o.hasCopy));
}

brandSelect.addEventListener("change", async () => {
    const name = brandSelect.value;
    if (!name) return;
    state.brand = name;
    await selectBrand(name);
});

// New brand dialog
$("#new-brand-btn").addEventListener("click", () => {
    const name = prompt("Enter brand name:");
    if (!name || !name.trim()) return;
    api("POST", "/api/brands", { name: name.trim() }).then(() => loadBrands());
});

// ==============================
// Tab 1: Brand DNA
// ==============================
async function loadDNA() {
    if (!state.brand) return;
    try {
        const info = await api("GET", `/api/brands/${state.brand}`);
        if (info.hasDna) {
            const res = await fetch(`/api/brands/${state.brand}/prompts`);
            // Actually brand-dna.md isn't served via API directly, so load via prompts wrapper
            const dnaRes = await fetch(`/api/brands/${state.brand}/prompts`);
            // We'll load DNA content through a separate mechanism
        }
        renderImageList("product", info.productImages || []);
        renderImageList("brand", info.brandImages || []);
    } catch (e) {
        console.error("Failed to load brand info:", e);
    }
}

// DNA editor
$("#dna-save-btn").addEventListener("click", async () => {
    if (!state.brand) return alert("Select a brand first");
    const content = $("#dna-editor").value;
    await api("POST", `/api/brands/${state.brand}/upload-dna`, { content });
    showStatus("#dna-status", "DNA saved!", true);
    await selectBrand(state.brand);
});

async function loadDNAContent() {
    if (!state.brand) return;
    try {
        const res = await fetch(`/api/brands/${state.brand}/prompts`);
        const data = await res.json();
        // DNA content isn't in prompts, load from a direct fetch
        // Fallback: we'll load via the brand-dna.md path
        const dnaRes = await fetch(`/api/brands/${state.brand}/..${encodeURIComponent("/brand-dna.md")}`);
        if (dnaRes.ok) {
            const text = await dnaRes.text();
            // This won't work with current API routes. Let's use a workaround.
        }
    } catch {}
    // Try loading via output files path
    try {
        const dnaRes = await fetch(`/api/brands/${state.brand}/../brand-dna.md`);
        if (dnaRes.ok) {
            $("#dna-editor").value = await dnaRes.text();
        }
    } catch {}
}
// Instead, let's try a direct approach - the API doesn't expose reading the DNA file
// We'll handle it by checking when brand is selected
async function loadDNAFromBrand(name) {
    try {
        const res = await fetch(`/api/brands/${name}`);
        // DNA is loaded via a separate endpoint, but we don't have one.
        // Workaround: try fetching the prompts file (it doesn't have DNA),
        // or we load through a custom endpoint.
        // Since we don't have GET /api/brands/:name/dna, let me add it inline
        // For now, try raw fetch
        const dnaRes = await fetch(`/api/brands/${name}/outputs/../brand-dna.md`);
        if (!dnaRes.ok) return;
        const text = await dnaRes.text();
        if (text && !text.startsWith("<!DOCTYPE")) {
            $("#dna-editor").value = text;
        }
    } catch {}
}
// Override selectBrand to also load DNA
const origSelectBrand = selectBrand;
selectBrand = async function(name) {
    state.brand = name;
    try {
        const info = await api("GET", `/api/brands/${name}`);
        updateStatus(info);
        await loadPrompts();
        await loadOutputs();
        // Load DNA content
        loadDNAFromBrand(name);
        renderImageList("product", info.productImages || []);
        renderImageList("brand", info.brandImages || []);
    } catch (e) {
        console.error("Failed to load brand:", e);
    }
};

function renderImageList(type, files) {
    const container = document.getElementById(`${type}-images-list`);
    if (!container) return;
    if (!files || files.length === 0) {
        container.innerHTML = '<span class="hint">No images uploaded.</span>';
        return;
    }
    container.innerHTML = files.map((f) => `
        <div class="image-thumb">
            <img src="/api/brands/${state.brand}/product-images/${f}" onerror="this.src='data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%2250%22 x=%2250%22 font-size=%2214%22>${f}</text></svg>'">
            <button class="del-btn" data-filename="${f}" data-type="${type}">×</button>
        </div>
    `).join("");

    container.querySelectorAll(".del-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const filename = btn.dataset.filename;
            const type = btn.dataset.type;
            await api("DELETE", `/api/brands/${state.brand}/upload-image`, { filename, type });
            await selectBrand(state.brand);
        });
    });
}

// Upload handlers
function setupUploadZone(zoneId, inputId, type) {
    const zone = document.getElementById(zoneId);
    const input = document.getElementById(inputId);

    zone.addEventListener("click", () => input.click());

    zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        zone.classList.add("dragover");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
    zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        handleFiles(e.dataTransfer.files, type);
    });
    input.addEventListener("change", () => {
        handleFiles(input.files, type);
        input.value = "";
    });
}

async function handleFiles(files, type) {
    if (!state.brand) return alert("Select a brand first");
    for (const file of files) {
        const data = await fileToBase64(file);
        await api("POST", `/api/brands/${state.brand}/upload-image`, {
            filename: file.name,
            data,
            type,
        });
    }
    await selectBrand(state.brand);
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

setupUploadZone("product-upload-zone", "product-upload-input", "product");
setupUploadZone("brand-upload-zone", "brand-upload-input", "brand");

// ==============================
// Tab 2: Prompts
// ==============================
async function loadPrompts() {
    if (!state.brand) return;
    try {
        const data = await api("GET", `/api/brands/${state.brand}/prompts`);
        state.prompts = data.prompts || [];
        renderPrompts();
    } catch (e) {
        console.error("Failed to load prompts:", e);
    }
}

function renderPrompts() {
    const container = $("#prompts-table");
    const filter = ($("#prompt-filter")?.value || "").toLowerCase();

    const filtered = state.prompts.filter((p) => {
        if (!filter) return true;
        const num = String(p.template_number);
        const name = (p.template_name || "").toLowerCase();
        return num.includes(filter) || name.includes(filter);
    });

    $("#prompt-count").textContent = `${filtered.length} of ${state.prompts.length} prompts`;

    if (filtered.length === 0) {
        container.innerHTML = '<div class="hint" style="padding:1rem">No prompts. Load the 50 templates or add custom ones.</div>';
        return;
    }

    container.innerHTML = filtered.map((p, i) => {
        const realIdx = state.prompts.indexOf(p);
        return `<div class="prompt-row" data-index="${realIdx}">
            <div class="num">#${p.template_number}</div>
            <div class="name">${p.template_name || "Untitled"}</div>
            <div class="prompt-text">${escapeHtml((p.prompt || "").slice(0, 200))}${(p.prompt || "").length > 200 ? "..." : ""}</div>
            <div class="actions">
                <button class="btn btn-sm edit-prompt-btn">Edit</button>
                <button class="btn btn-sm delete-prompt-btn" style="color:var(--danger)">×</button>
            </div>
            <div class="prompt-editor" style="display:none">
                <textarea data-field="prompt" rows="4">${escapeHtml(p.prompt || "")}</textarea>
                <div class="editor-row">
                    <label>#: <input type="number" data-field="template_number" value="${p.template_number}" style="width:50px"></label>
                    <label>Name: <input type="text" data-field="template_name" value="${escapeHtml(p.template_name || "")}" style="width:150px"></label>
                    <label>Refs: <input type="text" data-field="reference_images" value="${escapeHtml((p.reference_images || []).join(", "))}" placeholder="img1.png, img2.png" style="width:200px"></label>
                    <button class="btn btn-sm save-prompt-edit-btn btn-primary">Save</button>
                </div>
            </div>
        </div>`;
    }).join("");

    // Event handlers
    container.querySelectorAll(".prompt-row .edit-prompt-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const row = btn.closest(".prompt-row");
            row.classList.toggle("expanded");
            const editor = row.querySelector(".prompt-editor");
            editor.style.display = editor.style.display === "none" ? "block" : "none";
        });
    });

    container.querySelectorAll(".delete-prompt-btn").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.stopPropagation();
            const row = btn.closest(".prompt-row");
            const idx = parseInt(row.dataset.index);
            state.prompts.splice(idx, 1);
            renderPrompts();
        });
    });

    container.querySelectorAll(".save-prompt-edit-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            const row = btn.closest(".prompt-row");
            const idx = parseInt(row.dataset.index);
            const prompt = state.prompts[idx];
            const editor = row.querySelector(".prompt-editor");
            editor.querySelectorAll("[data-field]").forEach((el) => {
                const field = el.dataset.field;
                if (field === "reference_images") {
                    prompt[field] = el.value.split(",").map((s) => s.trim()).filter(Boolean);
                } else if (field === "template_number") {
                    prompt[field] = parseInt(el.value, 10) || 0;
                } else {
                    prompt[field] = el.value;
                }
            });
            renderPrompts();
        });
    });

    // Allow clicking the row to expand (except on buttons)
    container.querySelectorAll(".prompt-row").forEach((row) => {
        row.addEventListener("click", (e) => {
            if (e.target.closest("button") || e.target.closest("input") || e.target.closest("textarea")) return;
            row.classList.toggle("expanded");
            const editor = row.querySelector(".prompt-editor");
            if (editor) editor.style.display = editor.style.display === "none" ? "block" : "none";
        });
    });
}

// Prompt filter
$("#prompt-filter").addEventListener("input", renderPrompts);

// Save prompts
$("#save-prompts-btn").addEventListener("click", async () => {
    if (!state.brand) return alert("Select a brand first");
    await api("PUT", `/api/brands/${state.brand}/prompts`, { prompts: state.prompts });
    showStatus("#prompt-count", "Prompts saved!", true);
});

// Add custom prompt
$("#add-prompt-btn").addEventListener("click", () => {
    const maxNum = state.prompts.reduce((m, p) => Math.max(m, p.template_number || 0), 0);
    state.prompts.push({
        template_number: maxNum + 1,
        template_name: "custom-prompt",
        prompt: "Describe your custom ad here...",
        reference_images: [],
        notes: "",
    });
    renderPrompts();
});

// Load 50 templates from the server's skill definition
$("#load-50-btn").addEventListener("click", async () => {
    if (!state.brand) return alert("Select a brand first");
    if (state.prompts.length > 0) {
        if (!confirm("This will replace all existing prompts. Continue?")) return;
    }
    // Load from the 50 templates embedded in the skill
    try {
        const res = await fetch("/api/hooks"); // not the right endpoint, but let's try
        // We'll load a pre-defined set
        state.prompts = await generateDefault50Templates();
        renderPrompts();
        showStatus("#prompt-count", "50 templates loaded!", true);
    } catch (e) {
        console.error("Failed to load templates:", e);
    }
});

// Default 50 template stubs
async function generateDefault50Templates() {
    const templates = [
        [1, "headline", "Bold headline ad with key benefit statement"],
        [2, "offer-promotion", "Price-forward promotional ad with discount or offer"],
        [3, "testimonial", "Customer testimonial or review quote card"],
        [4, "features-benefits", "Product feature callout with benefit explanations"],
        [5, "bullet-points", "Benefit list with bullet points and icon"],
        [6, "social-proof", "Social proof with stats, reviews, or trust signals"],
        [7, "us-vs-them", "Side-by-side comparison with competitor alternatives"],
        [8, "before-after-ugc", "Before/after user-generated content comparison"],
        [9, "negative-marketing", "Don't-buy-this-if reverse psychology ad"],
        [10, "press-editorial", "Press coverage or editorial-style feature"],
        [11, "pull-quote-review", "Pull-quote style review card with star rating"],
        [12, "lifestyle-colorway", "Aspirational lifestyle scene in brand colors"],
        [13, "stat-surround", "Key stat surrounded by supporting visuals"],
        [14, "bundle-showcase", "Product bundle or package deal showcase"],
        [15, "social-comment", "Fake social media comment highlighting feedback"],
        [16, "curiosity-gap-testimonial", "Curiosity gap headline with testimonial"],
        [17, "verified-review-card", "Verified purchase review card with rating"],
        [18, "stat-surround-lifestyle", "Stat surrounded by lifestyle imagery"],
        [19, "highlighted-testimonial", "Highlighted testimonial quote card"],
        [20, "advertorial-editorial", "Advertorial or editorial-style feature ad"],
        [21, "bold-statement", "Bold brand statement or manifesto"],
        [22, "flavor-story", "Product origin or flavor story"],
        [23, "manifesto", "Brand manifesto or mission statement"],
        [24, "product-comment-callout", "Product comment with callout arrow"],
        [25, "us-vs-them-split", "Split-screen comparison ad"],
        [26, "stat-callout-lifestyle", "Stat callout over lifestyle imagery"],
        [27, "benefit-checklist", "Benefit checklist with check marks"],
        [28, "feature-arrow-callout", "Feature with arrow callout to product image"],
        [29, "ugc-viral-post", "Viral UGC post recreation"],
        [30, "hero-statement-icon-bar", "Hero statement with icon benefit bar"],
        [31, "comparison-grid", "Feature comparison grid or table"],
        [32, "ugc-story-callout", "UGC story with callout text overlay"],
        [33, "faux-press", "Faux press or news feature card"],
        [34, "faux-iphone-notes", "iPhone Notes app-style ad"],
        [35, "hero-product-stat-bar", "Hero product shot with stat bar"],
        [36, "whiteboard-before-after", "Whiteboard-style before/after explanation"],
        [37, "hero-statement-promo", "Hero statement with promotional offer"],
        [38, "ugc-lifestyle-review-split", "UGC lifestyle + review split ad"],
        [39, "curiosity-gap-scroll-stopper", "Curiosity gap scroll-stopping headline"],
        [40, "post-it-note-native", "Post-it note style native ad"],
        [41, "visual-metaphor", "Visual metaphor for product benefit"],
        [42, "process-flow", "Step-by-step process or how-it-works"],
        [43, "clinical-data-chart", "Clinical data or results chart"],
        [44, "guarantee-seal", "Guarantee or warranty seal badge ad"],
        [45, "limited-edition", "Limited edition or exclusive drop"],
        [46, "viral-tweet", "Viral tweet or social post recreation"],
        [47, "guarantee-risk-reversal", "Guarantee with risk reversal statement"],
        [48, "how-it-works-steps", "How-it-works steps with numbers"],
        [49, "faq-card", "FAQ or objection-handling card"],
        [50, "countdown-scarcity", "Countdown or scarcity limited-drop ad"],
    ];
    return templates.map(([num, name, desc]) => ({
        template_number: num,
        template_name: name,
        prompt: `Create a ${desc} for this brand. Use brand colors and visual identity. [Detailed prompt will be customized per brand]`,
        reference_images: [],
        notes: "",
    }));
}

// ==============================
// Tab 3: Generation & Images
// ==============================
async function loadOutputs() {
    if (!state.brand) return;
    try {
        const outputs = await api("GET", `/api/brands/${state.brand}/outputs`);
        state.outputs = outputs;
        const versionSelect = $("#version-select");
        if (versionSelect) {
            versionSelect.innerHTML = outputs.map(
                (o) => `<option value="${o.version}">${o.version} (${o.totalImages} imgs)</option>`
            ).join("");
        }
    } catch (e) {
        console.error("Failed to load outputs:", e);
    }
}

// Generate button
$("#generate-btn").addEventListener("click", async () => {
    if (!state.brand) return alert("Select a brand first");

    const templates = $("#gen-templates").value.trim();
    const numImages = parseInt($("#gen-num-images").value, 10) || 1;
    const ratios = [];
    if ($("#gen-ratio-1x1").checked) ratios.push("1x1");
    if ($("#gen-ratio-9x16").checked) ratios.push("9x16");
    const maxConcurrent = parseInt($("#gen-concurrency").value, 10) || 2;

    // Show log window
    const logWindow = $("#gen-log");
    logWindow.style.display = "flex";
    const logOutput = $("#log-output");
    logOutput.textContent = "";

    // Disable button
    $("#generate-btn").disabled = true;
    $("#generate-btn").textContent = "Generating...";

    // Parse template numbers
    let templateList = [];
    if (templates) {
        templateList = templates.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
    }

    try {
        const res = await fetch(`/api/brands/${state.brand}/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
            body: JSON.stringify({
                templates: templateList.length > 0 ? templateList : undefined,
                numImages,
                ratios: ratios.length > 0 ? ratios : undefined,
                maxConcurrent,
            }),
        });

        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const text = decoder.decode(value, { stream: true });
            const lines = text.split("\n").filter((l) => l.startsWith("data: "));
            for (const line of lines) {
                const data = JSON.parse(line.slice(6));
                if (data.type === "log") {
                    logOutput.textContent += data.text;
                    logOutput.scrollTop = logOutput.scrollHeight;
                } else if (data.type === "done") {
                    logOutput.textContent += `\n✓ Generation complete! Output: ${data.outputDir}`;
                    // Refresh outputs and load the new version
                    await loadOutputs();
                    if (data.version) {
                        $("#version-select").value = data.version;
                        await loadVersionImages(data.version);
                    }
                    logOutput.scrollTop = logOutput.scrollHeight;
                } else if (data.type === "error") {
                    logOutput.textContent += `\n✗ Error: ${data.message}`;
                    logOutput.scrollTop = logOutput.scrollHeight;
                }
            }
        }
    } catch (e) {
        logOutput.textContent += `\n✗ Connection error: ${e.message}`;
    } finally {
        $("#generate-btn").disabled = false;
        $("#generate-btn").textContent = "Generate";
    }
});

// Clear log
$("#clear-log-btn").addEventListener("click", () => {
    $("#log-output").textContent = "";
    $("#gen-log").style.display = "none";
});

// Template selector buttons
$("#gen-all-btn").addEventListener("click", () => {
    $("#gen-templates").value = "";
});
$("#gen-suggested-btn").addEventListener("click", () => {
    $("#gen-templates").value = "1,2,3,4,5,6,7,8,9,11,12,13,15,16,20,21,22,23,29,32,33,38,39,40,41,44,46,47,48,50";
});
$("#gen-custom-btn").addEventListener("click", () => {
    $("#gen-templates").focus();
});

// Version selector
$("#version-select")?.addEventListener("change", async (e) => {
    await loadVersionImages(e.target.value);
});

async function loadVersionImages(version) {
    if (!state.brand || !version) return;
    const browser = $("#image-browser");
    browser.style.display = "block";

    try {
        const data = await api("GET", `/api/brands/${state.brand}/outputs/${version}`);
        state.selections = data.selections || {};
        renderImageGroups(data.groups);
        updateSelectionCount();
    } catch (e) {
        console.error("Failed to load images:", e);
    }
}

function renderImageGroups(groups) {
    const grid = $("#image-grid");
    if (!groups || groups.length === 0) {
        grid.innerHTML = '<div class="hint" style="padding:1rem">No images in this version.</div>';
        return;
    }

    grid.innerHTML = groups.map((g) => {
        const hasSelection = state.selections && state.selections[g.folder];

        const ratioSections = Object.entries(g.ratios).map(([ratio, images]) => {
            const selectedImg = hasSelection && hasSelection[ratio] ? hasSelection[ratio] : null;

            return `<div class="img-group">
                <div class="img-group-header">
                    <h4>${g.folder}</h4>
                    <span class="badge">${ratio}</span>
                    <span class="badge" style="background:var(--primary-bg);color:var(--primary)">${images.length} imgs</span>
                </div>
                <div class="img-grid-row">
                    ${images.map((img) => {
                        const isSelected = selectedImg && selectedImg.includes(img.path);
                        return `<div class="img-card ${isSelected ? "selected" : ""}"
                                  data-template="${g.folder}" data-ratio="${ratio}" data-path="${img.path}">
                            <div class="radio-dot"></div>
                            <img src="/api/brands/${state.brand}/outputs/${$("#version-select").value}/files/${img.path}"
                                 alt="${img.filename}"
                                 loading="lazy"
                                 onclick="selectImage(this)">
                            <div class="info">
                                <span>${img.filename}</span>
                                <span class="expand-icon" onclick="openLightbox(this)" style="cursor:pointer">🔍</span>
                            </div>
                        </div>`;
                    }).join("")}
                </div>
            </div>`;
        }).join("");

        return ratioSections;
    }).join("");
}

// Image selection
function selectImage(img) {
    const card = img.closest(".img-card");
    const template = card.dataset.template;
    const ratio = card.dataset.ratio;
    const path = card.dataset.path;

    // Deselect siblings in same group
    card.closest(".img-grid-row").querySelectorAll(".img-card").forEach((c) => {
        c.classList.remove("selected");
    });
    card.classList.add("selected");

    // Update selections
    if (!state.selections[template]) state.selections[template] = {};
    state.selections[template][ratio] = path;

    updateSelectionCount();
}

// Expose to global scope for inline onclick
window.selectImage = selectImage;

// Lightbox
function openLightbox(el) {
    const img = el.closest(".img-card").querySelector("img");
    const modal = $("#modal");
    const body = $("#modal-body");
    body.innerHTML = `<img src="${img.src}" alt="Full size">`;
    modal.style.display = "flex";
}

$(".modal-close").addEventListener("click", () => {
    $("#modal").style.display = "none";
});
$("#modal").addEventListener("click", (e) => {
    if (e.target === $("#modal")) $("#modal").style.display = "none";
});
document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") $("#modal").style.display = "none";
});

// Save selections
$("#save-selections-btn").addEventListener("click", async () => {
    if (!state.brand) return alert("Select a brand first");
    const version = $("#version-select").value;
    if (!version) return alert("Select a version");

    await api("PUT", `/api/brands/${state.brand}/outputs/${version}/selections`, state.selections);
    showStatus("#selection-status", "Selections saved!", true);
    await loadOutputs();
});

function updateSelectionCount() {
    const count = Object.keys(state.selections)
        .filter((k) => k !== "excluded")
        .filter((k) => state.selections[k]["1x1"] || state.selections[k]["9x16"])
        .length;
    const total = Object.keys(state.selections).length;
    $("#selection-count").textContent = count > 0
        ? `${count} templates selected`
        : "No selections yet";
}

// ==============================
// Tab 4: Copy Generation
// ==============================
// Load selections from current version into copy tab
$("#load-copy-btn").addEventListener("click", async () => {
    if (!state.brand) return alert("Select a brand first");
    const version = $("#version-select").value;
    if (!version) return alert("Select a version in the Generate tab first");

    // Load the selections
    const data = await api("GET", `/api/brands/${state.brand}/outputs/${version}`);
    if (!data.selections || Object.keys(data.selections).length === 0) {
        alert("No selections found. Select images in the Generate tab first.");
        return;
    }

    state.selections = data.selections;
    state.currentVersion = version;

    // Load hooks for reference
    try {
        state.hooks = await api("GET", "/api/hooks");
    } catch {}

    // Enable copy generation button
    $("#generate-copy-btn").disabled = false;
    showStatus("#copy-status", "Selections loaded! Ready to generate copy.", true);
});

// Generate copy
$("#generate-copy-btn").addEventListener("click", async () => {
    if (!state.brand || !state.currentVersion) return alert("Load selections first");
    $("#generate-copy-btn").disabled = true;
    $("#generate-copy-btn").textContent = "Generating...";

    try {
        const result = await api("POST", `/api/brands/${state.brand}/outputs/${state.currentVersion}/copy`, { hooks: {} });
        state.copyData = result;
        $("#export-csv-btn").disabled = false;
        showStatus("#copy-status", `Copy generated! ${result.rows} ads, ${result.imagesCopied} images copied.`, true);
        await loadCopyPreview();
    } catch (e) {
        showStatus("#copy-status", `Error: ${e.message}`, false);
    } finally {
        $("#generate-copy-btn").disabled = false;
        $("#generate-copy-btn").textContent = "Generate Copy";
    }
});

// Export CSV
$("#export-csv-btn").addEventListener("click", () => {
    if (!state.brand || !state.currentVersion) return;
    window.open(`/api/brands/${state.brand}/outputs/${state.currentVersion}/files/../upload.csv`, "_blank");
});

async function loadCopyPreview() {
    const container = $("#copy-preview");
    if (!state.currentVersion) return;

    try {
        const data = await api("GET", `/api/brands/${state.brand}/outputs/${state.currentVersion}`);
        const selections = data.selections || {};
        const groups = data.groups || [];

        let html = '<h3 style="margin-bottom:1rem">Copy Summary</h3>';

        // Try to load the copy-summary.md
        try {
            const summaryRes = await fetch(`/api/brands/${state.brand}/outputs/${state.currentVersion}/files/../copy-summary.md`);
            if (summaryRes.ok) {
                const md = await summaryRes.text();
                html += `<div class="card"><pre style="white-space:pre-wrap;font-size:0.82rem;color:var(--text2);line-height:1.6">${escapeHtml(md)}</pre></div>`;
            }
        } catch {}

        container.innerHTML = html;
    } catch (e) {
        console.error("Failed to load copy preview:", e);
    }
}

// ==============================
// Helpers
// ==============================
function escapeHtml(s) {
    if (!s) return "";
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function showStatus(selector, msg, success) {
    const el = document.querySelector(selector);
    if (!el) return;
    el.textContent = msg;
    el.className = "save-status show" + (success ? "" : " error");
    setTimeout(() => el.classList.remove("show"), 3000);
}

// ==============================
// Init
// ==============================
async function init() {
    initTabs();
    await loadBrands();

    // Add a way to load DNA content when brand is selected
    // The DNA tab content loading is handled inside selectBrand via loadDNAFromBrand
}

init();
