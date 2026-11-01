import { app } from "/scripts/app.js";

const MODAL_ID = "image-picker-modal";
const STYLE_ID = "image-picker-style";

let modalState = {
    node: null,
    tab: "output",
    images: { input: [], output: [] },
    selected: new Set(),
    selectedItems: [],
    pathsWidget: null,
};

const nodeThumbnails = new Map();
const imageCache = new Map();
let dropTargetNode = null;
let gridObserver = null;

let dragState = {
    active: false,
    index: -1,
    startX: 0,
    startY: 0,
    currentX: 0,
    currentY: 0,
    moved: false,
};

// Layout constants
const GAP = 6;
const THUMBS_PER_ROW = 3;
const HEADER_H = 30;
const BUTTON_H = 28;
const BUTTON_W = 120;
const SLOT_H = 22;
const NUM_OUTPUTS = 9;
const MIN_THUMB = 50;
const MARGIN = 8;
const PORT_AREA_W = 52;
const THUMB_RADIUS = 6;

function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
}

// 缩略图统一走后端 /image_picker/thumb：服务端按最长边缩到 512px 并落盘缓存。
// v 带源文件 mtime，源图一变 URL 就变，配合服务端的长缓存头不会拿到旧图。
// 节点画布与弹窗共用同一个 URL，也就共用同一份浏览器缓存。
function getThumbUrl(img) {
    return `/image_picker/thumb?path=${encodeURIComponent(img.path)}&size=512&v=${encodeURIComponent(img.mtime || 0)}`;
}

async function uploadDroppedImage(file) {
    const formData = new FormData();
    formData.append("image", file);
    formData.append("type", "input");
    formData.append("overwrite", "true");

    const resp = await fetch("/upload/image", { method: "POST", body: formData });
    if (!resp.ok) throw new Error(`Upload failed: ${resp.status}`);
    const data = await resp.json();

    const filesResp = await fetch("/image_picker/files?type=input");
    const filesData = await filesResp.json();
    const uploaded = filesData.images.find(f => f.filename === data.name && (f.subfolder || "") === (data.subfolder || ""));

    return {
        filename: data.name,
        subfolder: data.subfolder || "",
        path: uploaded ? uploaded.path : `${data.subfolder ? data.subfolder + "/" : ""}${data.name}`,
        // mtime 参与缩略图 URL，拿不到时用 0（该文件不会覆盖同名旧文件）
        mtime: uploaded ? uploaded.mtime || 0 : 0,
        type: "input",
    };
}

function getCachedImage(img) {
    const url = getThumbUrl(img);
    if (!imageCache.has(url)) {
        const image = new Image();
        image.src = url;
        imageCache.set(url, image);
    }
    return imageCache.get(url);
}

function getItems(node) {
    return nodeThumbnails.get(node.id) || [];
}

function getContentWidth(node) {
    return node.size[0] - PORT_AREA_W;
}

function getThumbSize(nodeWidth) {
    const contentW = nodeWidth - PORT_AREA_W;
    const available = contentW - MARGIN * 2 - GAP * (THUMBS_PER_ROW - 1);
    return Math.max(available / THUMBS_PER_ROW, MIN_THUMB);
}

function getGridWidth(node) {
    const thumbSize = getThumbSize(node.size[0]);
    return thumbSize * THUMBS_PER_ROW + GAP * (THUMBS_PER_ROW - 1);
}

function getGridStartX(node) {
    const contentW = getContentWidth(node);
    const gridW = getGridWidth(node);
    return (contentW - gridW) / 2;
}

function getContentStartY() {
    return HEADER_H + MARGIN;
}

function getRows(items) {
    return Math.ceil(Math.max(items.length, 1) / THUMBS_PER_ROW);
}

function getThumbsHeight(node) {
    const items = getItems(node);
    if (!items.length) return 0;
    const thumbSize = getThumbSize(node.size[0]);
    const rows = getRows(items);
    return rows * thumbSize + (rows - 1) * GAP;
}

function getButtonRect(node) {
    const contentW = getContentWidth(node);
    const w = Math.min(BUTTON_W, contentW - MARGIN * 2);
    const x = (contentW - w) / 2;
    const y = node.size[1] - MARGIN - BUTTON_H;
    return { x, y, w, h: BUTTON_H };
}

function getThumbRect(node, index) {
    const items = getItems(node);
    if (!items.length) return null;

    const thumbSize = getThumbSize(node.size[0]);
    const col = index % THUMBS_PER_ROW;
    const row = Math.floor(index / THUMBS_PER_ROW);
    const startX = getGridStartX(node);
    const startY = getContentStartY();

    const x = startX + col * (thumbSize + GAP);
    const y = startY + row * (thumbSize + GAP);

    return { x, y, w: thumbSize, h: thumbSize };
}

function getDeleteButtonRect(node, index) {
    const rect = getThumbRect(node, index);
    if (!rect) return null;
    const btnSize = Math.max(14, Math.min(20, rect.w * 0.2));
    return {
        x: rect.x + rect.w - btnSize - 4,
        y: rect.y + 4,
        w: btnSize,
        h: btnSize,
    };
}

function hitTestThumb(node, localX, localY) {
    const items = getItems(node);
    for (let i = 0; i < items.length; i++) {
        const rect = getThumbRect(node, i);
        if (!rect) continue;
        if (localX >= rect.x && localX <= rect.x + rect.w &&
            localY >= rect.y && localY <= rect.y + rect.h) {
            return i;
        }
    }
    return -1;
}

function hitTestDelete(node, localX, localY) {
    const items = getItems(node);
    for (let i = 0; i < items.length; i++) {
        const btn = getDeleteButtonRect(node, i);
        if (!btn) continue;
        if (localX >= btn.x && localX <= btn.x + btn.w &&
            localY >= btn.y && localY <= btn.y + btn.h) {
            return i;
        }
    }
    return -1;
}

function hitTestButton(node, localX, localY) {
    const btn = getButtonRect(node);
    return localX >= btn.x && localX <= btn.x + btn.w &&
           localY >= btn.y && localY <= btn.y + btn.h;
}

function calcNodeHeight(node) {
    const items = getItems(node);
    const portsH = NUM_OUTPUTS * SLOT_H + HEADER_H;

    const thumbsH = getThumbsHeight(node);
    const contentH = HEADER_H + MARGIN + thumbsH + (thumbsH > 0 ? MARGIN : 0) + BUTTON_H + MARGIN;

    return Math.max(portsH, contentH);
}

function resizeNode(node) {
    const h = calcNodeHeight(node);
    if (Math.abs(node.size[1] - h) > 1) {
        node.size[1] = h;
    }
}

function truncateText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        if (ctx.measureText(text.substring(0, mid) + "..").width <= maxWidth) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    return text.substring(0, lo) + "..";
}

function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
#${MODAL_ID} {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    z-index: 99999;
    background: rgba(0,0,0,0.6);
    font-family: 'Segoe UI', system-ui, sans-serif;
    color: #e0e0e0;
}
#${MODAL_ID} .mil-modal {
    position: absolute;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    width: 1120px;
    max-width: 94vw;
    max-height: 90vh;
    background: #2a2a2e;
    border-radius: 12px;
    box-shadow: 0 8px 40px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
#${MODAL_ID} .mil-header { padding: 16px 20px 0; font-size: 16px; font-weight: 600; color: #fff; }
#${MODAL_ID} .mil-tabs { display: flex; padding: 12px 20px 0; border-bottom: 1px solid #3a3a3e; }
#${MODAL_ID} .mil-tab {
    padding: 8px 24px; cursor: pointer;
    border-bottom: 2px solid transparent;
    color: #999; font-size: 14px; transition: all 0.2s; user-select: none;
}
#${MODAL_ID} .mil-tab:hover { color: #ccc; }
#${MODAL_ID} .mil-tab.active { color: #fff; border-bottom-color: #6b9fff; }
#${MODAL_ID} .mil-body { flex: 1; overflow-y: auto; padding: 16px 20px; min-height: 200px; }
#${MODAL_ID} .mil-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
}
#${MODAL_ID} .mil-item {
    position: relative; border-radius: 8px; overflow: hidden; cursor: pointer;
    border: 3px solid transparent; transition: border-color 0.2s; background: #1a1a1e;
    aspect-ratio: 1 / 1;
}
#${MODAL_ID} .mil-item:hover { border-color: #555; }
#${MODAL_ID} .mil-item.selected { border-color: #6b9fff; }
#${MODAL_ID} .mil-item img {
    width: 100%; height: 100%; object-fit: contain; display: block;
    opacity: 0; transition: opacity 0.15s;
}
#${MODAL_ID} .mil-item img.loaded { opacity: 1; }
#${MODAL_ID} .mil-item .mil-check {
    position: absolute; top: 6px; right: 6px; width: 22px; height: 22px;
    border-radius: 50%; background: rgba(0,0,0,0.5);
    display: flex; align-items: center; justify-content: center;
    font-size: 12px; color: #fff; border: 2px solid rgba(255,255,255,0.3);
}
#${MODAL_ID} .mil-item.selected .mil-check { background: #6b9fff; border-color: #6b9fff; }
#${MODAL_ID} .mil-item .mil-name {
    position: absolute; bottom: 0; left: 0; right: 0;
    padding: 4px 6px; font-size: 11px; background: rgba(0,0,0,0.6);
    color: #ccc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
#${MODAL_ID} .mil-empty { text-align: center; padding: 40px 20px; color: #666; font-size: 14px; }
#${MODAL_ID} .mil-actions {
    padding: 12px 20px; border-top: 1px solid #3a3a3e;
    display: flex; justify-content: space-between; align-items: center;
}
#${MODAL_ID} .mil-actions .mil-count { font-size: 13px; color: #999; }
#${MODAL_ID} .mil-actions .mil-count strong { color: #fff; }
#${MODAL_ID} .mil-btn {
    padding: 8px 24px; border: none; border-radius: 6px;
    cursor: pointer; font-size: 14px; font-weight: 500; transition: background 0.2s;
}
#${MODAL_ID} .mil-btn-primary { background: #6b9fff; color: #fff; }
#${MODAL_ID} .mil-btn-primary:hover { background: #5a8ef0; }
#${MODAL_ID} .mil-btn-primary:disabled { background: #444; color: #777; cursor: default; }
#${MODAL_ID} .mil-btn-secondary { background: #3a3a3e; color: #ccc; margin-right: 8px; }
#${MODAL_ID} .mil-btn-secondary:hover { background: #4a4a4e; }
#${MODAL_ID} .mil-btn-danger { background: #5a2828; color: #e07070; margin-right: auto; }
#${MODAL_ID} .mil-btn-danger:hover { background: #7a3838; }
#${MODAL_ID} .mil-btn-danger:disabled { background: #333; color: #555; cursor: default; }
#${MODAL_ID} .mil-confirm-overlay {
    position: absolute; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.7); z-index: 10;
    display: flex; align-items: center; justify-content: center;
}
#${MODAL_ID} .mil-confirm-dialog {
    background: #2a2a2e; border-radius: 12px; padding: 24px 32px;
    max-width: 400px; text-align: center;
    box-shadow: 0 8px 40px rgba(0,0,0,0.6);
}
#${MODAL_ID} .mil-confirm-dialog h3 { margin: 0 0 8px; font-size: 16px; color: #fff; }
#${MODAL_ID} .mil-confirm-dialog p { margin: 0 0 20px; font-size: 14px; color: #aaa; }
#${MODAL_ID} .mil-confirm-dialog .mil-confirm-files {
    margin: 0 0 16px; padding: 8px 12px; background: #1a1a1e; border-radius: 6px;
    font-size: 12px; color: #888; max-height: 100px; overflow-y: auto; text-align: left;
}
#${MODAL_ID} .mil-confirm-dialog .mil-confirm-actions {
    display: flex; gap: 12px; justify-content: center;
}
#${MODAL_ID} .mil-confirm-dialog .mil-btn-danger-solid {
    background: #c0392b; color: #fff;
}
#${MODAL_ID} .mil-confirm-dialog .mil-btn-danger-solid:hover { background: #a93226; }
`;
    document.head.appendChild(style);
}

function createModal() {
    if (document.getElementById(MODAL_ID)) return;

    const div = document.createElement("div");
    div.id = MODAL_ID;
    div.innerHTML = `
<div class="mil-modal">
    <div class="mil-header">Select Images</div>
    <div class="mil-tabs">
        <div class="mil-tab active" data-tab="output">Output</div>
        <div class="mil-tab" data-tab="input">Input</div>
    </div>
    <div class="mil-body" id="mil-body"></div>
    <div class="mil-actions">
        <span class="mil-count">Selected: <strong id="mil-count-num">0</strong> / 9</span>
        <div>
            <button class="mil-btn mil-btn-danger" id="mil-delete-btn" disabled>Delete Selected</button>
            <button class="mil-btn mil-btn-secondary" id="mil-cancel-btn">Cancel</button>
            <button class="mil-btn mil-btn-primary" id="mil-confirm-btn" disabled>Load Selected</button>
        </div>
    </div>
</div>`;

    document.body.appendChild(div);

    div.querySelectorAll(".mil-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            div.querySelectorAll(".mil-tab").forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            modalState.tab = tab.dataset.tab;
            renderGrid();
        });
    });

    document.getElementById("mil-cancel-btn").addEventListener("click", hideModal);
    document.getElementById("mil-confirm-btn").addEventListener("click", confirmSelection);
    document.getElementById("mil-delete-btn").addEventListener("click", deleteSelected);
    div.addEventListener("click", (e) => {
        if (e.target === div) hideModal();
    });
}

function showModal(node) {
    modalState.node = node;
    modalState.selected = new Set();
    modalState.selectedItems = [];
    modalState.pathsWidget = node.widgets.find(w => w.name === "image_paths");

    document.getElementById(MODAL_ID).style.display = "block";

    loadImages("input");
    loadImages("output");
    renderGrid();
}

function hideModal() {
    document.getElementById(MODAL_ID).style.display = "none";
    modalState.node = null;
}

function sortByNewest(images) {
    return images.slice().sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
}

async function loadImages(type) {
    try {
        const resp = await fetch(`/image_picker/files?type=${type}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        modalState.images[type] = sortByNewest(data.images || []);
        if (modalState.tab === type) renderGrid();
    } catch (err) {
        console.error(`[ImagePicker] Failed to load ${type} images:`, err);
        modalState.images[type] = [];
        if (modalState.tab === type) renderGrid();
    }
}

function toggleSelect(itemEl) {
    const key = itemEl.dataset.key;
    if (modalState.selected.has(key)) {
        modalState.selected.delete(key);
        modalState.selectedItems = modalState.selectedItems.filter(i => i.path !== key);
        itemEl.classList.remove("selected");
    } else if (modalState.selected.size < 9) {
        modalState.selected.add(key);
        const imgData = (modalState.images[modalState.tab] || []).find(i => i.path === key);
        if (imgData) modalState.selectedItems.push(imgData);
        itemEl.classList.add("selected");
    }
    updateCount();
}

// 懒加载：只有当缩略图滚到视口附近时才赋 src，避免一次性发起成百上千个请求
function loadThumb(itemEl) {
    const thumb = itemEl.querySelector("img");
    if (!thumb || !thumb.dataset.src) return;
    thumb.src = thumb.dataset.src;
    thumb.removeAttribute("data-src");
}

function observeThumbs(scrollRoot, grid) {
    const items = grid.querySelectorAll(".mil-item");
    if (!("IntersectionObserver" in window)) {
        items.forEach(loadThumb);
        return;
    }
    gridObserver = new IntersectionObserver((entries, observer) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            loadThumb(entry.target);
            observer.unobserve(entry.target);
        }
    }, { root: scrollRoot, rootMargin: "400px 0px" });
    items.forEach(el => gridObserver.observe(el));
}

function renderGrid() {
    const body = document.getElementById("mil-body");
    if (gridObserver) {
        gridObserver.disconnect();
        gridObserver = null;
    }
    body.innerHTML = "";

    const images = modalState.images[modalState.tab] || [];
    if (!images.length) {
        const empty = document.createElement("div");
        empty.className = "mil-empty";
        empty.textContent = `No images found in ${modalState.tab} folder`;
        body.appendChild(empty);
        return;
    }

    const grid = document.createElement("div");
    grid.className = "mil-grid";

    for (const img of images) {
        const key = img.path;
        const item = document.createElement("div");
        item.className = "mil-item" + (modalState.selected.has(key) ? " selected" : "");
        item.dataset.key = key;
        item.addEventListener("click", () => toggleSelect(item));

        const thumb = document.createElement("img");
        thumb.alt = img.filename;
        thumb.decoding = "async";
        thumb.dataset.src = getThumbUrl(img);
        thumb.addEventListener("load", () => thumb.classList.add("loaded"), { once: true });

        const check = document.createElement("div");
        check.className = "mil-check";
        check.textContent = "\u2713";

        const name = document.createElement("div");
        name.className = "mil-name";
        name.textContent = img.filename;
        name.title = img.filename;

        item.appendChild(thumb);
        item.appendChild(check);
        item.appendChild(name);
        grid.appendChild(item);
    }

    body.appendChild(grid);
    observeThumbs(body, grid);
}

function updateCount() {
    const count = modalState.selected.size;
    document.getElementById("mil-count-num").textContent = count;
    document.getElementById("mil-confirm-btn").disabled = count === 0;
    document.getElementById("mil-delete-btn").disabled = count === 0;
}

async function confirmSelection() {
    const items = modalState.selectedItems;
    if (!items.length) return;

    const node = modalState.node;
    if (!node) return;

    const paths = items.map(i => i.path);

    if (modalState.pathsWidget) {
        modalState.pathsWidget.value = JSON.stringify(paths);
        if (modalState.pathsWidget.callback) {
            modalState.pathsWidget.callback(modalState.pathsWidget.value);
        }
    }

    try {
        await fetch("/image_picker/update_config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: node.id, count: paths.length, paths }),
        });
    } catch (err) {
        console.error("[ImagePicker] Failed to update config:", err);
    }

    items.forEach(img => getCachedImage(img));
    nodeThumbnails.set(node.id, [...items]);

    hideModal();

    resizeNode(node);
    node.setDirtyCanvas(true, true);
    app.graph.setDirtyCanvas(true, true);
}

function syncPathsToWidget(node) {
    const items = getItems(node);
    const paths = items.map(i => i.path);
    const widget = node.widgets?.find(w => w.name === "image_paths");
    if (widget) {
        widget.value = JSON.stringify(paths);
        if (widget.callback) widget.callback(widget.value);
    }
}

async function syncConfigToBackend(node) {
    const items = getItems(node);
    const paths = items.map(i => i.path);
    try {
        await fetch("/image_picker/update_config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_id: node.id, count: paths.length, paths }),
        });
    } catch (err) {
        console.error("[ImagePicker] Failed to sync config:", err);
    }
}

function deleteSelected() {
    const items = modalState.selectedItems;
    if (!items.length) return;

    const modal = document.querySelector(`#${MODAL_ID} .mil-modal`);
    const overlay = document.createElement("div");
    overlay.className = "mil-confirm-overlay";

    const fileList = items.map(i => `<div>${i.filename}</div>`).join("");
    const count = items.length;

    overlay.innerHTML = `
<div class="mil-confirm-dialog">
    <h3>Delete ${count} image${count > 1 ? "s" : ""}?</h3>
    <p>This will permanently delete the file${count > 1 ? "s" : ""} from disk.</p>
    <div class="mil-confirm-files">${fileList}</div>
    <div class="mil-confirm-actions">
        <button class="mil-btn mil-btn-secondary" id="mil-confirm-no">Cancel</button>
        <button class="mil-btn mil-btn-danger-solid" id="mil-confirm-yes">Delete</button>
    </div>
</div>`;

    modal.appendChild(overlay);

    document.getElementById("mil-confirm-no").addEventListener("click", () => {
        overlay.remove();
    });

    document.getElementById("mil-confirm-yes").addEventListener("click", async () => {
        const files = items.map(i => i.path);
        try {
            const resp = await fetch("/image_picker/delete_files", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ files }),
            });
            const data = await resp.json();

            modalState.selected.clear();
            modalState.selectedItems = [];
            updateCount();

            const node = modalState.node;
            if (node) {
                const nodeItems = getItems(node);
                const deletedSet = new Set(data.deleted || []);
                const remaining = nodeItems.filter(i => !deletedSet.has(i.path));
                if (remaining.length !== nodeItems.length) {
                    nodeThumbnails.set(node.id, remaining);
                    syncPathsToWidget(node);
                    syncConfigToBackend(node);
                    resizeNode(node);
                    node.setDirtyCanvas(true, true);
                }
            }

            overlay.remove();
            loadImages("input");
            loadImages("output");
        } catch (err) {
            console.error("[ImagePicker] Delete failed:", err);
            overlay.remove();
        }
    });
}

function drawButton(ctx, node) {
    const btn = getButtonRect(node);

    ctx.fillStyle = "#3a7fd4";
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(btn.x, btn.y + 1, btn.w, btn.h, 6);
    } else {
        ctx.rect(btn.x, btn.y + 1, btn.w, btn.h);
    }
    ctx.fill();

    ctx.fillStyle = "#4a9eff";
    ctx.beginPath();
    if (ctx.roundRect) {
        ctx.roundRect(btn.x, btn.y, btn.w, btn.h, 6);
    } else {
        ctx.rect(btn.x, btn.y, btn.w, btn.h);
    }
    ctx.fill();

    ctx.fillStyle = "#fff";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Load Image", btn.x + btn.w / 2, btn.y + btn.h / 2 + 0.5);
}

app.registerExtension({
    name: "ComfyNode.ImagePicker",

    setup() {
        injectStyles();
        createModal();

        const canvas = document.querySelector("canvas.litegraph") || document.querySelector("canvas");
        if (canvas) {
            canvas.addEventListener("dragover", (e) => {
                if (dropTargetNode) {
                    e.preventDefault();
                    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
                }
            }, true);

            canvas.addEventListener("drop", (e) => {
                if (dropTargetNode !== null) {
                    e.preventDefault();
                    e.stopPropagation();

                    const node = dropTargetNode;
                    dropTargetNode = null;

                    const dragLeaveEvent = new DragEvent("dragleave", { bubbles: true, cancelable: true });
                    canvas.dispatchEvent(dragLeaveEvent);

                    const items = getItems(node);
                    if (items.length >= 9) return;

                    const files = e.dataTransfer?.files;
                    if (!files || !files.length) return;

                    const imageFiles = Array.from(files).filter(f => f.type.startsWith("image/"));
                    if (!imageFiles.length) return;

                    const availableSlots = 9 - items.length;
                    const toUpload = imageFiles.slice(0, availableSlots);

                    (async () => {
                        for (const file of toUpload) {
                            if (getItems(node).length >= 9) break;
                            try {
                                const imgInfo = await uploadDroppedImage(file);
                                const currentItems = getItems(node);
                                currentItems.push(imgInfo);
                                nodeThumbnails.set(node.id, currentItems);
                                syncPathsToWidget(node);
                                syncConfigToBackend(node);
                                resizeNode(node);
                                node.setDirtyCanvas(true, true);
                            } catch (err) {
                                console.error("[ImagePicker] Drop upload failed:", err);
                            }
                        }
                    })();
                }
            }, true);
        }
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "ImagePicker") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const result = origOnNodeCreated?.apply(this, arguments);

            const pathsWidget = this.widgets.find(w => w.name === "image_paths");
            if (pathsWidget) {
                pathsWidget.type = "hidden";
                if (pathsWidget.inputEl) {
                    pathsWidget.inputEl.style.display = "none";
                    if (pathsWidget.inputEl.parentElement) {
                        pathsWidget.inputEl.parentElement.style.display = "none";
                    }
                }
                if (pathsWidget.element) {
                    pathsWidget.element.style.display = "none";
                }
                pathsWidget.hidden = true;
                pathsWidget.computeSize = () => [0, 0];
            }

            resizeNode(this);

            return result;
        };

        const origOnDrawBackground = nodeType.prototype.onDrawBackground;
        nodeType.prototype.onDrawBackground = function (ctx) {
            const result = origOnDrawBackground?.apply(this, arguments);

            const items = getItems(this);

            for (let i = 0; i < items.length; i++) {
                const rect = getThumbRect(this, i);
                if (!rect) continue;

                const item = items[i];
                const isDragging = dragState.active && dragState.index === i;

                if (isDragging && dragState.moved) {
                    ctx.save();
                    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, THUMB_RADIUS);
                    ctx.clip();
                    ctx.fillStyle = "rgba(107, 159, 255, 0.15)";
                    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
                    ctx.restore();

                    ctx.strokeStyle = "#6b9fff";
                    ctx.setLineDash([4, 4]);
                    ctx.lineWidth = 1;
                    roundRectPath(ctx, rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1, THUMB_RADIUS);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    continue;
                }

                const img = getCachedImage(item);

                ctx.save();
                roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, THUMB_RADIUS);
                ctx.clip();

                ctx.fillStyle = "#1a1a1e";
                ctx.fillRect(rect.x, rect.y, rect.w, rect.h);

                if (img.complete && img.naturalWidth > 0) {
                    const scale = Math.min(rect.w / img.naturalWidth, rect.h / img.naturalHeight);
                    const dw = img.naturalWidth * scale;
                    const dh = img.naturalHeight * scale;
                    const dx = rect.x + (rect.w - dw) / 2;
                    const dy = rect.y + (rect.h - dh) / 2;
                    ctx.drawImage(img, dx, dy, dw, dh);
                } else if (!img.complete) {
                    img.onload = () => { this.setDirtyCanvas(true, true); };
                }

                const labelH = Math.max(16, rect.h * 0.18);
                const labelY = rect.y + rect.h - labelH;

                const grad = ctx.createLinearGradient(0, labelY, 0, rect.y + rect.h);
                grad.addColorStop(0, "rgba(0,0,0,0)");
                grad.addColorStop(0.3, "rgba(0,0,0,0.6)");
                grad.addColorStop(1, "rgba(0,0,0,0.8)");
                ctx.fillStyle = grad;
                ctx.fillRect(rect.x, labelY, rect.w, labelH);

                ctx.restore();

                ctx.strokeStyle = "#000";
                ctx.lineWidth = 2;
                roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, THUMB_RADIUS);
                ctx.stroke();

                ctx.fillStyle = "#ddd";
                const fontSize = Math.max(9, Math.floor(labelH * 0.55));
                ctx.font = `${fontSize}px sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "middle";
                const maxTextW = rect.w - 8;
                const truncName = truncateText(ctx, item.filename, maxTextW);
                ctx.fillText(truncName, rect.x + rect.w / 2, labelY + labelH / 2);

                const btnRect = getDeleteButtonRect(this, i);
                if (btnRect) {
                    ctx.fillStyle = "rgba(180, 50, 50, 0.9)";
                    ctx.beginPath();
                    ctx.arc(btnRect.x + btnRect.w / 2, btnRect.y + btnRect.h / 2, btnRect.w / 2, 0, Math.PI * 2);
                    ctx.fill();

                    ctx.strokeStyle = "rgba(255,255,255,0.8)";
                    ctx.lineWidth = Math.max(1.2, btnRect.w * 0.1);
                    const cx = btnRect.x + btnRect.w / 2;
                    const cy = btnRect.y + btnRect.h / 2;
                    const r = btnRect.w * 0.28;
                    ctx.beginPath();
                    ctx.moveTo(cx - r, cy - r);
                    ctx.lineTo(cx + r, cy + r);
                    ctx.moveTo(cx + r, cy - r);
                    ctx.lineTo(cx - r, cy + r);
                    ctx.stroke();
                }
            }

            if (dragState.active && dragState.moved && dragState.index >= 0) {
                const dragItem = items[dragState.index];
                if (dragItem) {
                    const thumbSize = getThumbSize(this.size[0]);
                    const img = getCachedImage(dragItem);
                    const dx = dragState.currentX - thumbSize / 2;
                    const dy = dragState.currentY - thumbSize / 2;

                    ctx.save();
                    roundRectPath(ctx, dx, dy, thumbSize, thumbSize, THUMB_RADIUS);
                    ctx.clip();

                    ctx.fillStyle = "#1a1a1e";
                    ctx.fillRect(dx, dy, thumbSize, thumbSize);

                    if (img.complete && img.naturalWidth > 0) {
                        const scale = Math.min(thumbSize / img.naturalWidth, thumbSize / img.naturalHeight);
                        const dw = img.naturalWidth * scale;
                        const dh = img.naturalHeight * scale;
                        const ddx = dx + (thumbSize - dw) / 2;
                        const ddy = dy + (thumbSize - dh) / 2;

                        ctx.globalAlpha = 0.7;
                        ctx.drawImage(img, ddx, ddy, dw, dh);
                    }
                    ctx.restore();

                    ctx.strokeStyle = "#000";
                    ctx.lineWidth = 2;
                    roundRectPath(ctx, dx, dy, thumbSize, thumbSize, THUMB_RADIUS);
                    ctx.stroke();

                    ctx.strokeStyle = "#6b9fff";
                    ctx.lineWidth = 1;
                    ctx.setLineDash([6, 3]);
                    roundRectPath(ctx, dx, dy, thumbSize, thumbSize, THUMB_RADIUS);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            drawButton(ctx, this);

            ctx.textAlign = "left";
            ctx.textBaseline = "alphabetic";

            return result;
        };

        const origOnMouseDown = nodeType.prototype.onMouseDown;
        nodeType.prototype.onMouseDown = function (e, pos) {
            const result = origOnMouseDown?.apply(this, arguments);

            if (hitTestButton(this, pos[0], pos[1])) {
                showModal(this);
                return true;
            }

            const items = getItems(this);
            if (!items.length) return result;

            const delIdx = hitTestDelete(this, pos[0], pos[1]);
            if (delIdx >= 0) {
                items.splice(delIdx, 1);
                nodeThumbnails.set(this.id, items);
                syncPathsToWidget(this);
                syncConfigToBackend(this);
                resizeNode(this);
                this.setDirtyCanvas(true, true);
                return true;
            }

            const thumbIdx = hitTestThumb(this, pos[0], pos[1]);
            if (thumbIdx >= 0) {
                dragState.active = true;
                dragState.index = thumbIdx;
                dragState.startX = pos[0];
                dragState.startY = pos[1];
                dragState.currentX = pos[0];
                dragState.currentY = pos[1];
                dragState.moved = false;
                return true;
            }

            return result;
        };

        const origOnMouseMove = nodeType.prototype.onMouseMove;
        nodeType.prototype.onMouseMove = function (e, pos) {
            const result = origOnMouseMove?.apply(this, arguments);

            if (dragState.active) {
                dragState.currentX = pos[0];
                dragState.currentY = pos[1];

                const dx = pos[0] - dragState.startX;
                const dy = pos[1] - dragState.startY;
                if (!dragState.moved && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
                    dragState.moved = true;
                }

                if (dragState.moved) {
                    const targetIdx = hitTestThumb(this, pos[0], pos[1]);
                    if (targetIdx >= 0 && targetIdx !== dragState.index) {
                        const items = getItems(this);
                        const tmp = items[dragState.index];
                        items[dragState.index] = items[targetIdx];
                        items[targetIdx] = tmp;
                        nodeThumbnails.set(this.id, items);
                        dragState.index = targetIdx;
                        syncPathsToWidget(this);
                        syncConfigToBackend(this);
                    }
                    this.setDirtyCanvas(true, true);
                }
                return true;
            }

            return result;
        };

        const origOnMouseUp = nodeType.prototype.onMouseUp;
        nodeType.prototype.onMouseUp = function (e, pos) {
            const result = origOnMouseUp?.apply(this, arguments);

            if (dragState.active) {
                if (dragState.moved) {
                    syncPathsToWidget(this);
                    syncConfigToBackend(this);
                }
                dragState.active = false;
                dragState.index = -1;
                dragState.moved = false;
                this.setDirtyCanvas(true, true);
                return true;
            }

            return result;
        };

        const origComputeSize = nodeType.prototype.computeSize;
        nodeType.prototype.computeSize = function () {
            const size = origComputeSize ? origComputeSize.apply(this, arguments) : [200, 100];
            const h = calcNodeHeight(this);
            size[1] = Math.max(size[1], h);
            return size;
        };

        const origOnResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function () {
            const result = origOnResize?.apply(this, arguments);
            resizeNode(this);
            this.setDirtyCanvas(true, true);
            return result;
        };

        const origOnDragOver = nodeType.prototype.onDragOver;
        nodeType.prototype.onDragOver = function (e) {
            if (getItems(this).length >= 9) return false;
            dropTargetNode = this;
            return true;
        };

        const origOnDrop = nodeType.prototype.onDrop;
        nodeType.prototype.onDrop = function (e) {
            return true;
        };
    },
});