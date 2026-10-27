/* Passport Photo — framing, export and print sheets all happen locally with <canvas>. Nothing is uploaded. */
(function () {
  "use strict";
  const $ = S3.$;
  const DPI = 300, IN = 25.4;

  // Sizes in mm. head = [min, max] chin-to-crown, top = crown distance from the top edge used for the guide,
  // eyes = [min, max] eye-line height from the bottom edge (only where the rule gives one).
  const SPECS = [
    { id: "us", name: "United States — 2×2 in", w: 50.8, h: 50.8, head: [25.4, 34.9], top: 5, eyes: [28.6, 34.9], rule: "Head 1 to 1⅜ in (25–35 mm) from chin to top of hair; eyes 1⅛ to 1⅜ in (28–35 mm) from the bottom." },
    { id: "uk", name: "United Kingdom — 35×45 mm", w: 35, h: 45, head: [29, 34], top: 5, rule: "Head 29–34 mm from chin to crown, centred, plain light background." },
    { id: "eu", name: "EU / Schengen — 35×45 mm", w: 35, h: 45, head: [32, 36], top: 4, rule: "Head 32–36 mm from chin to crown (about 70–80% of the photo), centred." },
    { id: "jo", name: "Jordan — 4×6 cm", w: 40, h: 60, head: [34, 42], top: 8, approx: true, rule: "4×6 cm, white background. No official head-size figure is published, so the guide shows a typical framing." },
    { id: "sa", name: "Saudi Arabia — 4×6 cm", w: 40, h: 60, head: [34, 42], top: 8, approx: true, rule: "4×6 cm, white background. The head guide is a typical framing, not an official figure." },
    { id: "ca", name: "Canada — 50×70 mm", w: 50, h: 70, head: [31, 36], top: 14, rule: "Head 31–36 mm from chin to crown, face and shoulders centred." },
    { id: "in", name: "India — 2×2 in", w: 50.8, h: 50.8, head: [25.4, 34.9], top: 5, rule: "2×2 in, white background, head 25–35 mm from chin to top of hair." },
    { id: "cn", name: "China — 33×48 mm", w: 33, h: 48, head: [28, 33], top: 4, rule: "Head 28–33 mm from chin to crown, 3–5 mm from the top of the head to the top edge." },
    { id: "custom", name: "Custom size…", w: 35, h: 45, head: [32, 36], top: 4, rule: "Your own size. The crown line sits at about 9% of the height." }
  ];
  const PAPERS = { "4x6": { w: 4 * IN, h: 6 * IN, name: "4×6 in" }, "10x15": { w: 100, h: 150, name: "10×15 cm" }, a4: { w: 210, h: 297, name: "A4" }, letter: { w: 8.5 * IN, h: 11 * IN, name: "US Letter" } };

  // ---------- pure maths (used by UI and self-test) ----------
  function mmToPx(mm, dpi) { return Math.round(mm / IN * (dpi || DPI)); }
  // Copies that fit on a paper; tries both paper orientations and keeps the better one.
  function sheetLayout(pw, ph, sw, sh, gap) {
    function fit(W, H) {
      const cols = Math.max(0, Math.floor((W + gap + 1e-6) / (pw + gap))), rows = Math.max(0, Math.floor((H + gap + 1e-6) / (ph + gap)));
      return { cols, rows, n: cols * rows, W, H };
    }
    const a = fit(sw, sh), b = fit(sh, sw);
    const best = b.n > a.n ? b : a;
    best.landscape = best === b && sw !== sh;
    return best;
  }
  // 8-bit levels: brightness/contrast in -100..100
  function adjustLUT(bri, con) {
    const lut = new Uint8ClampedArray(256), b = bri / 100 * 255 * 0.5, c = (con + 100) / 100;
    for (let i = 0; i < 256; i++) lut[i] = Math.round((i - 128) * c + 128 + b);
    return lut;
  }
  // Write 300 DPI into the JPEG's JFIF header (so print dialogs use the true size).
  function setJpegDpi(bytes, dpi) {
    const b = bytes;
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF && b[3] === 0xE0 && String.fromCharCode(b[6], b[7], b[8], b[9]) === "JFIF" && b[10] === 0) {
      b[13] = 1; b[14] = dpi >> 8; b[15] = dpi & 255; b[16] = dpi >> 8; b[17] = dpi & 255;
      return b;
    }
    // No JFIF segment: insert one.
    const app0 = new Uint8Array([0xFF, 0xE0, 0, 16, 0x4A, 0x46, 0x49, 0x46, 0, 1, 1, 1, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
    const out = new Uint8Array(b.length + app0.length);
    out.set(b.subarray(0, 2)); out.set(app0, 2); out.set(b.subarray(2), 2 + app0.length);
    return out;
  }

  // ---------- state ----------
  const saved = S3.store("passport") || {};
  const st = {
    spec: SPECS.some(s => s.id === saved.spec) ? saved.spec : "us",
    custom: saved.custom || { w: 35, h: 45, hmin: 32, hmax: 36 },
    paper: PAPERS[saved.paper] ? saved.paper : "4x6", gap: saved.gap || 0,
    src: null, adj: null, name: "photo",
    zoom: 1, rot: 0, turn: 0, ox: 0, oy: 0, bri: 0, con: 0
  };
  function spec() {
    const s = SPECS.filter(x => x.id === st.spec)[0];
    if (s.id !== "custom") return s;
    const c = st.custom, w = +c.w || 35, h = +c.h || 45, lo = Math.min(+c.hmin || 0, +c.hmax || 0), hi = Math.max(+c.hmin || 0, +c.hmax || 0);
    return Object.assign({}, s, { w, h, head: [lo || h * 0.7, hi || h * 0.8], top: h * 0.09 });
  }
  function save() { S3.store("passport", { spec: st.spec, custom: st.custom, paper: st.paper, gap: st.gap }); }

  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }

  // Source with brightness/contrast baked in (capped so huge photos stay fast).
  function rebuildAdj() {
    if (!st.src) { st.adj = null; return; }
    const s = st.src, iw = s.naturalWidth || s.width, ih = s.naturalHeight || s.height, k = Math.min(1, 4096 / Math.max(iw, ih));
    const c = canvas(Math.round(iw * k), Math.round(ih * k)), x = c.getContext("2d");
    x.imageSmoothingQuality = "high"; x.drawImage(s, 0, 0, c.width, c.height);
    if (st.bri || st.con) {
      const d = x.getImageData(0, 0, c.width, c.height), p = d.data, lut = adjustLUT(st.bri, st.con);
      for (let i = 0; i < p.length; i += 4) { p[i] = lut[p[i]]; p[i + 1] = lut[p[i + 1]]; p[i + 2] = lut[p[i + 2]]; }
      x.putImageData(d, 0, 0);
    }
    st.adj = c;
  }

  // Draw the photo into a frame rectangle (fx, fy, W, H). Same maths for preview and export.
  function drawPhoto(x, fx, fy, W, H) {
    const im = st.adj; if (!im) return;
    const quarter = ((st.turn % 360) + 360) % 360, sideways = quarter === 90 || quarter === 270;
    const iw = sideways ? im.height : im.width, ih = sideways ? im.width : im.height;
    const k = Math.max(W / iw, H / ih) * st.zoom;
    x.save();
    x.translate(fx + W / 2 + st.ox * W, fy + H / 2 + st.oy * W);
    x.rotate((st.turn + st.rot) * Math.PI / 180);
    x.scale(k, k);
    x.imageSmoothingQuality = "high";
    x.drawImage(im, -im.width / 2, -im.height / 2);
    x.restore();
  }

  function renderPhoto(dpi) {
    const s = spec(), W = mmToPx(s.w, dpi), H = mmToPx(s.h, dpi), c = canvas(W, H), x = c.getContext("2d");
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H);
    drawPhoto(x, 0, 0, W, H);
    return c;
  }
  function renderSheet(photo) {
    const s = spec(), p = PAPERS[st.paper], g = +st.gap;
    const L = sheetLayout(s.w, s.h, p.w, p.h, g);
    const W = mmToPx(L.W), H = mmToPx(L.H), c = canvas(W, H), x = c.getContext("2d");
    x.fillStyle = "#ffffff"; x.fillRect(0, 0, W, H);
    if (!L.n) return { canvas: c, L };
    const pw = s.w / IN * DPI, ph = s.h / IN * DPI, gp = g / IN * DPI;
    const gw = L.cols * pw + (L.cols - 1) * gp, gh = L.rows * ph + (L.rows - 1) * gp;
    const x0 = (W - gw) / 2, y0 = (H - gh) / 2;
    for (let r = 0; r < L.rows; r++) for (let q = 0; q < L.cols; q++) x.drawImage(photo, Math.round(x0 + q * (pw + gp)), Math.round(y0 + r * (ph + gp)), Math.round(pw), Math.round(ph));
    // cut lines: thin grey lines along every photo edge, running across the whole sheet
    x.strokeStyle = "rgba(0,0,0,.35)"; x.lineWidth = 1;
    const xs = new Set(), ys = new Set();
    for (let q = 0; q < L.cols; q++) { xs.add(Math.round(x0 + q * (pw + gp)) + 0.5); xs.add(Math.round(x0 + q * (pw + gp) + pw) - 0.5); }
    for (let r = 0; r < L.rows; r++) { ys.add(Math.round(y0 + r * (ph + gp)) + 0.5); ys.add(Math.round(y0 + r * (ph + gp) + ph) - 0.5); }
    const mark = mmToPx(4);
    xs.forEach(v => { // short marks outside the grid + fine lines in the gaps
      x.beginPath(); x.moveTo(v, Math.max(0, y0 - mark)); x.lineTo(v, y0 - 2); x.moveTo(v, y0 + gh + 2); x.lineTo(v, Math.min(H, y0 + gh + mark)); x.stroke();
    });
    ys.forEach(v => {
      x.beginPath(); x.moveTo(Math.max(0, x0 - mark), v); x.lineTo(x0 - 2, v); x.moveTo(x0 + gw + 2, v); x.lineTo(Math.min(W, x0 + gw + mark), v); x.stroke();
    });
    if (!g) { // touching photos: draw the shared cut lines through the grid too
      x.strokeStyle = "rgba(0,0,0,.18)";
      xs.forEach(v => { x.beginPath(); x.moveTo(v, y0); x.lineTo(v, y0 + gh); x.stroke(); });
      ys.forEach(v => { x.beginPath(); x.moveTo(x0, v); x.lineTo(x0 + gw, v); x.stroke(); });
    }
    return { canvas: c, L };
  }
  function toJpeg(c) {
    return new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error("Could not encode")), "image/jpeg", 0.95))
      .then(b => b.arrayBuffer()).then(buf => new Blob([setJpegDpi(new Uint8Array(buf), DPI)], { type: "image/jpeg" }));
  }

  // ---------- stage (preview with guides) ----------
  const stage = $("#stage"), wrap = $("#stageWrap");
  let geo = null;
  function layoutStage() {
    const s = spec(), pad = Math.max(s.w, s.h) * 0.16, sw = s.w + pad * 2, sh = s.h + pad * 2;
    const cw = wrap.clientWidth || 480, maxH = Math.min(560, Math.max(320, window.innerHeight * 0.62));
    let k = cw / sw; if (sh * k > maxH) k = maxH / sh;
    const dpr = window.devicePixelRatio || 1, Wc = Math.round(sw * k), Hc = Math.round(sh * k);
    stage.style.width = Wc + "px"; stage.style.height = Hc + "px";
    stage.width = Math.round(Wc * dpr); stage.height = Math.round(Hc * dpr);
    geo = { k: k * dpr, pad, s, fx: pad * k * dpr, fy: pad * k * dpr, W: s.w * k * dpr, H: s.h * k * dpr, dpr };
    draw();
  }
  function draw() {
    if (!geo) return;
    const x = stage.getContext("2d"), g = geo, s = g.s, mm = g.k, CW = stage.width, CH = stage.height;
    x.clearRect(0, 0, CW, CH);
    if (st.adj) {
      x.fillStyle = "#ffffff"; x.fillRect(g.fx, g.fy, g.W, g.H);
      drawPhoto(x, g.fx, g.fy, g.W, g.H);
    }
    // dim everything outside the frame
    x.save(); x.fillStyle = "rgba(10,12,16,.62)"; x.beginPath(); x.rect(0, 0, CW, CH); x.rect(g.fx, g.fy, g.W, g.H); x.fill("evenodd"); x.restore();
    x.strokeStyle = "rgba(255,255,255,.9)"; x.lineWidth = Math.max(1, g.dpr); x.strokeRect(g.fx, g.fy, g.W, g.H);
    if (!st.adj) return;
    const crown = g.fy + s.top * mm, chinLo = crown + s.head[0] * mm, chinHi = crown + s.head[1] * mm, cx = g.fx + g.W / 2;
    const lw = Math.max(1, 1.5 * g.dpr), font = Math.round(11 * g.dpr) + "px Inter, system-ui, sans-serif";
    x.save(); x.font = font; x.textBaseline = "bottom";
    // chin band
    x.fillStyle = "rgba(255,181,71,.22)"; x.fillRect(g.fx, chinLo, g.W, chinHi - chinLo);
    x.strokeStyle = "rgba(255,181,71,.95)"; x.lineWidth = lw; x.setLineDash([]);
    [chinLo, chinHi].forEach(y => { x.beginPath(); x.moveTo(g.fx, y); x.lineTo(g.fx + g.W, y); x.stroke(); });
    // eye band
    if (s.eyes) {
      const e1 = g.fy + (s.h - s.eyes[1]) * mm, e2 = g.fy + (s.h - s.eyes[0]) * mm;
      x.fillStyle = "rgba(110,231,168,.16)"; x.fillRect(g.fx, e1, g.W, e2 - e1);
      x.strokeStyle = "rgba(110,231,168,.95)"; x.setLineDash([5 * g.dpr, 4 * g.dpr]);
      [e1, e2].forEach(y => { x.beginPath(); x.moveTo(g.fx, y); x.lineTo(g.fx + g.W, y); x.stroke(); });
    }
    // crown line
    x.strokeStyle = "rgba(61,214,208,1)"; x.setLineDash([]); x.lineWidth = lw * 1.3;
    x.beginPath(); x.moveTo(g.fx, crown); x.lineTo(g.fx + g.W, crown); x.stroke();
    // head outline + centre line
    const hm = (s.head[0] + s.head[1]) / 2 * mm;
    x.strokeStyle = "rgba(255,255,255,.75)"; x.lineWidth = lw; x.setLineDash([6 * g.dpr, 5 * g.dpr]);
    x.beginPath(); x.ellipse(cx, crown + hm / 2, hm * 0.37, hm / 2, 0, 0, Math.PI * 2); x.stroke();
    x.strokeStyle = "rgba(255,255,255,.35)";
    x.beginPath(); x.moveTo(cx, g.fy); x.lineTo(cx, g.fy + g.H); x.stroke();
    x.restore();
  }

  // ---------- interaction ----------
  const ptrs = new Map();
  let pinch = null;
  stage.addEventListener("pointerdown", e => {
    if (!st.adj) return;
    stage.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) { const p = [...ptrs.values()]; pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), z: st.zoom }; }
  });
  stage.addEventListener("pointermove", e => {
    const prev = ptrs.get(e.pointerId); if (!prev || !geo) return;
    const cur = { x: e.clientX, y: e.clientY }; ptrs.set(e.pointerId, cur);
    if (ptrs.size === 2 && pinch) {
      const p = [...ptrs.values()], d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      setZoom(pinch.z * d / pinch.d);
    } else if (ptrs.size === 1) {
      const fw = geo.W / geo.dpr;
      st.ox += (cur.x - prev.x) / fw; st.oy += (cur.y - prev.y) / fw; changed(true);
    }
  });
  function endPtr(e) { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) changed(); }
  stage.addEventListener("pointerup", endPtr); stage.addEventListener("pointercancel", endPtr);
  stage.addEventListener("wheel", e => { if (!st.adj) return; e.preventDefault(); setZoom(st.zoom * Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  stage.addEventListener("keydown", e => {
    if (!st.adj) return;
    const step = e.shiftKey ? 0.02 : 0.004, k = e.key;
    if (k === "ArrowLeft") st.ox -= step; else if (k === "ArrowRight") st.ox += step;
    else if (k === "ArrowUp") st.oy -= step; else if (k === "ArrowDown") st.oy += step;
    else if (k === "+" || k === "=") return void setZoom(st.zoom * 1.03);
    else if (k === "-" || k === "_") return void setZoom(st.zoom / 1.03);
    else return;
    e.preventDefault(); changed();
  });
  function setZoom(z) { st.zoom = Math.max(1, Math.min(6, z)); $("#zoom").value = Math.round(st.zoom * 100); $("#zoomV").textContent = Math.round(st.zoom * 100) + "%"; changed(true); }

  let sheetTimer = 0;
  function changed(live) {
    draw();
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(updateSheet, live ? 300 : 60);
  }
  let sheetUrl = null, sheetCanvas = null;
  function updateSheet() {
    const p = PAPERS[st.paper];
    if (!st.adj) { $("#sheetCap").textContent = "Open a photo to build the sheet."; return; }
    const r = renderSheet(renderPhoto(DPI));
    sheetCanvas = r.canvas;
    const prev = canvas(Math.round(r.canvas.width / 4), Math.round(r.canvas.height / 4));
    prev.getContext("2d").drawImage(r.canvas, 0, 0, prev.width, prev.height);
    prev.toBlob(b => {
      if (!b) return;
      if (sheetUrl) URL.revokeObjectURL(sheetUrl);
      sheetUrl = URL.createObjectURL(b); $("#sheetImg").src = sheetUrl;
    }, "image/jpeg", 0.85);
    $("#sheetCap").textContent = r.L.n ? r.L.n + " copies (" + r.L.cols + "×" + r.L.rows + ") on " + p.name + (r.L.landscape ? ", landscape" : "") : "This size does not fit on " + p.name + ".";
    $("#dlSheet").disabled = $("#print").disabled = !r.L.n;
  }

  function showSpec() {
    const s = spec();
    $("#custom").hidden = st.spec !== "custom";
    $("#rule").textContent = s.rule;
    $("#rule").classList.toggle("approx", !!s.approx);
    $("#eyeKey").hidden = !s.eyes;
    const W = mmToPx(s.w), H = mmToPx(s.h);
    $("#specStats").innerHTML = [fmtMm(s.w) + " × " + fmtMm(s.h) + " mm", W + " × " + H + " px at 300 DPI", "head " + fmtMm(s.head[0]) + "–" + fmtMm(s.head[1]) + " mm"]
      .map(v => '<span class="chip">' + S3.esc(v) + "</span>").join("");
    layoutStage(); changed();
  }
  function fmtMm(v) { return (Math.round(v * 10) / 10).toString(); }

  function loadImage(file) {
    const url = URL.createObjectURL(file), img = new Image();
    img.src = url;
    return img.decode().then(() => img).catch(() => { URL.revokeObjectURL(url); throw new Error("Can't read this image"); });
  }
  async function useFile(file) {
    try {
      const img = await loadImage(file);
      st.src = img; st.name = (file.name || "photo").replace(/\.[^.]+$/, "") || "photo";
      resetFrame(); rebuildAdj();
      $("#drop").hidden = true; $("#dlPhoto").disabled = false;
      changed();
    } catch (e) { S3.toast(e.message, "error"); }
  }
  function resetFrame() {
    st.zoom = 1; st.rot = 0; st.turn = 0; st.ox = 0; st.oy = 0;
    $("#zoom").value = 100; $("#zoomV").textContent = "100%"; $("#rot").value = 0; $("#rotV").textContent = "0°";
  }

  // ---------- wiring ----------
  const sel = $("#spec");
  SPECS.forEach(s => sel.appendChild(S3.h("option", { value: s.id, text: s.name })));
  sel.value = st.spec;
  sel.addEventListener("change", () => { st.spec = sel.value; save(); showSpec(); });
  [["cw", "w"], ["ch", "h"], ["chmin", "hmin"], ["chmax", "hmax"]].forEach(([id, k]) => {
    const el = $("#" + id); el.value = st.custom[k];
    el.addEventListener("input", S3.debounce(() => { const v = parseFloat(el.value); if (v > 0) { st.custom[k] = v; save(); showSpec(); } }, 250));
  });
  $("#paper").value = st.paper; $("#gap").value = String(st.gap);
  $("#paper").addEventListener("change", e => { st.paper = e.target.value; save(); updateSheet(); });
  $("#gap").addEventListener("change", e => { st.gap = +e.target.value; save(); updateSheet(); });
  $("#zoom").addEventListener("input", e => setZoom(+e.target.value / 100));
  $("#rot").addEventListener("input", e => { st.rot = +e.target.value; $("#rotV").textContent = st.rot + "°"; changed(true); });
  const adjRedo = S3.debounce(() => { rebuildAdj(); changed(); }, 120);
  $("#bri").addEventListener("input", e => { st.bri = +e.target.value; $("#briV").textContent = (st.bri > 0 ? "+" : "") + st.bri; adjRedo(); });
  $("#con").addEventListener("input", e => { st.con = +e.target.value; $("#conV").textContent = (st.con > 0 ? "+" : "") + st.con; adjRedo(); });
  $("#turn").addEventListener("click", () => { st.turn = (st.turn + 90) % 360; changed(); });
  $("#reset").addEventListener("click", () => { resetFrame(); changed(); });
  S3.drop($("#drop"), fs => useFile(fs[0]), { accept: "image/*", multiple: false });
  $("#open input").addEventListener("change", e => { const f = e.target.files[0]; if (f) useFile(f); e.target.value = ""; });
  document.addEventListener("paste", e => {
    const f = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(x => /^image\//.test(x.type))[0];
    if (f) { e.preventDefault(); useFile(f); }
  });
  $("#dlPhoto").addEventListener("click", async () => {
    const s = spec();
    S3.download(await toJpeg(renderPhoto(DPI)), st.name + "-" + s.id + "-" + fmtMm(s.w) + "x" + fmtMm(s.h) + "mm.jpg"); S3.done();
  });
  $("#dlSheet").addEventListener("click", async () => {
    if (!sheetCanvas) return;
    S3.download(await toJpeg(sheetCanvas), st.name + "-" + spec().id + "-sheet-" + st.paper + ".jpg"); S3.done();
  });
  $("#print").addEventListener("click", async () => {
    if (!sheetCanvas) return;
    const p = PAPERS[st.paper], L = sheetLayout(spec().w, spec().h, p.w, p.h, +st.gap), img = $("#printImg");
    const url = URL.createObjectURL(await toJpeg(sheetCanvas));
    img.style.width = L.W + "mm"; img.style.height = L.H + "mm";
    img.onload = () => { window.print(); setTimeout(() => URL.revokeObjectURL(url), 1000); S3.done(); };
    img.src = url;
  });
  async function loadSample() {
    const c = samplePortrait();
    const b = await new Promise(r => c.toBlob(r, "image/jpeg", 0.92));
    await useFile(new File([b], "sample-portrait.jpg", { type: "image/jpeg" }));
  }
  $("#sample").addEventListener("click", loadSample);
  if (window.ResizeObserver) new ResizeObserver(S3.debounce(layoutStage, 60)).observe(wrap);
  else window.addEventListener("resize", S3.debounce(layoutStage, 100));

  // A drawn (not real) portrait for the demo.
  function samplePortrait() {
    const W = 900, H = 1100, c = canvas(W, H), x = c.getContext("2d");
    const bg = x.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, "#eef1f5"); bg.addColorStop(1, "#d9dee6");
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    x.fillStyle = "#2d4a6b"; x.beginPath(); x.moveTo(120, H); x.bezierCurveTo(140, 800, 300, 760, 450, 760); x.bezierCurveTo(600, 760, 760, 800, 780, H); x.fill();
    x.fillStyle = "#f2f4f7"; x.beginPath(); x.moveTo(390, 770); x.lineTo(450, 880); x.lineTo(510, 770); x.fill();
    x.fillStyle = "#d9a07b"; x.fillRect(395, 640, 110, 140);
    x.fillStyle = "#e8b48f"; x.beginPath(); x.ellipse(450, 470, 165, 215, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#3a2a20"; x.beginPath(); x.ellipse(450, 345, 180, 120, 0, Math.PI, Math.PI * 2); x.fill();
    x.beginPath(); x.ellipse(450, 330, 175, 95, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#e8b48f"; x.beginPath(); x.ellipse(285, 480, 26, 45, 0, 0, Math.PI * 2); x.ellipse(615, 480, 26, 45, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#ffffff"; x.beginPath(); x.ellipse(385, 455, 30, 16, 0, 0, Math.PI * 2); x.ellipse(515, 455, 30, 16, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#4a3426"; x.beginPath(); x.arc(385, 455, 12, 0, Math.PI * 2); x.arc(515, 455, 12, 0, Math.PI * 2); x.fill();
    x.strokeStyle = "#3a2a20"; x.lineWidth = 9; x.lineCap = "round";
    x.beginPath(); x.moveTo(345, 415); x.quadraticCurveTo(385, 400, 420, 415); x.moveTo(480, 415); x.quadraticCurveTo(515, 400, 555, 415); x.stroke();
    x.strokeStyle = "#c98b68"; x.lineWidth = 6; x.beginPath(); x.moveTo(450, 470); x.quadraticCurveTo(440, 530, 462, 540); x.stroke();
    x.strokeStyle = "#a8584a"; x.lineWidth = 7; x.beginPath(); x.moveTo(405, 590); x.quadraticCurveTo(450, 605, 495, 590); x.stroke();
    return c;
  }

  showSpec();

  window.S3_DEMO = async function () {
    st.spec = "us"; sel.value = "us"; showSpec();
    await loadSample();
    setZoom(1.12); st.oy = 0.025; changed();
    await new Promise(r => setTimeout(r, 200));
    updateSheet();
  };

  // Self-test run by scripts/smoke.py
  window.S3_SELFTEST = async function () {
    // 1) mm -> px at 300 DPI
    const ok1 = mmToPx(25.4) === 300 && mmToPx(50.8) === 600 && mmToPx(35) === 413 && mmToPx(45) === 531 && mmToPx(40) === 472 && mmToPx(60) === 709 &&
      mmToPx(50) === 591 && mmToPx(70) === 827 && mmToPx(33) === 390 && mmToPx(48) === 567;
    // 2) sheet tiling counts
    const n = (sid, pid, g) => { const s = SPECS.filter(x => x.id === sid)[0], p = PAPERS[pid]; return sheetLayout(s.w, s.h, p.w, p.h, g || 0); };
    const us4 = n("us", "4x6"), eu4 = n("eu", "4x6"), euA4 = n("eu", "a4"), ca10 = n("ca", "10x15"), cn4 = n("cn", "4x6"), ca4 = n("ca", "4x6"), ca4g = n("ca", "4x6", 2), jo4 = n("jo", "4x6");
    const ok2 = us4.n === 6 && us4.cols === 2 && us4.rows === 3 && eu4.n === 8 && eu4.landscape && euA4.n === 36 && ca10.n === 4 && cn4.n === 9 && ca4.n === 4 && ca4g.n === 2 && jo4.n === 4 &&
      n("us", "letter").n === 20;
    // 3) levels, JPEG DPI header, real render size + brightness on export
    const lut = adjustLUT(20, 0), lut2 = adjustLUT(0, 50);
    const ok3a = lut[100] === 126 && lut[255] === 255 && lut2[128] === 128 && lut2[0] === 0 && lut2[200] === 236;
    const keep = { src: st.src, adj: st.adj, spec: st.spec, zoom: st.zoom, rot: st.rot, turn: st.turn, ox: st.ox, oy: st.oy, bri: st.bri, con: st.con };
    const solid = canvas(200, 300), sx = solid.getContext("2d"); sx.fillStyle = "rgb(100,100,100)"; sx.fillRect(0, 0, 200, 300);
    Object.assign(st, { src: solid, spec: "eu", zoom: 1, rot: 0, turn: 0, ox: 0, oy: 0, bri: 20, con: 0 }); rebuildAdj();
    const out = renderPhoto(DPI), op = out.getContext("2d").getImageData(206, 265, 1, 1).data;
    const jb = new Uint8Array(await (await toJpeg(out)).arrayBuffer());
    Object.assign(st, keep);
    const ok3 = ok3a && out.width === 413 && out.height === 531 && Math.abs(op[0] - 126) <= 1 &&
      jb[0] === 0xFF && jb[1] === 0xD8 && jb[13] === 1 && (jb[14] << 8 | jb[15]) === 300 && (jb[16] << 8 | jb[17]) === 300;
    return (ok1 && ok2 && ok3) || { ok1, ok2, ok3, counts: [us4.n, eu4.n, euA4.n, ca10.n, cn4.n, ca4.n, ca4g.n, jo4.n], px: [].slice.call(op), size: [out.width, out.height], hdr: [].slice.call(jb.subarray(0, 18)) };
  };
})();
