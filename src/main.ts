import * as THREE from 'three/webgpu';
import { assetUrl } from './asset-url';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'meshoptimizer';
import { Physics, EYE_HEIGHT, WALK_SPEED, SPRINT_SPEED } from './physics';
import { CoastalAudio } from './audio';
import { createDaylight } from './daylight';
import { createContactLighting } from './contact-lighting';
import { doorAimPoint, slidingDoorPullPoint, INTERACTION_DISTANCE, selectInteractionTarget, type InteractionCandidate } from './interaction';
import { createOutdoor, OUTDOOR_HAZE, type OutdoorScene } from './outdoor';
import { WalkSession, MovementKeys, edgeLookVelocity } from './walk-session';
import { createInteriorLighting } from './interior-lighting';
import { createCrew, type CrewScene } from './crew';
import { doorColliderTransforms, doorAnimationAmount, elevatorGateCanOpen, garageDoorMotion } from './kinematics';
import { contains, containsXZPolygon, smoothstep, validateScene, type SceneData, type Vec3, type Door } from './schema';
import './style.css';
import { installVisualQA } from './visual-qa';
import { createNeighborhoodContext, type NeighborhoodSelection } from './neighborhood-context';

const icons = {
  walk: '<path d="m9 22 3-7 4 3v5M7 13l3-5 4 1 3 5 4 1M12 9l-1 6-5 4"/><circle cx="13" cy="4" r="2"/>',
  rooms: '<rect x="3" y="3" width="18" height="18" rx="1"/><path d="M3 12h8m4 0h6M12 3v5m0 8v5"/>',
  floors: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  reset: '<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>',
  home: '<path d="m2 11 10-7 10 7M5 10v10h14V10M10 20v-6h4v6"/>',
};
const svg = (icon: keyof typeof icons) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[icon]}</svg>`;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const phaseOne = params.get('phase') === '1';
let comparisonView=params.get('compare')==='exterior';
const explicitFallback = params.get('renderer') === 'webgl';
const forceTouch = params.get('touch') === '1';
if(forceTouch)document.body.classList.add('touch-preview');
const startedAt = performance.now();

$('app').innerHTML = `
  <main id="viewport" aria-label="Interactive three dimensional architectural walkthrough"></main>
  <header class="hud masthead"><div class="brand-mark">${svg('home')}</div><div><div class="wordmark">Coastal Residence</div><div class="address">Coastal residence walkthrough</div></div></header>
  <div class="hud top-right"><button class="provisional" id="provisional"><span class="dot"></span>Provisional architectural study</button><button id="sound" class="sound-button" aria-pressed="false" aria-label="Turn on original beach ambience">Sound off</button><button id="info" class="icon-button" aria-label="About this model">${svg('info')}</button></div>
  <section class="hud intro" id="intro"><div class="eyebrow">A home, from every perspective</div><h1>Come on in.<br>Take a look around.</h1><div class="line"></div><p>Follow the light from the front porch to the rooftop. Explore three floors of coastal living, at your own pace.</p><button class="primary" id="begin">Begin your walkthrough ${svg('arrow')}</button><div class="intro-footer">Blender-authored architecture · Proposed finishes<br>Neighborhood context and unresolved details are provisional.</div></section>
  <div class="hud location"><div class="eyebrow" id="current-floor">Bonito Lane</div><div id="current-room">Outside the Coastal Residence</div><div class="runtime-line" id="diagnostics" aria-live="polite"><span id="renderer-label">Renderer loading</span><span id="wasm-label">Physics loading</span><span id="fps">— fps</span><button id="quality" aria-label="Change visual quality">High</button></div></div>
  <nav class="hud navigation" aria-label="Walkthrough controls"><button class="nav-button active" id="walk">${svg('walk')}<span>Walk</span></button><button class="nav-button" id="rooms">${svg('rooms')}<span>Rooms</span></button><button class="nav-button" id="floors">${svg('floors')}<span>Floors</span></button><span class="divider"></span><button class="nav-button" id="reset">${svg('reset')}<span>Reset</span></button></nav>
  <div class="hud help"><div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp; <span id="look-help">Click scene to look</span></div><div><kbd>Shift</kbd> sprint &nbsp; <kbd>Space</kbd> jump</div><div><kbd>E</kbd> interact &nbsp; <kbd>Esc</kbd> release</div></div>
  <div class="crosshair"></div><button id="interact" class="hud interaction" hidden></button>
  <aside id="panel" class="panel" aria-labelledby="panel-title" hidden><div class="panel-heading"><div><div class="eyebrow" id="panel-eyebrow">Explore the home</div><h2 id="panel-title">Rooms</h2></div><button id="close-panel" class="close" aria-label="Close panel">${svg('close')}</button></div><p class="panel-description" id="panel-description"></p><div class="panel-content" id="panel-content"></div></aside>
  <div id="toast" class="toast" role="status" hidden></div><div id="plan-caption" class="plan-caption" hidden></div>
  <div class="touch-controls" id="touch-controls"><div id="joystick" class="joystick" role="group" aria-label="Drag to walk"><div id="joystick-knob" class="joystick-knob"></div></div><div class="touch-look-label">Drag to look</div><div class="touch-actions"><button id="touch-sprint" class="touch-action" aria-pressed="false" aria-label="Toggle sprint">Sprint</button><button id="touch-jump" class="touch-action" aria-label="Jump when grounded">Jump</button><button id="touch-interact" class="touch-action">Interact</button></div></div>
  <section id="loading" class="load-screen" aria-live="polite"><div class="load-card"><div class="eyebrow">Bonito Lane · Architectural study</div><h1>Coastal Residence</h1><p id="load-message">A little coastal light. A place to call home.</p><div class="progress-track"><div class="progress-fill" id="progress"></div></div><div class="load-caption" id="load-caption">Preparing the scene</div><button id="fallback" class="primary fallback-button">Continue with WebGL 2</button><p class="loading-detail">Geometry authored in Blender. Physics powered by Rapier WebAssembly.</p></div></section>
`;

let data: SceneData;
let physics: Physics;
let renderer: THREE.WebGPURenderer;
let contactLighting: ReturnType<typeof createContactLighting> | undefined;
let interiorLighting: Awaited<ReturnType<typeof createInteriorLighting>> | undefined;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#dfe9e7');
scene.fog = new THREE.Fog(OUTDOOR_HAZE, 180, 550);
const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.045, 600);
camera.rotation.order = 'YXZ';
const planCamera = new THREE.OrthographicCamera(-12, 12, 12, -12, 0.1, 100);
const hemi = new THREE.HemisphereLight('#dceaff', '#b5a98d', .08);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff4e5', 5.5);
sun.position.set(-28, 42, 22);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {left:-19,right:19,top:21,bottom:-21,near:1,far:110});
sun.shadow.bias = -0.0002;
sun.shadow.normalBias = 0.012;
sun.target.position.set(5, 2, -7);
scene.add(sun, sun.target);
// Indirect sky light supplies fill; a second unshadowed sun flattened recesses.
let house: THREE.Group | undefined;
let neighborhood: THREE.Group | undefined;
let widerNeighborhood: ReturnType<typeof createNeighborhoodContext> | undefined;
let outdoor: OutdoorScene | undefined;
let crew: CrewScene | undefined;
const vehicles: THREE.Group[] = [];
let visualQA: ReturnType<typeof installVisualQA> | undefined;
let ready = false;
let yaw = 0;
let pitch = 0;
const walkSession = new WalkSession();
let pointerCaptureUnavailable = false;
let lookDrag: {id:number;x:number;y:number} | undefined;
let resetJoystick = () => {};
let edgeLook: [number,number] = [0,0];
let planFloor: string | null = null;
let lowQuality = false;
let toastTimer = 0;
let frames = 0;
let fpsTime = 0;
let frameTimeTotal = 0;
let frameTimeSamples = 0;
let frameTimeMax = 0;
const frameTimeWindow: number[] = [];
let loadMs = 0;
let rendererName = '';
let introHideTimer: number | undefined;
let lastRenderStats: {calls:number;frameCalls:number;drawCalls:number;triangles:number;points:number;lines:number;timestamp:number} | null = null;
let groundRescues = 0;
let doorFocus: DoorState | undefined;
let elevatorFocus = false;
const movementKeys = new MovementKeys();
const keys = movementKeys.down;
const touchMove = {x:0,y:0};
let touchSprint = false;
const audio = new CoastalAudio();
let garageFinish: 'dark' | 'glazed' = 'dark';
try { if(localStorage.getItem('lewis-garage-finish')==='glazed')garageFinish='glazed'; } catch { /* Storage may be unavailable in private browsing. */ }
const garageMaterials = new Map<THREE.Material,{dark:THREE.Material;glazed:THREE.Material}>();
const tempVec = new THREE.Vector3();
const doorStates: DoorState[] = [];
let dynamicGeometryChanged = false;
interface DoorState { metadata: Door; node: THREE.Object3D; open: boolean; amount: number; blocked?: boolean; initialRotation: THREE.Quaternion; swingAxisLocal: THREE.Vector3; initialY: number; hingeWorld: Vec3; initialPosition: THREE.Vector3; slideLocal: THREE.Vector3; slideWorld: THREE.Vector3; secondary?: {node:THREE.Object3D;initialPosition:THREE.Vector3;initialRotation:THREE.Quaternion;axis:THREE.Vector3} }
const elevatorMotion = {current:0,from:0,to:0,elapsed:0,duration:0,moving:false,platformInitialY:0,passenger:false};
let elevatorNode: THREE.Object3D | undefined;
const meshVisibility = new Map<THREE.Object3D,boolean>();

function status(message: string, progress: number) { $('load-caption').textContent = message; $('progress').style.width = `${progress}%`; }
function setIntroHidden(hidden:boolean){
  const intro=$('intro');
  if(!hidden){window.clearTimeout(introHideTimer);introHideTimer=undefined;intro.hidden=false;}
  intro.classList.toggle('hidden',hidden);intro.inert=hidden;intro.setAttribute('aria-hidden',String(hidden));
  if(hidden&&!intro.hidden&&introHideTimer===undefined)introHideTimer=window.setTimeout(()=>{
    if(intro.classList.contains('hidden'))intro.hidden=true;introHideTimer=undefined;
  },380);
}
function toast(message: string) {
  $('toast').textContent = message; $('toast').hidden = false;
  window.clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function fail(error: unknown) {
  console.error(error);
  $('load-message').textContent = error instanceof Error ? error.message : String(error);
  $('load-message').classList.add('load-error');
  $('load-caption').textContent = 'The walkthrough could not start.';
  $('loading').classList.remove('complete');
  $('loading').hidden=false;$('loading').inert=false;$('loading').setAttribute('aria-hidden','false');
}
function escapeHTML(text: string) { const node = document.createElement('span'); node.textContent = text; return node.innerHTML; }
function updateAudioUI() {
  $('sound').textContent = audio.enabled ? 'Sound on' : 'Sound off';
  $('sound').setAttribute('aria-pressed', String(audio.enabled));
  $('sound').setAttribute('aria-label', audio.enabled ? 'Mute original beach ambience' : 'Turn on original beach ambience');
}
let garageFinishMaterials=0;
function setGarageFinish(finish: 'dark' | 'glazed') {
  dynamicGeometryChanged=true;
  garageFinishMaterials=0;garageFinish=finish;
  try {localStorage.setItem('lewis-garage-finish',finish);}catch {/* Optional preference. */}
  house?.traverse(node=>{
    if(!(node as THREE.Mesh).isMesh)return;
    const mesh=node as THREE.Mesh;
    if(/garage.*-inset-/i.test(mesh.name)){
      if(planFloor)meshVisibility.set(mesh,finish==='dark');
      mesh.visible=finish==='dark'&&(!planFloor||planFloor==='floor-1');
    }
    const choose=(material:THREE.Material)=>{
      if(!/garage-(panel|frame)/i.test(material.name))return material;
      garageFinishMaterials++;
      let variants=garageMaterials.get(material);
      if(!variants){
        // Black enamel is authored in Blender. Only the optional alternate
        // changes at runtime; clear top-row windows stay glass in both modes.
        const glazed=new THREE.MeshPhysicalMaterial();
        THREE.MeshStandardMaterial.prototype.copy.call(glazed,material);
        glazed.map=null;glazed.normalMap=null;glazed.roughnessMap=null;glazed.metalnessMap=null;
        if(/panel/i.test(material.name)){
          glazed.color.set('#f2f6f7');glazed.metalness=0;glazed.roughness=.07;
          glazed.transmission=1;glazed.ior=1.5;glazed.thickness=0;
        }else{glazed.color.set('#879094');glazed.metalness=.8;glazed.roughness=.28;}
        variants={dark:material,glazed};garageMaterials.set(material,variants);garageMaterials.set(glazed,variants);
      }
      return variants[finish];
    };
    mesh.material=Array.isArray(mesh.material)?mesh.material.map(choose):choose(mesh.material);
    const materials=Array.isArray(mesh.material)?mesh.material:[mesh.material];
    if(materials.some(m=>/garage-panel/.test(m.name)))mesh.castShadow=finish==='dark';
  });
  applyGlassQuality();
}
// r180 WebGPU supports physical transmission. Low quality uses alpha glazing
// with Fresnel environment reflections and avoids the refraction screen copy.
const glassQuality=new Map<THREE.MeshPhysicalMaterial,number>();
function applyGlassQuality(){
  scene.traverse(node=>{
    if(!(node as THREE.Mesh).isMesh)return;
    const mesh=node as THREE.Mesh;
    for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
      const m=material as THREE.MeshPhysicalMaterial;
      if(m.transmission>0&&!glassQuality.has(m))glassQuality.set(m,m.transmission);
      if(!glassQuality.has(m))continue;
      m.transmission=lowQuality?0:glassQuality.get(m)!;
      m.opacity=lowQuality?.22:1;m.transparent=lowQuality;m.depthWrite=!lowQuality;m.needsUpdate=true;
    }
  });
}
function sprinting() { return touchSprint || keys.has('ShiftLeft') || keys.has('ShiftRight'); }
function setTouchSprint(enabled: boolean) {
  touchSprint = enabled;
  $('touch-sprint').setAttribute('aria-pressed',String(enabled));
  $('touch-sprint').textContent = enabled ? 'Sprint on' : 'Sprint';
}
function attemptJump() {
  if (!ready || planFloor || !$('panel').hidden) return;
  if(!walkSession.reticleVisible)startWalk(!forceTouch);
  physics.jumpLocked = elevatorMotion.passenger || onElevator();
  if (physics.jump()) setIntroHidden(true);
  else if (physics.jumpLocked) toast('Jumping is paused on the elevator platform.');
}
function syncWalkUI() {
  document.body.classList.toggle('walking',ready && !planFloor && $('panel').hidden && walkSession.reticleVisible);
  $('look-help').textContent=walkSession.pointerLocked?'Move mouse to look':walkSession.hoverLook?'Mouse look · edges turn':'Click scene to look';
}
function clearMovement() {
  movementKeys.clear();setTouchSprint(false);touchMove.x=touchMove.y=0;lookDrag=undefined;edgeLook=[0,0];resetJoystick();
}
function requestMouseLook() {
  if(!ready || planFloor || !$('panel').hidden || !walkSession.wantsCapture || forceTouch || !matchMedia('(pointer:fine)').matches)return;
  renderer.domElement.focus({preventScroll:true});
  if(pointerCaptureUnavailable){walkSession.captureChanged(false);syncWalkUI();return;}
  const unavailable=()=>{
    pointerCaptureUnavailable=true;walkSession.captureChanged(false);syncWalkUI();
  };
  try { renderer.domElement.requestPointerLock()?.catch(unavailable); }
  catch { unavailable(); }
}
function closePanel(resumeLook = true) {
  const wasOpen=!$('panel').hidden;
  $('panel').hidden = true;
  $('rooms').classList.remove('active'); $('floors').classList.remove('active'); $('walk').classList.add('active');
  $('rooms').setAttribute('aria-expanded','false'); $('floors').setAttribute('aria-expanded','false');
  walkSession.resume();syncWalkUI();
  if(wasOpen&&resumeLook)requestMouseLook();
}
function openPanel(title: string, description: string) {
  walkSession.pause();clearMovement();
  document.exitPointerLock?.();
  setIntroHidden(true);
  $('panel').hidden = false; $('panel-title').textContent = title; $('panel-description').textContent = description;
  $('walk').classList.remove('active');
  syncWalkUI();$('interact').hidden=true;
  $('close-panel').focus();
}
function exitPlan() {
  if (!planFloor) return;
  planFloor = null;
  for (const [node, visible] of meshVisibility) node.visible = visible;
  meshVisibility.clear();
  $('plan-caption').hidden = true;
  scene.fog = new THREE.Fog(OUTDOOR_HAZE, 180, 550);
  outdoor?.setVisible(true);crew?.setVisible(true);widerNeighborhood?.setVisible(true);
  walkSession.resume();syncWalkUI();
}
function moveTo(position: Vec3, nextYaw = yaw, nextPitch = 0) {
  comparisonView=false;elevatorMotion.passenger=false;
  clearMovement();walkSession.start();
  exitPlan(); physics.teleport(position); yaw = nextYaw; pitch = nextPitch;
  closePanel(); setIntroHidden(true); updateCamera(); updateLocation();
  renderer.domElement.focus({preventScroll:true});syncWalkUI();
}
function moveToRoom(id:string) {
  const room=data.rooms.find(item=>item.id===id);if(!room)return;
  if(room.requiresElevator && data.elevator){
    elevatorMotion.moving=false;elevatorMotion.current=room.position[1];
    const delta=room.position[1]-data.elevator.position[1];
    if(elevatorNode)elevatorNode.position.y=elevatorMotion.platformInitialY+delta;
    dynamicGeometryChanged=true;
    const id=data.elevator.platformColliderId||data.elevator.platformNode;const c=physics.definitions.get(id);
    if(c)physics.transform(id,[c.center[0],c.center[1]+delta,c.center[2]],c.rotation);
    for(const door of doorStates)if(door.metadata.type==='elevator')door.open=elevatorGateCanOpen(door.metadata.position[1],elevatorMotion.current,false);
  }
  moveTo(room.position,room.requiresElevator?-Math.PI/2:room.yaw??yaw,room.pitch??0);
}
function startWalk(lock = true) {
  if (!ready) return;
  if(comparisonView){pitch=.26;yaw=0;}
  comparisonView=false;
  exitPlan(); closePanel(false); setIntroHidden(true);walkSession.start(lock && !forceTouch);syncWalkUI();
  renderer.domElement.focus({preventScroll:true});
  if(lock)requestMouseLook();
}

function showRooms() {
  if (!ready) return;
  if(phaseOne){toast('Room navigation is available in the full residence walkthrough.');return;}
  openPanel('Find your room', 'Choose a destination, or walk between rooms. Proposed finishes and furniture are shown throughout.');
  $('rooms').classList.add('active'); $('floors').classList.remove('active'); $('rooms').setAttribute('aria-expanded','true');
  $('panel-content').innerHTML = '<label class="sr-only" for="room-search">Search rooms</label><input id="room-search" class="search" type="search" placeholder="Search a room or outdoor space…"/><div id="room-list"></div>';
  const renderRooms = () => {
    const query = $<HTMLInputElement>('room-search').value.toLowerCase();
    $('room-list').innerHTML = '';
    for (const floor of data.floors) {
      const rooms = data.rooms.filter(room => room.walkable !== false && String(room.floor) === floor.id && `${room.name} ${room.id}`.toLowerCase().includes(query));
      if (!rooms.length) continue;
      const label = document.createElement('div'); label.className = 'floor-label'; label.textContent = floor.label; $('room-list').append(label);
      for (const room of rooms) {
        const button = document.createElement('button'); button.className = 'room-button'; button.dataset.room = room.id;
        button.innerHTML = `<span>${escapeHTML(room.name)}<small>${escapeHTML(room.evidence || 'Architectural study')}</small></span>${svg('arrow')}`;
        button.addEventListener('click', () => { moveToRoom(room.id); toast(room.name); }); $('room-list').append(button);
      }
    }
    if (!$('room-list').children.length) $('room-list').textContent = 'No matching rooms.';
  };
  $('room-search').addEventListener('input', renderRooms); renderRooms();
}

function showFloors() {
  if (!ready) return;
  if(phaseOne){toast('Floor navigation is available in the full residence walkthrough.');return;}
  openPanel('A different level', 'Visit a floor, inspect a plan view, or use the stairs and elevator during your walk.');
  $('floors').classList.add('active'); $('rooms').classList.remove('active'); $('floors').setAttribute('aria-expanded','true');
  $('panel-content').innerHTML = '';
  for (const floor of data.floors) {
    const card = document.createElement('div'); card.className = 'floor-card';
    card.innerHTML = `<strong>${escapeHTML(floor.label)}</strong><p>${data.rooms.filter(room => String(room.floor) === floor.id).length} spaces · ${floor.elevation.toFixed(2)} m above datum</p><div class="floor-actions"><button class="small-button" data-floor="${escapeHTML(floor.id)}">Visit floor</button><button class="small-button" data-plan="${escapeHTML(floor.id)}">Plan view</button></div>`;
    card.querySelector('[data-floor]')!.addEventListener('click', () => moveTo(floor.position,floor.yaw ?? yaw));
    card.querySelector('[data-plan]')!.addEventListener('click', () => showPlan(floor.id));
    $('panel-content').append(card);
  }
  const note = document.createElement('div'); note.className = 'panel-note'; note.textContent = 'Plan views show the exported architectural model. Source drawings and dimensional reconciliation remain in the project reference package.'; $('panel-content').append(note);
}

function showPlan(id: string) {
  const floor = data.floors.find(item => item.id === id);
  if (!floor) return;
  exitPlan(); closePanel(false); setIntroHidden(true); planFloor = id; scene.fog = null;
  clearMovement();walkSession.pause();document.exitPointerLock?.();syncWalkUI();
  outdoor?.setVisible(false);crew?.setVisible(false);
  doorFocus=undefined;elevatorFocus=false;$('interact').hidden=true;
  const allMeshes: THREE.Object3D[] = [];
  house?.traverse(node => { if ((node as THREE.Mesh).isMesh) allMeshes.push(node); });
  const bounds = new THREE.Box3();
  for (const node of allMeshes) {
    meshVisibility.set(node,node.visible);
    let objectFloor: string | undefined;
    let parent: THREE.Object3D | null = node;
    while(parent && !objectFloor) { objectFloor = parent.userData.floor; parent = parent.parent; }
    const box = new THREE.Box3().setFromObject(node);
    const hiddenCap = /ceiling|roof_cover|roof_surface|roof_main/i.test(node.name) || (id !== 'roof' && /roof-slope/i.test(node.name));
    const hiddenFinish = /garage.*-inset-/i.test(node.name) && garageFinish !== 'dark';
    node.visible = !hiddenCap && !hiddenFinish && (objectFloor ? objectFloor === id : box.max.y >= floor.elevation - .2 && box.min.y < floor.elevation + 1.8);
    if (node.visible) bounds.union(box);
  }
  widerNeighborhood?.setVisible(false);
  if (neighborhood) { meshVisibility.set(neighborhood,neighborhood.visible); neighborhood.visible = false; }
  for(const vehicle of vehicles){meshVisibility.set(vehicle,vehicle.visible);vehicle.visible=id==='floor-1';}
  if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-2,0,-19),new THREE.Vector3(15,10,3));
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const halfHeight = Math.max(size.z / 2 + 2, (size.x / 2 + 2) / (innerWidth / innerHeight));
  planCamera.left = -halfHeight * innerWidth / innerHeight; planCamera.right = -planCamera.left;
  planCamera.top = halfHeight; planCamera.bottom = -halfHeight;
  planCamera.position.set(center.x, floor.elevation + 40, center.z); planCamera.up.set(0,0,-1); planCamera.lookAt(center.x,floor.elevation,center.z); planCamera.updateProjectionMatrix();
  $('plan-caption').textContent = `${floor.label} · Model plan view · Select Walk to return`; $('plan-caption').hidden = false;
}

function showAbout() {
  openPanel('About the study', 'A source-led architectural model, presented as a continuous coastal walkthrough.');
  $('panel-content').innerHTML = `<div class="floor-card"><strong>Model & reference authority</strong><p>The dimensioned architectural plans control the home. County GIS supplies roads, building footprints and the address point. Construction placement, neighboring heights and roof shapes remain provisional. Ocean sightlines are not asserted.</p></div><div class="floor-card"><strong>Finish direction</strong><p>Warm oak, ivory, pale stone and soft coastal daylight. Unspecified finishes, fixtures and furnishings are proposals, not construction selections.</p></div><div class="floor-card"><strong>Under the hood</strong><p id="about-runtime">${escapeHTML(rendererName)} renders Blender-authored GLB assets. Rapier WebAssembly resolves capsule-to-world collisions, stair stepping and grounded movement.</p></div><div class="floor-card"><strong>Garage door finish</strong><p>Compare the dark reference-photo finish with the glazed aluminum plan option. The opening and collision geometry stay the same.</p><label class="sr-only" for="garage-finish">Garage door finish</label><select id="garage-finish" class="finish-select"><option value="dark">Dark coastal doors</option><option value="glazed">Glazed aluminum doors</option></select></div><div class="floor-card"><strong>Original beach ambience</strong><p>Soft instrumental chords and a gentle surf wash, synthesized here. Sound starts only when you select Sound on.</p><label class="volume-label" for="sound-volume">Volume <output id="volume-value">${Math.round(audio.volume*100)}%</output></label><input id="sound-volume" type="range" min="0" max="100" value="${Math.round(audio.volume*100)}" aria-label="Beach ambience volume"/></div><details id="performance-details" class="performance-details"><summary>Runtime performance</summary><p>Live measurements for this browser and viewport. Frame times cover the latest 600 visible frames. Heap size is shown only when the browser exposes it.</p><dl id="performance-metrics"></dl></details><div class="panel-note">Use WASD or arrows to walk, hold Shift to sprint, and press Space to jump from the ground. Select Walk and move the mouse to look. If the browser cannot capture the pointer, move it toward an edge to keep turning. Escape releases mouse look. Look at a nearby door or elevator entrance and press E. Jumping is paused on the elevator platform. On touch devices, use the left thumb pad, Sprint and Jump buttons, and drag the scene to look.</div>`;
  $<HTMLSelectElement>('garage-finish').value=garageFinish;
  $('garage-finish').addEventListener('change',()=>setGarageFinish($<HTMLSelectElement>('garage-finish').value as 'dark'|'glazed'));
  $('sound-volume').addEventListener('input',()=>{const value=Number($<HTMLInputElement>('sound-volume').value);audio.setVolume(value/100);$('volume-value').textContent=`${value}%`;});
  updatePerformanceDOM();
  const attribution=document.createElement('p');attribution.className='source-attribution';
  attribution.innerHTML='Neighborhood data © New Hanover County, NC. Sources: <a href="https://gis.nhcgov.com/server/rest/services/Layers/Addressing/MapServer/0" target="_blank" rel="noopener noreferrer">Addressing</a>, <a href="https://gis.nhcgov.com/server/rest/services/Layers/Roads/MapServer/1" target="_blank" rel="noopener noreferrer">Roads</a>, <a href="https://gis.nhcgov.com/server/rest/services/Layers/BuildingFootprints/MapServer/0" target="_blank" rel="noopener noreferrer">Building footprints</a>. Retrieved 14 October 2026. Local study; distribution terms not established.';
  $('panel-content').append(attribution);
}

function performanceMetrics() {
  const samples=[...frameTimeWindow].sort((a,b)=>a-b);
  const memory=(performance as Performance & {memory?:{usedJSHeapSize:number,totalJSHeapSize:number}}).memory;
  const elevatorStop=data?.elevator?.stops.find(stop=>Math.abs(stop.elevation-elevatorMotion.current)<.1);
  const elevatorFloor=data?.floors.find(floor=>floor.id===elevatorStop?.floorId)?.label;
  return {
    'Renderer':rendererName,
    'Contact shading':contactLighting&&!lowQuality&&!planFloor?contactLighting.description:'Direct rendering',
    'Physics':physics ? 'Rapier WebAssembly · active' : 'Loading',
    'Startup':`${loadMs.toFixed(0)} ms`,
    'Mean frame':`${(samples.reduce((a,b)=>a+b,0)/Math.max(1,samples.length)).toFixed(2)} ms`,
    '95th percentile':`${(samples[Math.floor(samples.length*.95)]||0).toFixed(2)} ms`,
    'Longest frame':`${frameTimeMax.toFixed(2)} ms`,
    'Draw calls':lastRenderStats?String(lastRenderStats.drawCalls):'Awaiting rendered frame',
    'Triangles':lastRenderStats?String(lastRenderStats.triangles):'Awaiting rendered frame',
    'Geometry / textures':`${renderer?.info.memory.geometries||0} / ${renderer?.info.memory.textures||0}`,
    'JS heap':memory?`${(memory.usedJSHeapSize/1048576).toFixed(1)} MiB used`:'Not exposed by this browser',
    'Camera position (m)':camera.position.toArray().map(v=>v.toFixed(4)).join(', '),
    'Camera yaw / pitch':`${camera.rotation.y.toFixed(4)} / ${camera.rotation.x.toFixed(4)}`,
    'Exposure':String(renderer.toneMappingExposure),
    'Feet position (m)':physics?physics.feet.map(v=>v.toFixed(3)).join(', '):'—',
    'Grounded':String(physics?.grounded||false),
    'Movement':sprinting()?'Sprint · 3.6 m/s':'Walk · 2.0 m/s',
    'Jumps':String(physics?.jumps||0),
    'Ambience':audio.status,
    'Garage finish':(garageFinish==='dark'?'Dark coastal doors':'Glazed aluminum doors')+' · '+garageFinishMaterials+' surfaces',
    'Coastal planting':outdoor?`${outdoor.stats.grassTufts} clumps · photographed HDR sky`:'Loading',
    'Interior lighting':interiorLighting?`${interiorLighting.diagnostics.activeCount} active / ${interiorLighting.diagnostics.authoredPracticals} fixtures · ${interiorLighting.diagnostics.zone||'outside'}`:'—',
    'Focused interaction':elevatorFocus?'Elevator controls':doorFocus?.metadata.id||'None',
    'Colliders':String(physics?.colliders.size||0),
    'Wider context':widerNeighborhood?.diagnostics.state||'Not configured',
    'Collision steps':String(physics?.steps||0),
    'Safety resets':String(groundRescues),
    'Doors open':`${doorStates.filter(door=>door.amount>.95).length} / ${doorStates.length}`,
    ...(data?.elevator?{
      'Elevator status':elevatorMotion.moving?'Moving':'Stopped',
      'Elevator floor':elevatorFloor||'Between floors',
      'Elevator height':`${elevatorMotion.current.toFixed(3)} m`,
      'Riding elevator':elevatorMotion.passenger?'Yes':'No',
    }:{}),
    'Viewport':`${innerWidth} × ${innerHeight} · DPR ${renderer?.getPixelRatio()||1}`,
  };
}
function updatePerformanceDOM() {
  const element=document.getElementById('performance-metrics');if(!element)return;
  element.innerHTML=Object.entries(performanceMetrics()).map(([label,value])=>`<dt>${escapeHTML(label)}</dt><dd>${escapeHTML(value)}</dd>`).join('');
}

function showElevator() {
  if (!data.elevator) return;
  openPanel('Take the elevator', 'Enter the platform, then select a supported floor. The platform travels continuously between levels.');
  $('panel-content').innerHTML = '';
  for (const stop of data.elevator.stops) {
    const button = document.createElement('button'); button.className = 'room-button'; button.dataset.elevatorFloor = stop.floorId;
    button.innerHTML = `<span>${escapeHTML(data.floors.find(f=>f.id===stop.floorId)?.label || stop.floorId)}<small>${stop.elevation.toFixed(2)} m</small></span>${svg('arrow')}`;
    button.disabled = elevatorMotion.moving;
    button.addEventListener('click', () => { callElevator(stop.elevation); closePanel(); });
    $('panel-content').append(button);
  }
}

function onElevator(): boolean {
  if (!physics || !data.elevator) return false;
  const feet = physics.feet;
  const origin = data.elevator.position;
  const bounds = data.elevator.bounds;
  return (bounds ? feet[0] > bounds.min[0] && feet[0] < bounds.max[0] && feet[2] > bounds.min[2] && feet[2] < bounds.max[2]
    : Math.abs(feet[0]-origin[0]) < .65 && Math.abs(feet[2]-origin[2]) < .65) && Math.abs(feet[1]-elevatorMotion.current) < .35;
}

function callElevator(elevation: number) {
  if (elevatorMotion.moving || !Number.isFinite(elevation) || !data.elevator?.stops.some(stop=>Math.abs(stop.elevation-elevation)<.001)) return;
  if(Math.abs(elevation-elevatorMotion.current)<.01){
    for(const door of doorStates)if(door.metadata.type==='elevator')door.open=elevatorGateCanOpen(door.metadata.position[1],elevatorMotion.current,false);
    toast('The elevator is already here. The landing gate is opening.');return;
  }
  for (const door of doorStates) if(door.metadata.type === 'elevator') door.open = false;
  elevatorMotion.from = elevatorMotion.current; elevatorMotion.to = elevation; elevatorMotion.elapsed = 0;
  elevatorMotion.duration = Math.max(1.4, Math.abs(elevation-elevatorMotion.current)/.8);
  elevatorMotion.passenger = onElevator(); elevatorMotion.moving = true;
  toast(elevatorMotion.passenger ? 'Elevator moving. Please stay on the platform.' : 'Elevator called to the selected floor.');
}

function updateElevator(dt: number) {
  if (!data.elevator || !elevatorMotion.moving) return;
  if(doorStates.some(door=>door.metadata.type==='elevator'&&door.amount>.002))return;
  if(elevatorMotion.elapsed===0)elevatorMotion.passenger=onElevator();
  elevatorMotion.elapsed += dt;
  const previous = elevatorMotion.current;
  elevatorMotion.current = THREE.MathUtils.lerp(elevatorMotion.from,elevatorMotion.to,smoothstep(elevatorMotion.elapsed/elevatorMotion.duration));
  const delta = elevatorMotion.current - data.elevator.position[1];
  if (elevatorNode) elevatorNode.position.y = elevatorMotion.platformInitialY + delta;
  dynamicGeometryChanged=true;
  const colliderId = data.elevator.platformColliderId || data.elevator.platformNode;
  const definition = physics.definitions.get(colliderId);
  if (definition) physics.transform(colliderId,[definition.center[0],definition.center[1]+delta,definition.center[2]]);
  if (elevatorMotion.passenger) physics.carry(elevatorMotion.current-previous);
  if (elevatorMotion.elapsed >= elevatorMotion.duration) {
    elevatorMotion.moving = false; elevatorMotion.passenger = false;
    for(const door of doorStates)if(door.metadata.type==='elevator')door.open=elevatorGateCanOpen(door.metadata.position[1],elevatorMotion.current,false);
    toast('Elevator arrived. The landing gate is opening.');
  }
}

function updateDoors(dt: number) {
  for (const state of doorStates) {
    const target = state.open ? 1 : 0;
    if (Math.abs(state.amount-target) < 1e-8) continue;
    const nextAmount=doorAnimationAmount(state.metadata,state.amount,state.open,dt);
    const transforms=doorColliderTransforms(state.metadata,physics.definitions,state.hingeWorld,state.slideWorld.toArray() as Vec3,nextAmount);
    if(transforms.some(part=>!physics.canPlaceCollider(part.id,part.center,part.rotation))){
      if(!state.blocked)toast('Give the door room to open or close.');
      state.blocked=true;continue;
    }
    state.blocked=false;state.amount=nextAmount;
    const angle = state.amount * state.metadata.openAngle;
    if (state.metadata.type === 'sliding' || state.metadata.type === 'elevator') {
      const offset = state.amount * (state.metadata.openDistance || 1.0);
      state.node.position.copy(state.initialPosition).addScaledVector(state.slideLocal,offset);
    } else if (state.metadata.type === 'garage') {
      const motion=garageDoorMotion(state.metadata,state.amount);
      state.node.position.y = state.initialY + motion.rise;
      state.node.quaternion.copy(state.initialRotation).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),motion.angle));
    } else {
      state.node.quaternion.copy(state.initialRotation).premultiply(new THREE.Quaternion().setFromAxisAngle(state.swingAxisLocal,angle));
    }
    if(state.secondary){
      const secondary=state.secondary;
      if(state.metadata.type==='bifold')secondary.node.quaternion.copy(secondary.initialRotation).premultiply(new THREE.Quaternion().setFromAxisAngle(secondary.axis,-2*angle));
      else if(state.metadata.type==='elevator')secondary.node.position.copy(secondary.initialPosition).addScaledVector(new THREE.Vector3(1,0,0),state.amount*((state.metadata.secondaryOpenDistance??0)-(state.metadata.openDistance??0)));
    }
    for(const part of transforms)physics.transform(part.id,part.center,part.rotation);
    dynamicGeometryChanged=true;
  }
}

function updateInteraction() {
  doorFocus = undefined; elevatorFocus = false;
  if (planFloor || !$('panel').hidden || !walkSession.reticleVisible) { $('interact').hidden = true; return; }
  const feet = physics.feet;
  const eye=camera.position.toArray() as Vec3;
  const forward=camera.getWorldDirection(tempVec).toArray() as Vec3;
  const reticleHit=physics.firstRayHit(eye,forward,INTERACTION_DISTANCE);
  const candidates:InteractionCandidate[]=[];
  for (const state of doorStates) for(const id of [state.metadata.colliderId,state.metadata.secondaryColliderId,state.metadata.fixedColliderId]) {
    const collider=id?physics.colliders.get(id):undefined;
    const definition=id?physics.definitions.get(id):undefined;
    if(!collider||!definition)continue;
    const p=collider.translation(),q=collider.rotation();
    const target=doorAimPoint([p.x,p.y,p.z],definition.halfExtents,[q.x,q.y,q.z,q.w],eye);
    const direction=target.map((value,index)=>value-eye[index]) as Vec3;
    const distance=Math.hypot(...direction),direct=reticleHit?.id===id;
    if(distance>INTERACTION_DISTANCE&&!direct)continue;
    const hit=physics.firstRayHit(eye,direction,distance+.015);
    candidates.push({id:state.metadata.id,position:target,visible:direct||!hit||hit.id===id,directHit:direct,distanceM:direct?reticleHit!.distance:distance});
  }
  for(const state of doorStates){
    if(state.metadata.type!=='sliding'||!state.metadata.colliderId||state.metadata.fixedColliderId||state.amount<.9)continue;
    const definition=physics.definitions.get(state.metadata.colliderId);if(!definition)continue;
    const target=slidingDoorPullPoint(definition.center,definition.halfExtents,state.slideWorld.toArray() as Vec3,state.metadata.openDistance??0,eye);
    const direction=target.map((v,i)=>v-eye[i]) as Vec3, distance=Math.hypot(...direction);
    if(distance>INTERACTION_DISTANCE)continue;
    const hit=physics.firstRayHit(eye,direction,distance+.015);
    candidates.push({id:state.metadata.id,position:target,visible:!hit||hit.id===state.metadata.colliderId});
  }
  let landing:DoorState|undefined;
  if (data.elevator) {
    const stop=data.elevator.stops.find(stop=>Math.abs(feet[1]-stop.elevation)<.4);
    const elevation=stop?.elevation??(onElevator()?elevatorMotion.current:undefined);
    if(elevation!==undefined){
      landing=doorStates.find(door=>door.metadata.type==='elevator'&&Math.abs(door.metadata.position[1]-elevation)<.4);
      const definition=landing?.metadata.colliderId?physics.definitions.get(landing.metadata.colliderId):undefined;
      if(definition){
        const target=doorAimPoint(definition.center,definition.halfExtents,definition.rotation||[0,0,0,1],eye);
        const direction=target.map((value,index)=>value-eye[index]) as Vec3;const distance=Math.hypot(...direction);
        if(distance<=INTERACTION_DISTANCE){const hit=physics.firstRayHit(eye,direction,distance+.015);candidates.push({id:'elevator-controls',position:target,visible:!hit||hit.id===landing?.metadata.colliderId||hit.id===landing?.metadata.secondaryColliderId});}
      }
    }
  }
  const selected=selectInteractionTarget(eye,forward,candidates,onElevator()?'elevator-controls':undefined);
  doorFocus=doorStates.find(door=>door.metadata.id===selected);
  elevatorFocus=selected==='elevator-controls'||Boolean(doorFocus===landing&&landing&&onElevator());
  $('interact').hidden = !doorFocus && !elevatorFocus;
  if (elevatorFocus && onElevator()) $('interact').innerHTML = '<kbd>E</kbd> Elevator · choose a floor';
  else if (doorFocus) $('interact').innerHTML = `<kbd>E</kbd> ${doorFocus.open ? 'Close' : 'Open'} ${escapeHTML(doorFocus.metadata.name || (doorFocus.metadata.type === 'elevator' ? 'elevator gate' : 'door'))}`;
  else if (elevatorFocus) $('interact').innerHTML = '<kbd>E</kbd> Elevator · choose a floor';
}
function interact() {
  if (!ready || planFloor || !$('panel').hidden || !walkSession.reticleVisible) return;
  updateCamera();updateInteraction();
  if(elevatorFocus && onElevator()){showElevator();return;}
  if (doorFocus) {
    if(doorFocus.metadata.type === 'elevator' && !doorFocus.open && !elevatorGateCanOpen(doorFocus.metadata.position[1],elevatorMotion.current,elevatorMotion.moving)) {
      toast('The gate stays locked until the elevator arrives.'); showElevator(); return;
    }
    doorFocus.open = !doorFocus.open; toast(`${doorFocus.metadata.name || 'Door'} ${doorFocus.open ? 'opening' : 'closing'}.`);
  }
  else if (elevatorFocus) showElevator();
  else toast('Look at a nearby door or elevator to interact.');
}

function updateCamera() {
  const feet = physics.feet;
  camera.position.set(feet[0],feet[1]+EYE_HEIGHT,feet[2]); camera.rotation.set(pitch,yaw,0,'YXZ');
  if(comparisonView){camera.position.set(6.05155,1.36,13);camera.rotation.set(.26,0,0,'YXZ');}
}
function updateLocation() {
  const feet = physics.feet;
  const room = data.rooms.filter(room => room.bounds && contains(room.bounds,feet,.06) && (!room.polygon || containsXZPolygon(room.polygon,feet))).sort((a,b)=>{
    const area=(room:typeof a)=>{const bounds=room.bounds!;return(bounds.max[0]-bounds.min[0])*(bounds.max[2]-bounds.min[2]);};
    return area(a)-area(b);
  })[0];
  if (room) {
    $('current-room').textContent = room.name;
    $('current-floor').textContent = data.floors.find(floor => floor.id === String(room.floor))?.label || String(room.floor);
  } else {
    const floor = [...data.floors].sort((a,b)=>Math.abs(a.elevation-feet[1])-Math.abs(b.elevation-feet[1]))[0];
    $('current-floor').textContent = feet[0]>-3 && feet[0]<16 && feet[2]<5 && feet[2]>-23 ? floor?.label || 'Coastal Residence' : 'Bonito Lane';
    $('current-room').textContent = phaseOne ? 'Neighborhood · provisional context' : 'Exploring the residence';
  }
}

function setupInput() {
  $('begin').addEventListener('click',()=>startWalk()); $('walk').addEventListener('click',()=>startWalk());
  $('rooms').addEventListener('click',showRooms); $('floors').addEventListener('click',showFloors);
  for (const id of ['rooms','floors']) { $(id).setAttribute('aria-controls','panel'); $(id).setAttribute('aria-expanded','false'); }
  $('reset').addEventListener('click',()=>{ if(ready) { walkSession.stop();moveTo(data.spawn.position,data.spawn.yaw,data.spawn.pitch??0);walkSession.stop();document.exitPointerLock?.();syncWalkUI();setIntroHidden(false); } });
  $('close-panel').addEventListener('click',()=>closePanel()); $('info').addEventListener('click',showAbout); $('provisional').addEventListener('click',showAbout);
  $('interact').addEventListener('click',interact); $('touch-interact').addEventListener('click',interact);
  $('touch-jump').addEventListener('click',attemptJump);
  $('touch-sprint').addEventListener('click',()=>setTouchSprint(!touchSprint));
  $('sound').addEventListener('click',async()=>{try{await audio.toggle();}catch{toast('Audio could not start. Select Sound again to retry.');}updateAudioUI();});
  $('fallback').addEventListener('click',()=>{params.set('renderer','webgl');location.search=params.toString();});
  $('quality').addEventListener('click',()=>{ lowQuality=!lowQuality; renderer.setPixelRatio(lowQuality?1:params.has('compare')?1.75:Math.min(devicePixelRatio,1.75));sun.castShadow=true;outdoor?.setQuality(lowQuality);applyGlassQuality();$('quality').textContent=lowQuality?'Low':'High'; });
  addEventListener('keydown',event=>{
    if(event.code==='Escape') {walkSession.stop();closePanel(false);clearMovement();document.exitPointerLock?.();syncWalkUI();return;}
    const target=event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if(event.code==='Space') {
      if(target.closest('button,summary,a'))return;
      event.preventDefault();if(!event.repeat)attemptJump();return;
    }
    if(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','ShiftLeft','ShiftRight'].includes(event.code) && $('panel').hidden && !planFloor) {event.preventDefault();if(movementKeys.press(event.code,event.repeat)&&ready&&!walkSession.reticleVisible)startWalk();}
    if(event.code==='KeyE' && !event.repeat && $('panel').hidden) interact();
  });
  addEventListener('keyup',event=>movementKeys.release(event.code));
  addEventListener('blur',()=>{clearMovement();walkSession.pause();syncWalkUI();});
  addEventListener('focus',()=>{if(ready&&!planFloor&&$('panel').hidden){walkSession.resume();syncWalkUI();}});
  document.addEventListener('visibilitychange',()=>{
    clearMovement();
    if(document.hidden)walkSession.pause();
    else if(ready&&!planFloor&&$('panel').hidden)walkSession.resume();
    syncWalkUI();void audio.setHidden(document.hidden).catch(()=>toast('Sound is paused. Use the Sound button to resume.'));
  });
  document.addEventListener('pointerlockchange',()=>{
    const locked=document.pointerLockElement===renderer?.domElement;
    if(locked&&(!walkSession.reticleVisible||planFloor||!$('panel').hidden)){
      document.exitPointerLock?.();return;
    }
    walkSession.captureChanged(locked);lookDrag=undefined;
    if(!locked)clearMovement();syncWalkUI();
  });
  document.addEventListener('pointerlockerror',()=>{pointerCaptureUnavailable=true;walkSession.captureChanged(false);syncWalkUI();});
  let hoveringViewport=false;
  $('viewport').addEventListener('pointerdown',event=>{
    if (!ready || planFloor || event.button!==0) return;
    if(comparisonView){comparisonView=false;pitch=.26;yaw=0;}
    startWalk(event.pointerType!=='touch');
    if(!document.pointerLockElement && (!walkSession.hoverLook || event.pointerType==='touch')) {lookDrag={id:event.pointerId,x:event.clientX,y:event.clientY};(event.target as HTMLElement).setPointerCapture(event.pointerId);}
  });
  addEventListener('pointermove',event=>{
    edgeLook=[0,0];
    if (!ready || planFloor || !$('panel').hidden || !walkSession.reticleVisible) {hoveringViewport=false;return;}
    let dx=0,dy=0;
    if(document.pointerLockElement===renderer.domElement){dx=event.movementX;dy=event.movementY;}
    else if(lookDrag && event.pointerId===lookDrag.id){dx=event.clientX-lookDrag.x;dy=event.clientY-lookDrag.y;lookDrag.x=event.clientX;lookDrag.y=event.clientY;}
    else if(walkSession.hoverLook && event.pointerType!=='touch' && (event.target as HTMLElement).closest('#viewport')){
      if(hoveringViewport){dx=event.movementX;dy=event.movementY;}hoveringViewport=true;
      edgeLook=edgeLookVelocity(event.clientX,event.clientY,innerWidth,innerHeight);
    }else hoveringViewport=false;
    yaw-=dx*.0026;pitch=THREE.MathUtils.clamp(pitch-dy*.0026,-1.45,1.45);
  });
  const endLook=(event:PointerEvent)=>{if(event.pointerId===lookDrag?.id)lookDrag=undefined;};
  addEventListener('pointerup',endLook);addEventListener('pointercancel',endLook);
  $('viewport').addEventListener('lostpointercapture',endLook);
  $('viewport').addEventListener('pointerleave',()=>{edgeLook=[0,0];hoveringViewport=false;});
  const stick=$('joystick'); let stickId:number|undefined;
  const setStick=(event:PointerEvent)=>{const rect=stick.getBoundingClientRect();const dx=(event.clientX-rect.left-rect.width/2)/(rect.width*.36);const dy=(event.clientY-rect.top-rect.height/2)/(rect.height*.36);const l=Math.max(1,Math.hypot(dx,dy));touchMove.x=dx/l;touchMove.y=dy/l;$('joystick-knob').style.transform=`translate(${touchMove.x*29}px,${touchMove.y*29}px)`;};
  stick.addEventListener('pointerdown',event=>{stickId=event.pointerId;stick.setPointerCapture(event.pointerId);setStick(event);startWalk(false);event.stopPropagation();});
  stick.addEventListener('pointermove',event=>{if(event.pointerId===stickId)setStick(event);});
  const resetStick=()=>{stickId=undefined;touchMove.x=touchMove.y=0;$('joystick-knob').style.transform='';};
  resetJoystick=resetStick;
  stick.addEventListener('pointerup',resetStick);stick.addEventListener('pointercancel',resetStick);
  stick.addEventListener('lostpointercapture',resetStick);
  $('panel').addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const nodes=Array.from($('panel').querySelectorAll<HTMLElement>('button:not(:disabled),input,select,summary,a'));const first=nodes[0],last=nodes.at(-1);
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
  });
}

async function loadGLB(path: string, label: string) {
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(assetUrl(path),event=>{if(event.total)status(`${label} · ${Math.round(event.loaded/event.total*100)}%`,label==='Neighborhood'?35:65);});
  gltf.scene.traverse(node=>{
    if((node as THREE.Mesh).isMesh){ const mesh=node as THREE.Mesh;mesh.castShadow=mesh.userData.castShadow!==false;mesh.receiveShadow=true;
      for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
        const pbr=material as THREE.MeshStandardMaterial;
        // The cars are closed solids. Casting their back surfaces prevents the
        // double-sided GLB panels from striping their own paint in shadow maps.
        if(/\/(tesla-model-y|bmw-3-series)\.glb$/.test(path))pbr.shadowSide=THREE.BackSide;
        for(const map of [pbr.map,pbr.normalMap,pbr.roughnessMap,pbr.metalnessMap])if(map)map.anisotropy=Math.min(8,renderer.getMaxAnisotropy());
      }
      if((Array.isArray(mesh.material)?mesh.material:[mesh.material]).every(m=>(m as THREE.MeshPhysicalMaterial).transmission>0))mesh.castShadow=false;
      if(/collision|proxy/i.test(mesh.name)||mesh.userData.collision)mesh.visible=false;
    }
  });
  scene.add(gltf.scene);return gltf.scene;
}

async function init() {
  setupInput();
  status('Checking graphics support',8);
  const nav = navigator as Navigator & {gpu?: {requestAdapter:()=>Promise<unknown>}};
  let adapter: unknown = null;
  if (!explicitFallback && nav.gpu) adapter=await nav.gpu.requestAdapter();
  if (!explicitFallback && !adapter) {
    $('load-message').textContent='WebGPU is unavailable in this browser. You can explicitly use the WebGL 2 compatibility renderer.';
    $('load-caption').textContent='WebGPU preferred · WebGL 2 available by choice'; $('fallback').style.display='inline-flex';return;
  }
  renderer = new THREE.WebGPURenderer({antialias:true,forceWebGL:explicitFallback});
  renderer.setPixelRatio(params.has('compare')?1.75:Math.min(devicePixelRatio,1.75)); renderer.setSize(innerWidth,innerHeight);
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFShadowMap;
  renderer.toneMapping=THREE.AgXToneMapping;renderer.toneMappingExposure=1.2;
  renderer.outputColorSpace=THREE.SRGBColorSpace;
  await renderer.init();
  const backend=renderer.backend as unknown as {isWebGPUBackend?:boolean};
  if(!explicitFallback&&!backend.isWebGPUBackend){renderer.dispose();$('load-message').textContent='WebGPU initialization failed. Select the explicitly labeled WebGL 2 compatibility mode to continue.';$('fallback').style.display='inline-flex';return;}
  rendererName=backend.isWebGPUBackend?'WebGPU':'WebGL 2 · fallback';
  $('renderer-label').textContent=rendererName; $('viewport').append(renderer.domElement);renderer.domElement.setAttribute('aria-label','Walkthrough viewport');renderer.domElement.tabIndex=0;
  status('Loading navigation and collision data',16);
  const response=await fetch(assetUrl(phaseOne?'/data/scene-phase1.json':'/data/scene.json'));if(!response.ok)throw new Error('Scene metadata is not available. Run the Blender export pipeline first.');
  data=validateScene(await response.json());
  status('Initializing WebAssembly physics',23);
  const initialCollisions=data.collisions.filter(c=>phaseOne?c.phase!=='house':c.phase==='neighborhood');
  physics=await Physics.create(initialCollisions,data.spawn.position);
  $('wasm-label').textContent='WASM physics';
  status('Loading neighborhood',32);neighborhood=await loadGLB('/models/neighborhood.glb','Neighborhood');
  widerNeighborhood=createNeighborhoodContext((data as SceneData & {neighborhoodSelection?:NeighborhoodSelection}).neighborhoodSelection,physics,loadGLB,toast);
  if(phaseOne)await widerNeighborhood.load();
  if(!phaseOne){
    status('Loading the Coastal Residence',55);house=await loadGLB('/models/lewis-residence.glb','Residence');
    const targetNames=data.targetShellNodes || [];
    neighborhood.traverse(node=>{if(targetNames.includes(node.name)||node.userData.targetShell||/target_shell/i.test(node.name))node.visible=false;});
    for(const c of data.collisions){if(c.targetShell||/target_shell/i.test(c.id))physics.remove(c.id);else if(c.phase!=='neighborhood')physics.add(c);}
    house.updateMatrixWorld(true);
    for(const metadata of data.doors){
      const node=house.getObjectByName(metadata.hingeNode);
      if(!node)throw new Error(`Door hinge node missing: ${metadata.hingeNode}. Re-export the house and navigation together.`);
      const hinge=node.getWorldPosition(new THREE.Vector3());
      const parentRotation=node.parent?.getWorldQuaternion(new THREE.Quaternion())||new THREE.Quaternion();
      const secondary=metadata.secondaryNode?house.getObjectByName(metadata.secondaryNode):undefined;
      if(metadata.secondaryNode&&!secondary)throw new Error(`Door leaf node missing: ${metadata.secondaryNode}.`);
      const secondaryParentRotation=secondary?.parent?.getWorldQuaternion(new THREE.Quaternion())||new THREE.Quaternion();
      doorStates.push({metadata,node,open:false,amount:0,initialRotation:node.quaternion.clone(),swingAxisLocal:new THREE.Vector3(0,1,0).applyQuaternion(parentRotation.invert()),initialY:node.position.y,hingeWorld:[hinge.x,hinge.y,hinge.z],initialPosition:node.position.clone(),slideLocal:new THREE.Vector3(1,0,0).applyQuaternion(node.quaternion),slideWorld:new THREE.Vector3(1,0,0).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion())),secondary:secondary?{node:secondary,initialPosition:secondary.position.clone(),initialRotation:secondary.quaternion.clone(),axis:new THREE.Vector3(0,1,0).applyQuaternion(secondaryParentRotation.invert())}:undefined});
    }
    if(data.elevator){elevatorNode=house.getObjectByName(data.elevator.platformNode);elevatorMotion.current=data.elevator.position[1];elevatorMotion.platformInitialY=elevatorNode?.position.y||0;}
    for(const vehicle of data.vehicles||[]){
      const model=await loadGLB(vehicle.url,vehicle.name);model.position.set(...vehicle.position);model.name=vehicle.name;vehicles.push(model);
    }
    interiorLighting=await createInteriorLighting(scene,house,vehicles);
  }
  physics.world.step();
  setGarageFinish(params.has('compare')?'dark':garageFinish);
  yaw=data.spawn.yaw;pitch=data.spawn.pitch??0;updateCamera();
  status('Preparing daylight and materials',87);
  await createDaylight(renderer,scene,sun);
  outdoor=await createOutdoor(scene,camera,explicitFallback?256:1000);
  if(!phaseOne)crew=await createCrew(scene,physics);
  if(params.has('qa')&&params.get('qa')!=='roam')crew?.previewClip('LookAround');
  if(crew&&params.has('crewReview')&&params.get('crewClip'))crew.previewClip(params.get('crewClip')!);
  if(params.get('contact')!=='0'&&!explicitFallback)contactLighting=createContactLighting(renderer,scene,camera,params.get('contactDebug'));
  await renderer.compileAsync(scene,camera);
  renderer.info.reset();renderer.render(scene,camera);lastRenderStats={...renderer.info.render};
  ready=true;loadMs=performance.now()-startedAt;
  $('progress').style.width='100%';$('load-caption').textContent='Ready to explore';
  $('loading').classList.add('complete');
  $('loading').inert=true;$('loading').setAttribute('aria-hidden','true');
  window.setTimeout(()=>{if($('loading').classList.contains('complete'))$('loading').hidden=true;},750);
  if(phaseOne){$('intro').querySelector('h1')!.innerHTML='A place in<br>the neighborhood.';$('intro').querySelector('p')!.textContent='Explore the provisional neighborhood baseline. The detailed residence is available in the full walkthrough.';}
  const roomParam=params.get('room');const room=roomParam?data.rooms.find(r=>r.id===roomParam):undefined;
  if(room)moveToRoom(room.id);
  const view=params.get('view');if(view)showPlan(view);
  if(params.has('clean')){setIntroHidden(true);}
  if(params.has('crewReview')&&crew){
    const p=crew.diagnostics.position as number[];
    physics.teleport([p[0]+2.1,p[1],p[2]+2.7]);yaw=.66;pitch=-.25;updateCamera();
  }
  if(params.has('qa'))visualQA=installVisualQA({scene,camera,renderer,
    move:eye=>{moveTo([eye[0],eye[1]-EYE_HEIGHT,eye[2]]);clearMovement();walkSession.stop();syncWalkUI();},
    crewPreview:()=>{if(params.get('qa')!=='roam')crew?.previewClip('LookAround');},
    metrics:()=>({...performanceMetrics(),crew:crew?.diagnostics,context:widerNeighborhood?.diagnostics}),
  });
  updateLocation();
  let last=performance.now(),accumulator=0,locationTimer=0;
  renderer.setAnimationLoop(now=>{
    const rawDt=Math.max(0,(now-last)/1000);const dt=Math.min(rawDt,.08);last=now;frames++;fpsTime+=rawDt;
    if(!document.hidden){frameTimeTotal+=rawDt*1000;frameTimeSamples++;frameTimeMax=Math.max(frameTimeMax,rawDt*1000);frameTimeWindow.push(rawDt*1000);if(frameTimeWindow.length>600)frameTimeWindow.shift();}
    if(fpsTime>1){$('fps').textContent=`${Math.round(frames/fpsTime)} fps`;frames=0;fpsTime=0;updatePerformanceDOM();}
    audio.update();
    if(!planFloor){
      if(walkSession.hoverLook&&$('panel').hidden){yaw-=edgeLook[0]*dt;pitch=THREE.MathUtils.clamp(pitch-edgeLook[1]*dt,-1.45,1.45);}
      accumulator+=dt;
      while(accumulator>=1/60){
        updateDoors(1/60);updateElevator(1/60);
        physics.jumpLocked=elevatorMotion.passenger||onElevator();
        let forward=(keys.has('KeyW')||keys.has('ArrowUp')?1:0)-(keys.has('KeyS')||keys.has('ArrowDown')?1:0)-touchMove.y;
        let right=(keys.has('KeyD')||keys.has('ArrowRight')?1:0)-(keys.has('KeyA')||keys.has('ArrowLeft')?1:0)+touchMove.x;
        if(!$('panel').hidden||(elevatorMotion.passenger&&elevatorMotion.elapsed>0&&elevatorMotion.moving)){forward=right=0;}
        const len=Math.max(1,Math.hypot(forward,right)); const speed=sprinting()?SPRINT_SPEED:WALK_SPEED;
        const dx=(-Math.sin(yaw)*forward+Math.cos(yaw)*right)/len*speed;
        const dz=(-Math.cos(yaw)*forward-Math.sin(yaw)*right)/len*speed;
        physics.step([dx,0,dz],1/60);
        if(physics.feet[1]<-6){physics.teleport(data.spawn.position);groundRescues++;toast('Returned to the safe starting point.');}
        accumulator-=1/60;
      }
      updateCamera();locationTimer+=dt;if(locationTimer>.15){updateLocation();updateInteraction();locationTimer=0;}
    }
    visualQA?.apply();
    if(!planFloor)widerNeighborhood?.update(camera.position.toArray() as Vec3);
    interiorLighting?.update(camera.position.toArray() as Vec3,dt,{lowQuality,planMode:!!planFloor,movingGeometry:dynamicGeometryChanged});
    dynamicGeometryChanged=false;
    outdoor?.update(dt,now/1000);
    if(!document.hidden)crew?.update(dt*(params.has('crewSlow')?.25:1));
    if(crew&&params.has('crewReview')){
      const diagnostic=crew.diagnostics;$('viewport').dataset.crew=JSON.stringify(diagnostic);
      if(['follow','normal'].includes(params.get('crewReview')||'')){
        const p=diagnostic.position as number[];const far=params.get('crewReview')==='normal';camera.position.set(p[0]+(far?3.7:1.7),p[1]+(far?1.65:1.1),p[2]+(far?5.4:2.4));camera.lookAt(p[0],p[1]+.4,p[2]);
      }
    }
    if(contactLighting&&!lowQuality&&!planFloor)contactLighting.render();
    else renderer.render(scene,planFloor?planCamera:camera);
    // Three's Animation resets info before our next callback. Preserve the
    // completed frame here so the visible metrics never read reset counters.
    lastRenderStats={...renderer.info.render};
    visualQA?.frame(rawDt*1000);
  });
  addEventListener('resize',()=>{camera.aspect=innerWidth/innerHeight;camera.updateProjectionMatrix();renderer.setSize(innerWidth,innerHeight);if(planFloor)showPlan(planFloor);});
  Object.assign(window,{lewis:{
    get diagnostics(){return{ready,renderer:rendererName,wasm:!!physics.world,phase:phaseOne?1:2,feet:physics.feet,yaw,pitch,grounded:physics.grounded,collisions:physics.colliders.size,steps:physics.steps,loadMs,averageFrameMs:frameTimeTotal/Math.max(1,frameTimeSamples),maxFrameMs:frameTimeMax,groundRescues,crew:crew?.diagnostics,renderStats:lastRenderStats,gpuResources:{...renderer.info.memory},jsHeap:(performance as Performance & {memory?:{usedJSHeapSize:number,totalJSHeapSize:number}}).memory,doors:doorStates.map(d=>({id:d.metadata.id,open:d.open,amount:d.amount})),elevator:{...elevatorMotion},rooms:data.rooms.length,assetSources:['/models/neighborhood.glb',...(!phaseOne?['/models/lewis-residence.glb']:[])]};},
    get sceneData(){return data;}, goToRoom:(id:string)=>{const r=data.rooms.find(room=>room.id===id);if(!r)throw Error(`Unknown room ${id}`);moveToRoom(id);},
    goToFloor:(id:string)=>{const f=data.floors.find(floor=>floor.id===id);if(!f)throw Error(`Unknown floor ${id}`);moveTo(f.position);},
    plan:showPlan,reset:()=>moveTo(data.spawn.position,data.spawn.yaw,data.spawn.pitch??0),
    look:(newYaw:number,newPitch=0)=>{yaw=newYaw;pitch=newPitch;updateCamera();},
    door:(id:string,open=true)=>{const d=doorStates.find(door=>door.metadata.id===id);if(!d)throw Error(`Unknown door ${id}`);d.open=open;},
    elevator:callElevator,
  }});
}

addEventListener('pagehide',()=>crew?.dispose(),{once:true});
init().catch(fail);
