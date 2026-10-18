/* 前端入口：桥接 ready、视图路由、DOM 交互（§3.3、§7）。
   视图层与动画层——最终结果由 Python 锁定，前端不做随机。
   视觉：粘土拟态 + 便当盒布局的糖果变体；动效遵循弹簧缓动与 Q 弹物理。 */
"use strict";

/* ============ 全局状态 ============ */
const App = {
  ready: false,
  view: "roll",            // roll | manage
  pendingView: null,        // 页面就绪前由后端推来的目标视图（悬浮球入口）
  snapshot: null,           // 最近一次 full_snapshot
  drawId: null,             // 当前事务 ID（防旧动画回调覆盖新抽取，§7.4）
  renderedDrawId: null,     // 已渲染进 DOM 的结果 ID（避免重复重建卡片）
  revealedCount: 0,         // 动画中已揭晓人数
  timers: [],               // 动画计时器（立即揭晓/清理时全部取消）
  rolling: false,
  celebrated: false,        // 本轮完成庆祝只放一次
  lastRemaining: null,      // 剩余人数上一次的值（值没变不重播数字动画）
  stage: null,              // ThreeStage 实例
  winners: [],              // 本轮全部中选者（首位在 3D 舞台定格）
  revealedWinners: [],      // 已依次揭晓的中选者
};

const $ = (id) => document.getElementById(id);
const api = () => window.pywebview && window.pywebview.api;

/* 糖果身份色：每张卡片一个色（6 色循环），静态与动画期共用同一套 */
const CANDY_COLORS = ["#FFC78F", "#A8E6CF", "#9FD8FF", "#D8B4F8", "#FFD75E", "#FF9FC3"];
const RESULT_CHIP_COLORS = [
  ["#FFE1EE", "#FFD6E8", "#8E2C5C"],
  ["#FFF3D6", "#FFE9BC", "#8A5A12"],
  ["#DCFBEC", "#CFF3E4", "#1E6048"],
  ["#DCF1FF", "#CBE9FF", "#1D5A80"],
  ["#EEE4FF", "#E3D6FF", "#5B3A96"],
  ["#FFF6CE", "#FFEFB0", "#7A5B00"],
];

/* ============ 启动 ============ */
window.addEventListener("pywebviewready", init);
// 兜底：桥接已就绪后才加载脚本的场景
if (window.pywebview) setTimeout(init, 0);

function init() {
  if (App.ready) return;
  App.ready = true;
  $("loading").classList.add("hidden");
  // 两个视图的控件都在同一 document 内绑定；各自隔离，单个视图绑定失败不拖垮另一个
  try { initRollView(); } catch (e) { console.error("点名视图绑定失败", e); }
  try { bindManageControls(); } catch (e) { console.error("管理视图绑定失败", e); }
  // 后端（悬浮球）可能在 init 之前就推了视图，优先采用
  showView(App.pendingView || "roll");
  App.pendingView = null;
}

async function refreshSnapshot() {
  const r = await api().get_snapshot();
  if (!r || !r.ok) return;
  App.snapshot = r;
  if (App.view === "roll") renderRoll(r);
  else renderManage(r);
}

/* ============ 视图切换（单窗口：同一 document 内切点名/管理） ============ */
function showView(name) {
  App.view = name === "manage" ? "manage" : "roll";
  $("roll-view").classList.toggle("hidden", App.view !== "roll");
  $("manage-view").classList.toggle("hidden", App.view !== "manage");
  if (App.view === "manage") requestAnimationFrame(moveTabIndicator);
  refreshSnapshot();   // 进入视图时拉最新数据并重绘
}
// 供后端 evaluate_js 调用（悬浮球右键进管理）：页面未就绪时先记下，init 时生效
App.showView = (name) => {
  if (!App.ready) { App.pendingView = name; return; }
  showView(name);
};

/* ============ 通用确认框（§10：真正提交前必须显式确认） ============ */
function confirmDialog(text) {
  return new Promise((resolve) => {
    $("confirm-text").textContent = text;
    $("confirm-mask").classList.remove("hidden");
    const done = (val) => {
      $("confirm-mask").classList.add("hidden");
      $("confirm-ok").onclick = $("confirm-cancel").onclick = null;
      resolve(val);
    };
    $("confirm-ok").onclick = () => done(true);
    $("confirm-cancel").onclick = () => done(false);
  });
}

function clearTimers() {
  App.timers.forEach(clearTimeout);
  App.timers = [];
}

/* ============ 点名视图 ============ */
function initRollView() {
  buildCountPicker();
  buildScenePicker();
  initThreeStage();
  bindRollControls();
  document.addEventListener("keydown", (e) => {
    const tag = (e.target && e.target.tagName ? e.target.tagName : "").toLowerCase();
    if (e.code === "Space" && tag !== "input" && tag !== "textarea") {
      e.preventDefault();
      if (App.rolling) revealNow();
      else startDraw();
      return;
    }
    if (e.key === "Escape") {
      // 全屏时 Esc 由 pywebview toggle_fullscreen 处理；否则收起或关闭菜单
      if (document.body.classList.contains("fullscreen")) {
        api().show_fullscreen();
        document.body.classList.remove("fullscreen");
      } else if (!$("more-menu").classList.contains("hidden")) {
        $("more-menu").classList.add("hidden");
      }
    }
  });
}

function initThreeStage() {
  const host = $("three-stage");
  if (!host) return;
  if (!window.ThreeStage) {
    console.error("ThreeStage 脚本未加载");
    host.innerHTML = '<div class="stage-error">3D 场景脚本加载失败</div>';
    return;
  }
  try {
    App.stage = new window.ThreeStage(host);
  } catch (e) {
    console.error("3D 场景初始化失败", e);
    host.innerHTML = '<div class="stage-error">当前环境无法初始化 WebGL 3D 场景</div>';
  }
}

function buildCountPicker() {
  const picker = $("count-picker");
  picker.innerHTML = "";
  for (let i = 1; i <= 5; i++) {
    const b = document.createElement("button");
    b.className = "count-dot";
    b.textContent = i;
    b.onclick = async () => {
      if (App.rolling) return;              // 动画中禁用（§7.3）
      await api().set_draw_count(i);
      refreshSnapshot();
    };
    picker.appendChild(b);
  }
}

const SCENES = [
  ["sphere", "🌌 星球"],
  ["cube", "🎲 魔方"],
  ["cylinder", "🎡 轮盘"],
  ["gallery_3d", "📺 展台"],
];

function buildScenePicker() {
  const picker = $("scene-picker");
  if (!picker) return;
  picker.innerHTML = "";
  SCENES.forEach(([mode, label]) => {
    const b = document.createElement("button");
    b.className = "scene-chip";
    b.dataset.scene = mode;
    b.textContent = label;
    b.onclick = async () => {
      if (App.rolling) return;
      const r = await api().set_preference("sceneMode", mode);
      if (r && r.ok) {
        if (!App.snapshot) App.snapshot = { settings: {} };
        App.snapshot.settings = { ...(App.snapshot.settings || {}), sceneMode: mode };
        updateScenePicker(mode);
        if (App.stage) App.stage.setMode(mode);
      }
    };
    picker.appendChild(b);
  });
}

function bindRollControls() {
  $("btn-start").onclick = startDraw;
  $("btn-reveal-now").onclick = revealNow;
  $("btn-collapse").onclick = () => api().collapse();
  $("btn-fullscreen").onclick = toggleFullscreen;
  $("btn-more").onclick = () => $("more-menu").classList.toggle("hidden");
  $("btn-manage").onclick = () => showView("manage");
  $("btn-empty-manage").onclick = () => showView("manage");
  $("btn-quit").onclick = async () => {
    if (await confirmDialog("确定退出 CandyRollCall 吗？")) api().quit_app();
  };
  $("btn-mode").onclick = async () => {
    if (App.rolling) return;
    const cur = App.snapshot?.settings?.mode || "no_repeat";
    const next = cur === "no_repeat" ? "random" : "no_repeat";
    const r = await api().change_mode(next, false);
    if (r && r.needsConfirm) {
      if (await confirmDialog(r.message)) {
        await api().change_mode(next, true);
        refreshSnapshot();
      }
    }
  };
  document.addEventListener("click", (e) => {
    if (!$("more-menu").contains(e.target) && e.target !== $("btn-more")) {
      $("more-menu").classList.add("hidden");
    }
  });
}

function toggleFullscreen() {
  document.body.classList.toggle("fullscreen");
  api().show_fullscreen();
}

/* ---- 渲染（按状态机 §6.2） ---- */
function renderRoll(snap) {
  const draw = snap.draw;
  const settings = snap.settings || {};
  const sceneMode = settings.sceneMode || "sphere";
  updateCountPicker(settings.drawCount);
  updateModeButton(settings.mode);
  updateScenePicker(sceneMode);
  updateRemaining(draw);

  // 3D 舞台：名单与场景均由同一份 Python 快照驱动
  if (App.stage) {
    App.stage.setStudents(snap.students || []);
    App.stage.setMode(sceneMode);
  }

  const st = draw.state;
  $("empty-state").classList.toggle("hidden", st !== "EMPTY");
  $("round-complete").classList.toggle("hidden", !draw.roundComplete || st !== "ROUND_COMPLETE");

  // “立即揭晓”仅动画中显示（V2.1）
  const animating = st === "ANIMATING";
  $("btn-reveal-now").classList.toggle("hidden", !animating);
  $("btn-start").textContent = st === "ROUND_COMPLETE" ? "开启新一轮"
    : (draw.activeResult && draw.revealDone && st === "RESULT") ? "再抽一次" : "开始点名";
  $("btn-start").disabled = st === "EMPTY" || animating;

  App.rolling = animating;
  $("count-picker").style.opacity = animating ? "0.4" : "1";
  $("btn-mode").disabled = animating;
  const scenePicker = $("scene-picker");
  if (scenePicker) {
    scenePicker.style.opacity = animating ? "0.4" : "1";
    [...scenePicker.children].forEach((b) => { b.disabled = animating; });
  }

  if (st === "EMPTY" || st === "IDLE") {
    if (App.stage) App.stage.clearWinners();
    hideResultOverlay();
  }

  // 蓄力聚光：只在抽取阶段点亮，进入揭晓后熄灭
  setCharging(animating && !draw.revealDone);

  // 全班点完：放一次庆祝纸屑（由 celebrated 保证不重播）
  if (draw.roundComplete && st === "ROUND_COMPLETE") {
    if (!App.celebrated) { App.celebrated = true; celebrateRound(); }
  } else {
    App.celebrated = false;
  }

  // 恢复场景（收起/全屏回来、窗口重建）：直接重建静态结果，不重抽（§6.2）
  // 同一 drawId 已渲染过就不再重建，否则每次窗口获得焦点都会重播 pop-in 动画
  if (draw.activeResult && draw.revealDone &&
      App.renderedDrawId !== draw.activeResult.drawId) {
    renderResultStatic(draw.activeResult.students);
    App.renderedDrawId = draw.activeResult.drawId;
  }
}

function updateScenePicker(mode) {
  const picker = $("scene-picker");
  if (!picker) return;
  [...picker.children].forEach((b) => {
    b.classList.toggle("active", b.dataset.scene === mode);
  });
}

function updateCountPicker(n) {
  [...$("count-picker").children].forEach((b, i) => {
    b.classList.toggle("active", i + 1 === n);
  });
}

function updateModeButton(mode) {
  $("btn-mode").textContent = mode === "no_repeat" ? "🔁 不重复" : "🎲 完全随机";
}

function updateRemaining(draw) {
  const el = $("remaining");
  if (App.snapshot?.settings?.mode !== "no_repeat") {
    el.innerHTML = "";
    App.lastRemaining = null;
    return;
  }
  const n = draw.remaining;
  if (App.lastRemaining === n && el.firstElementChild) return;  // 值没变不重播
  App.lastRemaining = n;
  el.innerHTML = `剩余 <span class="num">${n}</span> 人`;
  const num = el.querySelector(".num");
  void num.offsetWidth;      // 强制回流，保证每次都是新元素起动画
  num.classList.add("tick");
}

/* ---- 抽取与动画（§7.2 节拍） ---- */
async function startDraw() {
  const draw = App.snapshot?.draw;
  if (draw?.state === "ROUND_COMPLETE") {
    // 手动开启新一轮
    const r = await api().reset_round(true);
    if (r?.ok) refreshSnapshot();
    return;
  }
  if (App.rolling) return;

  const r = await api().draw();     // Python 锁定结果
  if (!r || !r.ok) {
    if (r && r.error === "BUSY") return;   // 连点：忽略（AT-18）
    alert(r?.message || "抽取失败");
    return;
  }
  beginAnimation(r);
  // 立即同步状态：隐藏待机卡、显示“立即揭晓”、禁用设置（§6.2 动画中约束）
  App.snapshot = { ...App.snapshot, draw: r.state };
  renderRoll(App.snapshot);
}

function beginAnimation(result) {
  App.drawId = result.drawId;
  App.renderedDrawId = result.drawId;
  App.revealedCount = 0;
  App.lastRemaining = null;
  App.winners = result.students.slice();
  App.revealedWinners = [];
  clearTimers();
  clearFx();
  hideResultOverlay();
  const baseSec = result.baseAnimationSeconds || 4;
  setCharging(true);

  if (App.stage) {
    App.stage.setWinners(result.students, [result.students[0] && result.students[0].id]);
    App.stage.startSpin(result.students, baseSec, () => handleSpinComplete(result));
  } else {
    // WebGL 初始化失败时的纯 DOM 兜底：不做随机，只展示已锁定结果
    App.timers.push(setTimeout(() => handleSpinComplete(result), baseSec * 1000));
  }
}

function handleSpinComplete(result) {
  if (App.drawId !== result.drawId) return;
  setCharging(false);
  App.revealedCount = 0;
  revealNextWinner(result, 0);
}

function revealNextWinner(result, index) {
  if (App.drawId !== result.drawId) return;
  const students = result.students;
  const student = students[index];
  if (!student) {
    finishReveal(result);
    return;
  }
  App.revealedWinners.push(student);
  App.revealedCount = App.revealedWinners.length;
  if (App.stage) {
    App.stage.revealWinners(students, App.revealedWinners.map((s) => s.id));
  }
  showResultOverlay();
  appendResultChip(student, index, index === 0);

  if (index + 1 < students.length) {
    App.timers.push(setTimeout(() => {
      if (App.drawId === result.drawId) revealNextWinner(result, index + 1);
    }, 620));
  } else {
    App.timers.push(setTimeout(() => {
      if (App.drawId === result.drawId) finishReveal(result);
    }, 360));
  }
}

function finishReveal(result) {
  setCharging(false);
  api().mark_reveal_complete(result.drawId).then((r) => {
    if (r && r.ok) {
      App.snapshot = { ...App.snapshot, draw: r.state };
      renderRoll({ ...App.snapshot, settings: App.snapshot.settings });
    }
  });
}

/* ---- 立即揭晓（V2.1 §6.2/§7.2）：终止剩余动画，展示全部锁定结果 ---- */
function revealNow() {
  if (!App.drawId) return;
  clearTimers();
  setCharging(false);
  clearFx();
  const result = App.snapshot?.draw?.activeResult;
  const students = result ? result.students : null;
  if (!students) return;
  if (App.stage) App.stage.stopSpin();
  renderResultStatic(students);
  App.renderedDrawId = result.drawId;
  finishReveal({ drawId: App.drawId });
}

/* ---- 静态结果（RESULT / ROUND_COMPLETE / 恢复） ---- */
function renderResultStatic(students) {
  App.winners = (students || []).slice();
  App.revealedWinners = App.winners.slice();
  App.revealedCount = App.winners.length;
  if (App.stage && App.winners.length) {
    App.stage.setWinners(App.winners, App.winners.map((s) => s.id));
  }
  const box = $("result-cards");
  if (!box) return;
  box.innerHTML = "";
  if (!App.winners.length) {
    hideResultOverlay();
    return;
  }
  showResultOverlay();
  App.winners.forEach((student, index) => appendResultChip(student, index, index === 0, false));
}

function showResultOverlay() {
  const overlay = $("result-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  const count = $("result-count");
  if (count) count.textContent = `${App.revealedWinners.length} / ${Math.max(1, App.winners.length)} 人`;
}

function hideResultOverlay() {
  const overlay = $("result-overlay");
  if (overlay) overlay.classList.add("hidden");
  const box = $("result-cards");
  if (box) box.innerHTML = "";
  App.revealedWinners = [];
}

function appendResultChip(student, index, isLeader, animate = true) {
  const box = $("result-cards");
  if (!box) return;
  const chip = document.createElement("div");
  chip.className = "result-chip" + (isLeader ? " leader" : "");
  const colors = RESULT_CHIP_COLORS[index % RESULT_CHIP_COLORS.length];
  chip.style.setProperty("--chip-a", colors[0]);
  chip.style.setProperty("--chip-b", colors[1]);
  chip.style.setProperty("--chip-deep", colors[2]);
  if (!animate) chip.style.animation = "none";
  chip.innerHTML =
    `<span class="chip-tag">${isLeader ? "首位定格" : "同批中选"}</span>` +
    `<span class="chip-name">${esc(student.name)}</span>` +
    (student.studentNo ? `<span class="chip-no">${esc(student.studentNo)} 号</span>` : "");
  box.appendChild(chip);
}

/* ---- 特效（有上限，自动清理，§7.4；全部落在 #fx-layer 内随舞台裁剪） ---- */
function setCharging(on) {
  const stage = $("stage");
  if (stage) stage.classList.toggle("charging", !!on);
}

function clearFx() {
  const fx = $("fx-layer");
  if (fx) fx.innerHTML = "";
}

function fxCount(sel) {
  const fx = $("fx-layer");
  return fx ? fx.querySelectorAll(sel).length : 0;
}

/* 揭晓一瞬间：光环扩散 + 星点爆开 + 卡片下沿纸屑 */
function spawnBurst(card, idx) {
  const fx = $("fx-layer");
  if (!fx) return;
  const cx = card.offsetLeft + card.offsetWidth / 2;
  const cy = card.offsetTop + card.offsetHeight / 2;

  if (fxCount(".ripple") < 6) {
    const ring = document.createElement("div");
    ring.className = "ripple";
    const size = Math.max(card.offsetWidth, card.offsetHeight) + 28;
    ring.style.width = size + "px";
    ring.style.height = size + "px";
    ring.style.left = cx + "px";
    ring.style.top = cy + "px";
    ring.style.setProperty("--ring-color", CANDY_COLORS[idx % CANDY_COLORS.length]);
    fx.appendChild(ring);
    setTimeout(() => ring.remove(), 720);
  }

  for (let i = 0; i < 7; i++) {
    if (fxCount(".spark") > 60) break;                 // 粒子上限
    const sp = document.createElement("div");
    sp.className = "spark";
    const ang = (Math.PI * 2 * i) / 7 + Math.random() * 0.5;
    const dist = 34 + Math.random() * 36;
    sp.style.left = cx + "px";
    sp.style.top = cy + "px";
    sp.style.setProperty("--dx", (Math.cos(ang) * dist).toFixed(1) + "px");
    sp.style.setProperty("--dy", (Math.sin(ang) * dist).toFixed(1) + "px");
    sp.style.setProperty("--rot", Math.round(180 + Math.random() * 260) + "deg");
    sp.style.setProperty("--spark-color", CANDY_COLORS[i % CANDY_COLORS.length]);
    sp.style.animationDelay = (Math.random() * 0.08).toFixed(2) + "s";
    fx.appendChild(sp);
    setTimeout(() => sp.remove(), 920);
  }

  spawnConfetti(cx, card.offsetTop + card.offsetHeight - 6, 6);
}

/* 纸屑：多形状 + 多色 + 抛物线，从给定坐标散开（§7.4 有上限并自动清理） */
const CONFETTI_SHAPES = ["shape-square", "shape-circle", "shape-ribbon", "shape-star"];

function spawnConfetti(x, y, count) {
  const fx = $("fx-layer");
  if (!fx) return;
  for (let i = 0; i < count; i++) {
    if (fxCount(".confetti") > 70) break;              // 上限
    const p = document.createElement("div");
    p.className = "confetti " + CONFETTI_SHAPES[(i + count) % CONFETTI_SHAPES.length];
    p.style.left = (x + (Math.random() - 0.5) * 44).toFixed(1) + "px";
    p.style.top = y + "px";
    p.style.setProperty("--cc", CANDY_COLORS[(i + count + 1) % CANDY_COLORS.length]);
    p.style.setProperty("--dx", ((Math.random() - 0.5) * 92).toFixed(1) + "px");
    p.style.setProperty("--dy", (36 + Math.random() * 62).toFixed(1) + "px");
    p.style.setProperty("--dur", (0.95 + Math.random() * 0.45).toFixed(2) + "s");
    p.style.animationDelay = (Math.random() * 0.12).toFixed(2) + "s";
    fx.appendChild(p);
    setTimeout(() => p.remove(), 1800);
  }
}

/* 一轮点完：舞台上沿三处齐发纸屑 */
function celebrateRound() {
  const stage = $("stage");
  if (!stage) return;
  const w = stage.clientWidth || 600;
  for (let i = 0; i < 3; i++) {
    spawnConfetti(w * (0.24 + i * 0.26), 30, 8);
  }
}

/* ============ 管理视图 ============ */
function moveTabIndicator() {
  const indicator = $("seg-indicator");
  const active = document.querySelector(".manage-tabs .tab.active");
  if (!indicator || !active) return;
  const w = active.offsetWidth;
  if (!w) return;                       // 视图不可见时量不到宽度，等可见再摆
  indicator.style.width = w + "px";
  indicator.style.left = active.offsetLeft + "px";
}

function bindManageControls() {
  // Tabs（粘土分段控件：指示器滑到当前项）
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      ["list", "tools", "settings"].forEach((k) => {
        $(`tab-${k}`).classList.toggle("hidden", k !== t.dataset.tab);
      });
      moveTabIndicator();
    };
  });

  // 返回点名：同一窗口内切回点名视图（AT-39）
  $("btn-close-manage").onclick = () => showView("roll");

  // 名单编辑
  $("btn-add").onclick = addStudent;
  $("btn-paste").onclick = () => $("paste-panel").classList.toggle("hidden");
  $("btn-paste-cancel").onclick = () => $("paste-panel").classList.add("hidden");
  $("btn-paste-preview").onclick = previewPaste;
  $("btn-import").onclick = importFile;
  $("btn-import-cancel").onclick = () => $("import-panel").classList.add("hidden");
  $("btn-import-commit").onclick = commitImport;

  // 更多工具
  $("btn-export-xlsx").onclick = () => api().export_students("xlsx");
  $("btn-export-csv").onclick = () => api().export_students("csv");

  // 设置
  $("set-anim").oninput = (e) => { $("set-anim-val").textContent = e.target.value + " 秒"; };
  $("set-anim").onchange = async (e) => {
    await api().set_preference("baseAnimationSeconds", parseInt(e.target.value, 10));
  };
  $("set-snap").onchange = async (e) => {
    await api().set_preference("edgeSnap", e.target.checked);
  };
  $("set-sww").onchange = async (e) => {
    // 开机自启：后端写 HKCU Run（§9.2）；失败则回滚勾选并提示
    const r = await api().set_preference("startWithWindows", e.target.checked);
    if (!r?.ok) {
      e.target.checked = !e.target.checked;
      alert(r?.message || "设置开机启动失败");
    }
  };
  $("btn-reset-round").onclick = async () => {
    const r = await api().reset_round(false);
    if (r?.needsConfirm && await confirmDialog(r.message)) {
      await api().reset_round(true);
    }
  };
}

/* ---- 名单渲染 ---- */
function renderManage(snap) {
  $("manage-count").textContent = `${snap.students.length} / 100 人`;
  const list = $("student-list");
  list.innerHTML = "";
  snap.students.forEach((s, i) => {
    const row = document.createElement("div");
    row.className = "student-row";
    row.style.animationDelay = Math.min(i * 18, 320) + "ms";   // 错峰入场
    row.innerHTML = `<span class="idx">${i + 1}</span>` +
      `<span class="s-name">${esc(s.name)}</span>` +
      (s.studentNo ? `<span class="s-no">${esc(s.studentNo)}号</span>` : "") +
      `<span class="flex-spacer"></span>` +
      `<button title="编辑">✏️</button><button class="del" title="删除">🗑️</button>`;
    row.querySelector(".del").onclick = async () => {
      if (await confirmDialog(`删除学生「${s.name}」？\n（提交后本轮点名将重置）`)) {
        // 删除 = 替换为去掉该行的名单
        const draft = snap.students.filter((x) => x.id !== s.id)
          .map((x) => ({ name: x.name, studentNo: x.studentNo, id: x.id }));
        const r = await api().commit_students(draft, "replace", null, true);
        if (r?.ok) refreshSnapshot();
        else alert(r?.message || "删除失败");
      }
    };
    row.querySelector("button:not(.del)").onclick = () => {
      $("inp-name").value = s.name;
      $("inp-no").value = s.studentNo || "";
      $("inp-name").dataset.editId = s.id;
      $("inp-name").focus();
    };
    list.appendChild(row);
  });
  // 设置面板回填
  const st = snap.settings;
  $("set-anim").value = st.baseAnimationSeconds;
  $("set-anim-val").textContent = st.baseAnimationSeconds + " 秒";
  $("set-snap").checked = st.edgeSnap;
  $("set-sww").checked = st.startWithWindows;
  moveTabIndicator();
}

async function addStudent() {
  const name = $("inp-name").value.trim();
  const no = $("inp-no").value.trim();
  if (!name) { alert("姓名不能为空"); return; }
  const snap = App.snapshot;
  const editId = $("inp-name").dataset.editId;

  let draft;
  if (editId) {
    draft = snap.students.map((s) =>
      s.id === editId ? { id: s.id, name, studentNo: no || null } :
        { id: s.id, name: s.name, studentNo: s.studentNo });
    delete $("inp-name").dataset.editId;
  } else {
    draft = snap.students.map((s) => ({ id: s.id, name: s.name, studentNo: s.studentNo }));
    draft.push({ name, studentNo: no || null });
  }
  const r = await api().commit_students(draft, "replace", null, true);
  if (r?.ok) {
    $("inp-name").value = ""; $("inp-no").value = "";
    refreshSnapshot();
  } else {
    alert(r?.message || "提交失败");
  }
}

/* ---- 批量粘贴 ---- */
async function previewPaste() {
  const text = $("paste-area").value;
  if (!text.trim()) { alert("请先粘贴名单"); return; }
  const r = await api().import_from_paste(text);
  if (!r?.ok) { alert(r?.message || "解析失败"); return; }
  showImportPanel(r);
  $("paste-panel").classList.add("hidden");
}

/* ---- Excel/CSV 导入 ---- */
async function importFile() {
  // 后端一次完成：读文件 → 推导列映射 → 预览（无需 fileToken 二次握手）
  const r = await api().import_file_dialog();
  if (!r?.ok) {
    if (r && r.error !== "Cancelled") alert(r.message || "读取文件失败");
    return;
  }
  showImportPanel(r);
}

function showImportPanel(p) {
  App.pendingImport = p;
  $("import-summary").innerHTML =
    `共 <b>${p.totalCount}</b> 条，有效 <b>${p.validCount}</b> 条` +
    (p.emptyNameRows.length ? `，<span class="hint warn">${p.emptyNameRows.length} 条空姓名将跳过</span>` : "") +
    (p.overLimit ? `，<span class="hint warn">⚠️ 超过 100 人上限，提交将被拒绝</span>` : "");
  const box = $("import-issues");
  box.innerHTML = "";
  const decisions = {};
  (p.issues || []).forEach((iss) => {
    decisions[iss.key] = "keep";
    const row = document.createElement("div");
    row.className = `issue-row ${iss.kind}`;
    row.innerHTML = `<span><b>${esc(iss.name)}</b>${iss.studentNo ? " · " + esc(iss.studentNo) + "号" : ""}</span>` +
      `<span class="hint">${esc(iss.detail)}</span><span class="flex-spacer"></span>`;
    const keep = document.createElement("button");
    keep.className = "keep"; keep.textContent = "保留";
    const skip = document.createElement("button");
    skip.className = "skip"; skip.textContent = "跳过";
    keep.onclick = () => { decisions[iss.key] = "keep"; row.classList.remove("skipped"); };
    skip.onclick = () => { decisions[iss.key] = "skip"; row.classList.add("skipped"); };
    row.appendChild(keep); row.appendChild(skip);
    box.appendChild(row);
  });
  App.pendingDecisions = decisions;
  $("import-panel").classList.remove("hidden");
}

async function commitImport() {
  const p = App.pendingImport;
  if (!p) return;
  if (p.overLimit) {
    alert(`有效名单 ${p.validCount} 人，超过上限 ${p.maxStudents} 人，已阻止提交`);
    return;
  }
  const strategy = document.querySelector('input[name="strategy"]:checked').value;
  if (!(await confirmDialog(strategy === "replace"
      ? "替换原名单将重置本轮点名进度，确认提交吗？"
      : "追加名单将重置本轮点名进度，确认提交吗？"))) return;
  const r = await api().commit_students(p.drafts, strategy, App.pendingDecisions, true);
  if (r?.ok) {
    $("import-panel").classList.add("hidden");
    $("paste-area").value = "";
    refreshSnapshot();
  } else {
    alert(r?.message || "提交失败");
  }
}

/* ============ 工具 ============ */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
