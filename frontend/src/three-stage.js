/* Three.js 3D 点名舞台。
 *
 * 结果永远由 Python 锁定，这里只负责把已锁定的名单渲染成 3D 姓名牌并播放
 * 旋转/扫视/定格动画。四种场景：
 *   sphere      星球：仅绕 Y 轴平稳公转，镜头水平、克制推进
 *   cube        魔方：按坐标层真实扭动，最后整体转向中选者
 *   cylinder    轮盘：严格绕 Y 轴旋转，镜头仅做微幅节奏起伏
 *   gallery_3d  展台：展台静止，聚光依次扫过姓名牌
 *
 * 该文件由 esbuild 打包为 frontend/vendor/three-stage.bundle.js（经典脚本），
 * 避免 pywebview 以 file:// 加载时遇到 ES Module/CORS 限制。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

const TAU = Math.PI * 2;
const CARD_W = 60;
const CARD_H = 30;
const CUBE_HALF = 126;
const SPHERE_RADIUS = 232;
const SPHERE_MAX_LAT = 0.62;
const GALLERY_COLS_MAX = 9;

const CARD_PALETTE = [
  ['#4f46e5', '#0ea5e9'],
  ['#db2777', '#7c3aed'],
  ['#0e7490', '#2563eb'],
  ['#c026d3', '#db2777'],
  ['#0f766e', '#0d9488'],
  ['#b45309', '#ea580c'],
];

const CUBE_MOVES = [
  { axis: 'y', layer: 1, angle: 1 },
  { axis: 'x', layer: -1, angle: 1 },
  { axis: 'z', layer: 1, angle: -1 },
  { axis: 'y', layer: -1, angle: -1 },
  { axis: 'x', layer: 1, angle: 1 },
  { axis: 'z', layer: -1, angle: 1 },
  { axis: 'y', layer: 0, angle: 1 },
  { axis: 'z', layer: 0, angle: -1 },
  { axis: 'x', layer: 0, angle: 1 },
  { axis: 'y', layer: 1, angle: -1 },
  { axis: 'z', layer: 1, angle: 1 },
  { axis: 'x', layer: -1, angle: -1 },
  { axis: 'y', layer: -1, angle: 1 },
  { axis: 'x', layer: 1, angle: -1 },
];

const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
const easeOutQuart = (p) => 1 - Math.pow(1 - p, 4);
const easeInOutCubic = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

class ThreeStage {
  constructor(container, options = {}) {
    if (!container) throw new Error('ThreeStage 需要容器元素');
    this.container = container;
    this.onSelectStudent = options.onSelectStudent || null;
    this.onComplete = null;
    this.mode = 'sphere';
    this.students = [];
    this.studentsKey = '';
    this.winners = [];
    this.revealedWinnerIds = new Set();
    this.spinning = false;
    this.spinDuration = 4;
    this.spinElapsed = 0;
    this.spinCompleted = true;
    this.targetStudent = null;
    this.cameraBaseZ = 560;
    this.cameraZ = 560;
    this.cameraLook = new THREE.Vector3(0, 0, 0);
    this.cameraLookTarget = new THREE.Vector3(0, 0, 0);
    this.hoveredMesh = null;
    this.drag = null;
    this.dragVelocity = new THREE.Vector2();
    this.isDragging = false;
    this.reducedMotion = typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.isHeadless = typeof navigator !== 'undefined' &&
      (navigator.webdriver || /HeadlessChrome/i.test(navigator.userAgent));

    this._initScene();
    this._bindPointer();
    this._resize();
    this.resizeObserver = new ResizeObserver(() => this._resize());
    this.resizeObserver.observe(this.container);
    this._boundResize = () => this._resize();
    window.addEventListener('resize', this._boundResize);
    this._lastFrame = performance.now();
    this._raf = requestAnimationFrame((now) => this._animate(now));
  }

  /* ================= 公共 API ================= */

  setStudents(students) {
    const list = Array.isArray(students) ? students : [];
    const key = list.map((s) => `${s.id}:${s.name}:${s.studentNo || ''}`).join('|');
    if (key === this.studentsKey) return;
    this.studentsKey = key;
    this.students = list.map((s) => ({
      id: String(s.id),
      name: String(s.name),
      studentNo: s.studentNo == null ? '' : String(s.studentNo),
    }));
    this._resetView();
    this._rebuildPlacards(true);
  }

  setMode(mode) {
    const next = ['sphere', 'cube', 'cylinder', 'gallery_3d'].includes(mode) ? mode : 'sphere';
    if (next === this.mode && this.placardItems.length) return;
    this.mode = next;
    this._resetView();
    this._rebuildPlacards(true);
  }

  setWinners(winners, revealedIds) {
    this.winners = Array.isArray(winners) ? winners.slice() : [];
    this.revealedWinnerIds = new Set(
      Array.isArray(revealedIds)
        ? revealedIds
        : this.winners.slice(0, 1).map((s) => String(s.id))
    );
    this.targetStudent = this.winners[0] || null;
  }

  revealWinners(winners, ids) {
    this.winners = Array.isArray(winners) ? winners.slice() : this.winners;
    this.revealedWinnerIds = new Set((ids || []).map(String));
    this.targetStudent = this.winners[0] || this.targetStudent;
  }

  clearWinners() {
    this.winners = [];
    this.revealedWinnerIds.clear();
    this.targetStudent = null;
  }

  startSpin(winners, duration, onComplete) {
    if (!this.students.length || !Array.isArray(winners) || !winners.length) return;
    this.winners = winners.slice();
    this.targetStudent = this.winners[0];
    this.revealedWinnerIds = new Set([String(this.targetStudent.id)]);
    this.spinDuration = Math.max(0.9, Number(duration) || 4);
    if (this.reducedMotion) this.spinDuration = Math.min(this.spinDuration, 1.2);
    this.spinElapsed = 0;
    this.spinCompleted = false;
    this.spinning = true;
    this.onComplete = onComplete || null;
    this._prepareModeSpin();
  }

  stopSpin() {
    if (!this.spinning) return;
    this.spinning = false;
    this.spinCompleted = true;
    this.onComplete = null;
    this._snapSpinToTarget();
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    if (this.resizeObserver) this.resizeObserver.disconnect();
    window.removeEventListener('resize', this._boundResize);
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    this.container.removeEventListener('pointerdown', this._onPointerDown);
    this._disposePlacards();
    this.starGeo.dispose();
    this.starMat.dispose();
    this.ringGeo.dispose();
    this.ringMat.dispose();
    this.cubeGeo.dispose();
    this.cubeMat.dispose();
    this.beamGeo.dispose();
    this.beamMat1.dispose();
    this.beamTex1.dispose();
    this.beamMat2.dispose();
    this.beamTex2.dispose();
    this.spotRingGeo.dispose();
    this.spotRingMat.dispose();
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }

  /* ================= 场景初始化 ================= */

  _initScene() {
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x060b18, 0.0009);
    this.scene = scene;

    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera = new THREE.PerspectiveCamera(45, width / height, 1, 4200);
    this.camera.position.set(0, 0, 560);

    const renderer = new THREE.WebGLRenderer({
      antialias: !this.isHeadless,
      alpha: true,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(this.isHeadless ? 1 : Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;
    renderer.shadowMap.enabled = !this.isHeadless;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer = renderer;
    this.container.appendChild(renderer.domElement);

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    scene.add(new THREE.HemisphereLight(0xa5b4fc, 0x11162a, 1.05));
    const dirLight = new THREE.DirectionalLight(0xfff7ed, 1.9);
    dirLight.position.set(220, 380, 420);
    dirLight.castShadow = !this.isHeadless;
    scene.add(dirLight);

    this.spotlight = new THREE.SpotLight(0xfef08a, 3.4, 1200, Math.PI / 4, 0.42);
    this.spotlight.position.set(0, 60, 460);
    this.spotlight.target.position.set(0, 0, 0);
    scene.add(this.spotlight, this.spotlight.target);

    this.searchlight = new THREE.SpotLight(0x38bdf8, 2.6, 1300, Math.PI / 5, 0.42);
    this.searchlight.position.set(-180, 120, 480);
    this.searchlight.target.position.set(0, 0, 0);
    scene.add(this.searchlight, this.searchlight.target);

    this._initStarfield();
    this._initBeams();

    this.placardsGroup = new THREE.Group();
    scene.add(this.placardsGroup);
    this.placardItems = [];

    this.ringGeo = new THREE.TorusGeometry(268, 2.2, 16, 140);
    this.ringMat = new THREE.MeshStandardMaterial({
      color: 0x818cf8,
      emissive: 0x4338ca,
      emissiveIntensity: 1.05,
      metalness: 0.55,
      roughness: 0.3,
      transparent: true,
      opacity: 0.72,
    });
    this.orbitRing = new THREE.Mesh(this.ringGeo, this.ringMat);
    this.orbitRing.rotation.x = Math.PI / 2.35;
    this.orbitRing.rotation.z = 0.18;
    this.placardsGroup.add(this.orbitRing);

    this.cubeGeo = new THREE.BoxGeometry(CUBE_HALF * 2, CUBE_HALF * 2, CUBE_HALF * 2);
    this.cubeMat = new THREE.LineBasicMaterial({
      color: 0x818cf8,
      transparent: true,
      opacity: 0.48,
    });
    this.cubeWire = new THREE.LineSegments(new THREE.EdgesGeometry(this.cubeGeo), this.cubeMat);
    this.placardsGroup.add(this.cubeWire);

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  _initStarfield() {
    const count = this.isHeadless ? 420 : 1100;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const radius = 420 + Math.random() * 1150;
      const theta = Math.random() * TAU;
      const phi = Math.acos(1 - 2 * Math.random());
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
      color.setHSL(0.55 + Math.random() * 0.18, 0.55, 0.62 + Math.random() * 0.28);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    this.starGeo = new THREE.BufferGeometry();
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.starMat = new THREE.PointsMaterial({
      size: 2.15,
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      sizeAttenuation: true,
    });
    this.starPoints = new THREE.Points(this.starGeo, this.starMat);
    this.scene.add(this.starPoints);
  }

  _initBeams() {
    const makeBeamTexture = (r, g, b) => {
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 512;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 0, 512);
      gradient.addColorStop(0, `rgba(${r},${g},${b},0.42)`);
      gradient.addColorStop(0.18, `rgba(${r},${g},${b},0.28)`);
      gradient.addColorStop(0.62, `rgba(${r},${g},${b},0.09)`);
      gradient.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 128, 512);
      return new THREE.CanvasTexture(canvas);
    };
    this.beamGeo = new THREE.CylinderGeometry(8, 72, 1, 28, 1, true);
    this.beamTex1 = makeBeamTexture(254, 240, 138);
    this.beamMat1 = new THREE.MeshBasicMaterial({
      map: this.beamTex1,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beamMesh1 = new THREE.Mesh(this.beamGeo, this.beamMat1);
    this.beamOrigin1 = new THREE.Vector3(0, 420, 230);
    this.beamMesh1.visible = false;
    this.scene.add(this.beamMesh1);

    this.beamTex2 = makeBeamTexture(56, 189, 248);
    this.beamMat2 = new THREE.MeshBasicMaterial({
      map: this.beamTex2,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.beamMesh2 = new THREE.Mesh(this.beamGeo, this.beamMat2);
    this.beamOrigin2 = new THREE.Vector3(-210, 390, 260);
    this.beamMesh2.visible = false;
    this.scene.add(this.beamMesh2);

    this.spotRingGeo = new THREE.RingGeometry(37, 49, 40);
    this.spotRingMat = new THREE.MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.82,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.spotRing = new THREE.Mesh(this.spotRingGeo, this.spotRingMat);
    this.spotRing.visible = false;
    this.scene.add(this.spotRing);
  }

  /* ================= 姓名牌 ================= */

  _createCardTexture(student, index) {
    const canvas = document.createElement('canvas');
    canvas.width = 360;
    canvas.height = 180;
    const ctx = canvas.getContext('2d');
    const radius = 30;
    const colors = CARD_PALETTE[index % CARD_PALETTE.length];

    ctx.beginPath();
    ctx.moveTo(radius, 1);
    ctx.lineTo(canvas.width - radius, 1);
    ctx.quadraticCurveTo(canvas.width - 1, 1, canvas.width - 1, radius);
    ctx.lineTo(canvas.width - 1, canvas.height - radius);
    ctx.quadraticCurveTo(canvas.width - 1, canvas.height - 1, canvas.width - radius, canvas.height - 1);
    ctx.lineTo(radius, canvas.height - 1);
    ctx.quadraticCurveTo(1, canvas.height - 1, 1, canvas.height - radius);
    ctx.lineTo(1, radius);
    ctx.quadraticCurveTo(1, 1, radius, 1);
    ctx.closePath();

    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, colors[0]);
    gradient.addColorStop(1, colors[1]);
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(255,255,255,0.52)';
    ctx.stroke();

    const shine = ctx.createLinearGradient(0, 0, 0, canvas.height);
    shine.addColorStop(0, 'rgba(255,255,255,0.28)');
    shine.addColorStop(0.5, 'rgba(255,255,255,0.03)');
    shine.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = shine;
    ctx.fill();

    // 深色姓名托底：即使被聚光灯照到，也能保持白色姓名的对比度
    const plateX = 28;
    const plateY = 34;
    const plateW = canvas.width - plateX * 2;
    const plateH = 94;
    const plateR = 24;
    ctx.beginPath();
    ctx.moveTo(plateX + plateR, plateY);
    ctx.lineTo(plateX + plateW - plateR, plateY);
    ctx.quadraticCurveTo(plateX + plateW, plateY, plateX + plateW, plateY + plateR);
    ctx.lineTo(plateX + plateW, plateY + plateH - plateR);
    ctx.quadraticCurveTo(plateX + plateW, plateY + plateH, plateX + plateW - plateR, plateY + plateH);
    ctx.lineTo(plateX + plateR, plateY + plateH);
    ctx.quadraticCurveTo(plateX, plateY + plateH, plateX, plateY + plateH - plateR);
    ctx.lineTo(plateX, plateY + plateR);
    ctx.quadraticCurveTo(plateX, plateY, plateX + plateR, plateY);
    ctx.closePath();
    const plateGradient = ctx.createLinearGradient(0, plateY, 0, plateY + plateH);
    plateGradient.addColorStop(0, 'rgba(9, 14, 29, 0.82)');
    plateGradient.addColorStop(1, 'rgba(9, 14, 29, 0.68)');
    ctx.fillStyle = plateGradient;
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.46)';
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const name = student.name || '？';
    const fontSize = name.length <= 3 ? 58 : name.length <= 4 ? 48 : name.length <= 6 ? 39 : 32;
    ctx.font = `900 ${fontSize}px "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif`;
    ctx.shadowColor = 'rgba(0,0,0,0.92)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 3;
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgba(8,13,28,0.9)';
    ctx.strokeText(name, canvas.width / 2, 86);
    ctx.fillStyle = '#ffffff';
    ctx.fillText(name, canvas.width / 2, 86);
    ctx.shadowColor = 'transparent';

    if (student.studentNo) {
      ctx.font = '700 22px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.82)';
      ctx.fillText(`${student.studentNo} 号`, canvas.width / 2, 145);
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    return texture;
  }

  _rebuildPlacards(triggerFlyIn) {
    this._disposePlacards();
    const count = this.students.length;
    this.orbitRing.visible = this.mode === 'sphere';
    this.cubeWire.visible = this.mode === 'cube';
    if (!count) return;

    const cardGeo = new THREE.PlaneGeometry(CARD_W, CARD_H);
    this.students.forEach((student, index) => {
      const texture = this._createCardTexture(student, index);
      const material = new THREE.MeshStandardMaterial({
        map: texture,
        transparent: true,
        roughness: 0.56,
        metalness: 0.03,
        side: THREE.FrontSide,
        emissive: 0x000000,
        emissiveIntensity: 0,
      });
      const mesh = new THREE.Mesh(cardGeo, material);
      mesh.castShadow = !this.isHeadless;
      mesh.receiveShadow = !this.isHeadless;
      const basePos = new THREE.Vector3();
      const baseRot = new THREE.Euler();
      this._layoutStudent(index, count, basePos, baseRot);
      mesh.position.copy(basePos);
      mesh.rotation.copy(baseRot);

      const flyInOffset = triggerFlyIn
        ? new THREE.Vector3(
          (Math.random() - 0.5) * 760,
          (Math.random() - 0.5) * 560,
          (Math.random() + 0.4) * 620
        )
        : new THREE.Vector3();
      if (triggerFlyIn) mesh.position.add(flyInOffset);

      mesh.userData = { student, studentId: student.id };
      this.placardsGroup.add(mesh);
      this.placardItems.push({
        mesh,
        mat: material,
        texture,
        student,
        basePos,
        baseRot,
        flyInOffset,
        flyInProgress: triggerFlyIn ? 0 : 1,
      });
    });

    this.cameraBaseZ = this._cameraDistanceForMode();
    this.cameraZ = this.cameraBaseZ;
    this._updateCameraBase(true);
  }

  _layoutStudent(index, count, pos, rot) {
    if (this.mode === 'sphere') {
      const phi = Math.acos(Math.sin(SPHERE_MAX_LAT) * (1 - (2 * (index + 0.5)) / count));
      const theta = Math.PI * (1 + Math.sqrt(5)) * index;
      pos.set(
        SPHERE_RADIUS * Math.sin(phi) * Math.cos(theta),
        SPHERE_RADIUS * Math.cos(phi),
        SPHERE_RADIUS * Math.sin(phi) * Math.sin(theta)
      );
      this._faceOutward(pos, rot, 2);
      return;
    }

    if (this.mode === 'cube') {
      const face = index % 6;
      const sub = Math.floor(index / 6);
      const perFace = Math.ceil(count / 6);
      const cols = Math.ceil(Math.sqrt(perFace));
      const rows = Math.ceil(perFace / cols);
      const col = sub % cols;
      const row = Math.floor(sub / cols);
      const spacingX = 64;
      const spacingY = 62;
      const u = (col - (cols - 1) / 2) * spacingX;
      const v = (row - (rows - 1) / 2) * spacingY;
      const h = CUBE_HALF;
      if (face === 0) { pos.set(u, v, h); rot.set(0, 0, 0); }
      else if (face === 1) { pos.set(-u, v, -h); rot.set(0, Math.PI, 0); }
      else if (face === 2) { pos.set(h, v, -u); rot.set(0, Math.PI / 2, 0); }
      else if (face === 3) { pos.set(-h, v, u); rot.set(0, -Math.PI / 2, 0); }
      else if (face === 4) { pos.set(u, h, -v); rot.set(-Math.PI / 2, 0, 0); }
      else { pos.set(u, -h, v); rot.set(Math.PI / 2, 0, 0); }
      return;
    }

    if (this.mode === 'cylinder') {
      const levels = 3;
      const level = index % levels;
      const perLevel = Math.ceil(count / levels);
      const angle = (Math.floor(index / levels) / perLevel) * TAU;
      const radius = Math.max(232, (perLevel * CARD_W * 1.3) / TAU);
      pos.set(radius * Math.cos(angle), (level - 1) * 78, radius * Math.sin(angle));
      this._faceOutward(pos, rot, 2);
      return;
    }

    const cols = Math.min(GALLERY_COLS_MAX, Math.max(5, Math.ceil(Math.sqrt(count * 1.55))));
    const rows = Math.ceil(count / cols);
    const col = index % cols;
    const row = Math.floor(index / cols);
    const arc = ((col - (cols - 1) / 2) / cols) * 1.4;
    const radius = 390;
    pos.set(
      radius * Math.sin(arc),
      -(row - (rows - 1) / 2) * 45,
      radius * (1 - Math.cos(arc)) - 90
    );
    const target = new THREE.Vector3(0, pos.y * 0.18, 600);
    const matrix = new THREE.Matrix4().lookAt(target, pos, new THREE.Vector3(0, 1, 0));
    rot.setFromRotationMatrix(matrix);
  }

  _faceOutward(pos, rot, factor) {
    const target = this.mode === 'cylinder'
      ? new THREE.Vector3(pos.x * factor, pos.y, pos.z * factor)
      : pos.clone().multiplyScalar(factor);
    const matrix = new THREE.Matrix4().lookAt(target, pos, new THREE.Vector3(0, 1, 0));
    rot.setFromRotationMatrix(matrix);
  }

  _disposePlacards() {
    for (const item of this.placardItems) {
      this.placardsGroup.remove(item.mesh);
      item.mesh.geometry.dispose();
      item.mat.dispose();
      item.texture.dispose();
    }
    this.placardItems = [];
  }

  _cameraDistanceForMode() {
    const count = Math.max(1, this.students.length);
    if (this.mode === 'gallery_3d') {
      return Math.max(570, 450 + Math.ceil(count / 7) * 24);
    }
    if (this.mode === 'cylinder') {
      return Math.max(560, 430 + Math.ceil(count / 9) * 26);
    }
    if (this.mode === 'cube') return 590;
    return Math.max(550, 520 + Math.ceil(count / 30) * 14);
  }

  /* ================= 抽取初始化 ================= */

  _prepareModeSpin() {
    this._resetTransientForSpin();
    if (this.mode === 'sphere' || this.mode === 'cylinder') {
      this.placardsGroup.rotation.x = 0;
      this.placardsGroup.rotation.z = 0;
      this.placardsGroup.quaternion.setFromEuler(this.placardsGroup.rotation);
      const target = this._findItem(this.targetStudent && this.targetStudent.id);
      const azimuth = target ? Math.atan2(target.basePos.x, target.basePos.z) : 0;
      const desired = -azimuth;
      const start = this.placardsGroup.rotation.y;
      const shortest = ((desired - start) % TAU + TAU) % TAU;
      const turns = this.mode === 'cylinder'
        ? 5 + Math.round(this.spinDuration * 0.45)
        : 4 + Math.round(this.spinDuration * 0.3);
      this.spinStartY = start;
      this.spinTargetY = start + shortest + turns * TAU;
      this.spinGroundMode = true;
      this.cubeState = null;
      this.galleryState = null;
      return;
    }

    if (this.mode === 'cube') {
      this._initCubeSpin();
      return;
    }

    this._initGallerySpin();
  }

  _resetTransientForSpin() {
    this._hideBeams();
    this.spotRing.visible = false;
    this.hoveredMesh = null;
    this.isDragging = false;
  }

  _initCubeSpin() {
    const preRoll = Math.min(0.28, this.spinDuration * 0.12);
    const moveZone = this.spinDuration * 0.76 - preRoll;
    const moveCount = Math.max(7, Math.min(CUBE_MOVES.length, Math.round(this.spinDuration * 2.2)));
    const moves = CUBE_MOVES.slice(0, moveCount).map((m, i) => ({
      ...m,
      angle: (m.angle || 1) * (i % 4 === 3 ? Math.PI : Math.PI / 2),
    }));
    const perMove = Math.max(0.13, moveZone / Math.max(1, moves.length));
    this.cubeState = {
      preRoll,
      preRollElapsed: 0,
      fromQuat: this.placardsGroup.quaternion.clone(),
      moves,
      moveIndex: 0,
      turning: false,
      turnElapsed: 0,
      turnDuration: Math.max(0.1, perMove * 0.76),
      pause: Math.max(0.02, perMove * 0.24),
      pauseElapsed: 0,
      activeTurn: null,
      finalElapsed: 0,
      finalDuration: Math.max(0.28, this.spinDuration * 0.22),
      finalQuat: new THREE.Quaternion(),
      finalizing: false,
    };
    this.placardsGroup.quaternion.identity();
  }

  _initGallerySpin() {
    const targetIndex = Math.max(0, this.placardItems.findIndex((p) =>
      this.targetStudent && p.student.id === String(this.targetStudent.id)));
    this.galleryState = {
      scanIndex: targetIndex,
      lastScanAt: 0,
      targetIndex,
      cameraIndex: targetIndex,
    };
  }

  /* ================= 帧循环 ================= */

  _animate(now) {
    this._raf = requestAnimationFrame((t) => this._animate(t));
    const delta = Math.min(0.05, Math.max(0, (now - this._lastFrame) / 1000));
    this._lastFrame = now;
    this._updateFlyIns(delta);

    if (this.spinning) {
      this.spinElapsed += delta;
      const progress = Math.min(1, this.spinElapsed / this.spinDuration);
      if (this.mode === 'sphere' || this.mode === 'cylinder') {
        this._updateGroundSpin(progress);
      } else if (this.mode === 'cube') {
        this._updateCubeSpin(delta, progress);
      } else {
        this._updateGallerySpin(now, progress);
      }
      if (progress >= 1) this._finishSpin();
    } else {
      this._updateIdle(delta, now);
    }

    this.starPoints.rotation.y -= 0.018 * delta;
    this._updateWinnerVisuals(now);
    this._updateCamera(delta, now);
    this.renderer.render(this.scene, this.camera);
  }

  _updateFlyIns(delta) {
    for (const item of this.placardItems) {
      if (item.flyInProgress >= 1) continue;
      item.flyInProgress = Math.min(1, item.flyInProgress + delta * 1.55);
      const eased = 1 - Math.pow(1 - item.flyInProgress, 3);
      item.mesh.position.lerpVectors(
        item.basePos.clone().add(item.flyInOffset),
        item.basePos,
        eased
      );
    }
  }

  _updateGroundSpin(progress) {
    const eased = this.mode === 'cylinder' ? easeOutQuart(progress) : easeOutCubic(progress);
    this.placardsGroup.rotation.x = 0;
    this.placardsGroup.rotation.z = 0;
    this.placardsGroup.rotation.y = this.spinStartY + (this.spinTargetY - this.spinStartY) * eased;
    if (this.mode === 'cylinder') {
      this.cameraBounce = Math.sin(this.spinElapsed * 24) * 1.6 * (1 - progress);
    } else {
      this.cameraBounce = 0;
    }
    this.cameraPush = (this.mode === 'cylinder' ? 30 : 44) * easeOutCubic(progress);
  }

  _updateCubeSpin(delta, progress) {
    const c = this.cubeState;
    if (!c) return;
    if (c.preRollElapsed < c.preRoll) {
      c.preRollElapsed += delta;
      const p = Math.min(1, c.preRollElapsed / c.preRoll);
      this.placardsGroup.quaternion.copy(c.fromQuat).slerp(new THREE.Quaternion(), easeInOutCubic(p));
    } else if (!c.finalizing) {
      if (c.turning) {
        c.turnElapsed += delta;
        const p = Math.min(1, c.turnElapsed / c.turnDuration);
        this._applyCubeTurn(c.activeTurn, easeInOutCubic(p));
        if (p >= 1) {
          this._bakeCubeTurn(c.activeTurn);
          c.turning = false;
          c.activeTurn = null;
          c.moveIndex += 1;
          c.pauseElapsed = 0;
          this.cameraBounce = 2.2;
        }
      } else if (c.moveIndex < c.moves.length) {
        c.pauseElapsed += delta;
        if (c.pauseElapsed >= c.pause) {
          this._startCubeTurn(c.moves[c.moveIndex]);
          c.turning = true;
          c.turnElapsed = 0;
        }
      } else {
        this._beginCubeFinale();
      }
    } else {
      c.finalElapsed += delta;
      const p = Math.min(1, c.finalElapsed / c.finalDuration);
      this.placardsGroup.quaternion.copy(new THREE.Quaternion()).slerp(c.finalQuat, easeInOutCubic(p));
    }
    this.cameraPush = 26 * easeOutCubic(progress);
  }

  _startCubeTurn(move) {
    const axis = new THREE.Vector3(move.axis === 'x' ? 1 : 0, move.axis === 'y' ? 1 : 0, move.axis === 'z' ? 1 : 0);
    const selected = this.placardItems.filter((item) => {
      const value = item.basePos[move.axis];
      if (move.layer === -1) return value < -58;
      if (move.layer === 1) return value > 58;
      return Math.abs(value) <= 58;
    });
    this.cubeState.activeTurn = {
      axis,
      angle: move.angle,
      items: selected.map((item) => ({
        item,
        pos: item.basePos.clone(),
        quat: new THREE.Quaternion().setFromEuler(item.baseRot),
      })),
    };
  }

  _applyCubeTurn(turn, eased) {
    if (!turn) return;
    const q = new THREE.Quaternion().setFromAxisAngle(turn.axis, turn.angle * eased);
    for (const entry of turn.items) {
      entry.item.mesh.position.copy(entry.pos).applyAxisAngle(turn.axis, turn.angle * eased);
      entry.item.mesh.quaternion.copy(q).multiply(entry.quat);
    }
  }

  _bakeCubeTurn(turn) {
    if (!turn) return;
    for (const entry of turn.items) {
      entry.item.basePos.copy(entry.item.mesh.position);
      entry.item.baseRot.setFromQuaternion(entry.item.mesh.quaternion);
    }
  }

  _beginCubeFinale() {
    const c = this.cubeState;
    c.finalizing = true;
    c.finalElapsed = 0;
    const target = this._findItem(this.targetStudent && this.targetStudent.id);
    if (!target) {
      c.finalQuat.identity();
      return;
    }
    c.finalQuat.setFromEuler(target.baseRot).invert();
  }

  _updateGallerySpin(now, progress) {
    const g = this.galleryState;
    if (!g) return;
    const interval = 55 + (1 - progress) * 260;
    if (now - g.lastScanAt > interval) {
      g.lastScanAt = now;
      g.scanIndex = progress >= 0.86 ? g.targetIndex : Math.floor(Math.random() * Math.max(1, this.placardItems.length));
    }
    g.cameraIndex = g.scanIndex;
    this.cameraPush = 34 * easeOutCubic(progress);
  }

  _finishSpin() {
    if (this.spinCompleted) return;
    this.spinning = false;
    this.spinCompleted = true;
    this._snapSpinToTarget();
    this.cameraBounce = 0;
    const cb = this.onComplete;
    this.onComplete = null;
    if (typeof cb === 'function') cb();
  }

  _snapSpinToTarget() {
    if (this.mode === 'sphere' || this.mode === 'cylinder') {
      this.placardsGroup.rotation.x = 0;
      this.placardsGroup.rotation.z = 0;
      this.placardsGroup.rotation.y = this.spinTargetY || this.placardsGroup.rotation.y;
      this.cameraBounce = 0;
      return;
    }
    if (this.mode === 'cube') {
      const c = this.cubeState;
      if (!c) return;
      if (c.turning && c.activeTurn) {
        this._applyCubeTurn(c.activeTurn, 1);
        this._bakeCubeTurn(c.activeTurn);
        c.turning = false;
        c.activeTurn = null;
      }
      if (!c.finalizing) this._beginCubeFinale();
      this.placardsGroup.quaternion.copy(c.finalQuat);
      return;
    }
    if (this.galleryState) this.galleryState.scanIndex = this.galleryState.targetIndex;
  }

  _updateIdle(delta, now) {
    if (this.winners.length) {
      this.cameraBounce = 0;
      return;
    }
    this.cameraBounce = 0;
    if (this.mode === 'sphere' || this.mode === 'cylinder') {
      this.placardsGroup.rotation.y += 0.11 * delta;
      this.placardsGroup.rotation.x = 0;
      this.placardsGroup.rotation.z = 0;
    }
  }

  /* ================= 高亮与镜头 ================= */

  _updateWinnerVisuals(now) {
    const primaryId = this.targetStudent ? String(this.targetStudent.id) : null;
    const revealed = this.revealedWinnerIds;
    let primaryItem = null;
    let scanItem = null;
    if (this.spinning && this.mode === 'gallery_3d' && this.galleryState) {
      scanItem = this.placardItems[this.galleryState.scanIndex] || null;
    }

    for (const item of this.placardItems) {
      const id = item.student.id;
      const isWinner = revealed.has(id) && !this.spinning;
      const isPrimary = isWinner && id === primaryId;
      const isScan = scanItem === item;
      const isHovered = this.hoveredMesh === item.mesh && !this.spinning;
      if (isPrimary) {
        const scale = 1.46 + Math.sin(now * 0.007) * 0.06;
        item.mesh.scale.setScalar(scale);
        item.mat.emissive.setHex(0xf59e0b);
        item.mat.emissiveIntensity = 0.14;
        primaryItem = item;
      } else if (isWinner) {
        item.mesh.scale.setScalar(1.18);
        item.mat.emissive.setHex(0xfbbf24);
        item.mat.emissiveIntensity = 0.1;
      } else if (isScan) {
        item.mesh.scale.setScalar(1.16);
        item.mat.emissive.setHex(0x38bdf8);
        item.mat.emissiveIntensity = 0.16;
      } else if (isHovered) {
        item.mesh.scale.setScalar(1.1);
        item.mat.emissive.setHex(0x6366f1);
        item.mat.emissiveIntensity = 0.24;
      } else {
        item.mesh.scale.setScalar(1);
        item.mat.emissive.setHex(0x000000);
        item.mat.emissiveIntensity = 0;
      }
    }

    const focusItem = primaryItem || scanItem;
    if (focusItem) {
      const world = new THREE.Vector3();
      focusItem.mesh.getWorldPosition(world);
      this.spotlight.target.position.copy(world);
      this.spotlight.intensity = this.spinning ? 1.85 : 1.55;
      this.spotlight.color.setHex(primaryItem ? 0xfbbf24 : 0x7dd3fc);
      this.searchlight.target.position.set(world.x * 0.7 - 30, world.y * 0.7 + 22, world.z);
      this.searchlight.intensity = this.spinning ? 1.15 : 1.0;
      this.spotRing.visible = !!primaryItem || this.mode === 'gallery_3d';
      if (this.spotRing.visible) {
        this.spotRing.position.copy(world).add(new THREE.Vector3(0, 0, -2));
        focusItem.mesh.getWorldQuaternion(this.spotRing.quaternion);
        this.spotRing.scale.setScalar(1.08 + Math.sin(now * 0.009) * 0.06);
      }
      if (this.mode === 'gallery_3d') {
        this._showBeams(world);
      } else {
        this._hideBeams();
      }
    } else {
      this.spotlight.target.position.set(0, 0, 0);
      this.spotlight.intensity = this.spinning ? 2.1 : 1.6;
      this.searchlight.target.position.set(0, 0, 0);
      this.searchlight.intensity = this.spinning ? 1.4 : 1.0;
      this.spotRing.visible = false;
      this._hideBeams();
    }
  }

  _showBeams(world) {
    this._aimBeam(this.beamMesh1, this.beamOrigin1, world);
    this._aimBeam(this.beamMesh2, this.beamOrigin2, world);
    this.beamMesh1.visible = true;
    this.beamMesh2.visible = true;
  }

  _aimBeam(mesh, origin, target) {
    const dir = target.clone().sub(origin);
    const len = Math.max(1, dir.length());
    mesh.position.copy(origin).addScaledVector(dir, 0.5);
    mesh.scale.set(1, len, 1);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), dir.clone().normalize());
  }

  _hideBeams() {
    if (this.beamMesh1) this.beamMesh1.visible = false;
    if (this.beamMesh2) this.beamMesh2.visible = false;
  }

  _updateCamera(delta, now) {
    const focusItem = this._findItem(this.targetStudent && this.targetStudent.id);
    let targetZ = this.cameraBaseZ;
    let targetX = 0;
    let targetY = 0;
    let lookX = 0;
    let lookY = 0;
    let lookZ = 0;

    if (this.spinning) {
      targetZ -= this.cameraPush || 0;
      if (this.mode === 'cylinder') targetY += this.cameraBounce || 0;
      if (this.mode === 'gallery_3d' && this.galleryState) {
        const scan = this.placardItems[this.galleryState.cameraIndex];
        if (scan) {
          const w = new THREE.Vector3();
          scan.mesh.getWorldPosition(w);
          targetX = w.x * 0.28;
          targetY = w.y * 0.22;
          lookX = w.x * 0.5;
          lookY = w.y * 0.42;
        }
      }
    } else if (this.winners.length && focusItem) {
      const w = new THREE.Vector3();
      focusItem.mesh.getWorldPosition(w);
      if (this.mode === 'gallery_3d') {
        targetZ = Math.min(targetZ, 400);
        targetX = w.x * 0.34;
        targetY = w.y * 0.26;
        lookX = w.x * 0.5;
        lookY = w.y * 0.5;
      } else if (this.mode === 'cube') {
        targetZ = Math.min(targetZ, 500);
        targetX = w.x * 0.16;
        targetY = w.y * 0.12;
        lookX = w.x * 0.32;
        lookY = w.y * 0.3;
      } else {
        targetZ = Math.min(targetZ, 470);
        const focusY = THREE.MathUtils.clamp(w.y, -140, 140);
        targetY = focusY;
        lookY = focusY;
      }
    }

    this.cameraZ = THREE.MathUtils.damp(this.cameraZ, targetZ, 4.2, delta);
    this.camera.position.x = THREE.MathUtils.damp(this.camera.position.x, targetX, 3.4, delta);
    this.camera.position.y = THREE.MathUtils.damp(this.camera.position.y, targetY, 5.6, delta);
    this.camera.position.z = this.cameraZ;
    this.cameraLookTarget.set(lookX, lookY, lookZ);
    this.cameraLook.x = THREE.MathUtils.damp(this.cameraLook.x, lookX, 3.2, delta);
    this.cameraLook.y = THREE.MathUtils.damp(this.cameraLook.y, lookY, 3.2, delta);
    this.cameraLook.z = THREE.MathUtils.damp(this.cameraLook.z, lookZ, 3.2, delta);
    this.camera.lookAt(this.cameraLook);
  }

  _updateCameraBase(immediate) {
    if (immediate) {
      this.cameraZ = this.cameraBaseZ;
      this.camera.position.set(0, 0, this.cameraZ);
      this.cameraLook.set(0, 0, 0);
      this.camera.lookAt(this.cameraLook);
    }
  }

  _findItem(id) {
    if (id == null) return null;
    return this.placardItems.find((item) => item.student.id === String(id)) || null;
  }

  _resetView() {
    if (!this.placardsGroup) return;
    this.placardsGroup.position.set(0, 0, 0);
    this.placardsGroup.rotation.set(0, 0, 0);
    this.placardsGroup.quaternion.identity();
    this.spinStartY = 0;
    this.spinTargetY = 0;
    this.cameraBounce = 0;
    this.cameraPush = 0;
    this.clearWinners();
  }

  /* ================= 指针交互 ================= */

  _bindPointer() {
    this._onPointerDown = (event) => {
      if (this.spinning || this.mode === 'cube') return;
      this.drag = { x: event.clientX, y: event.clientY };
      this.isDragging = true;
    };
    this._onPointerMove = (event) => {
      if (this.drag && !this.spinning && this.mode !== 'cube') {
        const dx = event.clientX - this.drag.x;
        const dy = event.clientY - this.drag.y;
        this.drag.x = event.clientX;
        this.drag.y = event.clientY;
        this.placardsGroup.rotation.y += dx * 0.006;
        this.placardsGroup.rotation.x = Math.max(-0.45, Math.min(0.45, this.placardsGroup.rotation.x + dy * 0.004));
        this.dragVelocity.set(dx * 0.0008, dy * 0.0005);
        return;
      }
      this._updateHover(event);
    };
    this._onPointerUp = () => {
      this.drag = null;
      this.isDragging = false;
    };
    this.container.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointermove', this._onPointerMove);
    window.addEventListener('pointerup', this._onPointerUp);
  }

  _updateHover(event) {
    if (this.spinning || !this.renderer) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.placardItems.map((p) => p.mesh), false)[0];
    this.hoveredMesh = hit ? hit.object : null;
  }

  _resize() {
    if (!this.renderer) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }
}

window.ThreeStage = ThreeStage;
export { ThreeStage };
