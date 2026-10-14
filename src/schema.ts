export type Vec3 = [number, number, number];
export type Quaternion = [number, number, number, number];
export interface Bounds { min: Vec3; max: Vec3 }
export interface Collision {
  id: string; center: Vec3; halfExtents: Vec3; rotation?: Quaternion;
  shape?: 'cuboid' | 'trimesh'; vertices?: number[]; indices?: number[];
  phase?: 'neighborhood' | 'house'; targetShell?: boolean;
}
export interface Room {
  id: string; name: string; floor: string; position: Vec3; yaw?: number; pitch?: number;
  bounds?: Bounds; polygon?: [number,number][]; description?: string; evidence?: string; walkable?: boolean; requiresElevator?: boolean;
}
export interface Floor { id: string; label: string; elevation: number; position: Vec3; yaw?: number }
export interface Door {
  id: string; name?: string; hingeNode: string; colliderId?: string;
  openAngle: number; position: Vec3; type?: 'hinged' | 'garage' | 'sliding' | 'elevator' | 'bifold'; liftHeight?: number; panelHeight?: number; openDistance?: number;
  hingePosition?: Vec3; panelWidth?: number; secondaryNode?: string; secondaryColliderId?: string; secondaryOpenDistance?: number; fixedColliderId?: string;
}
export interface Elevator {
  platformNode: string; platformColliderId?: string; position: Vec3; bounds?: Bounds;
  stops: { floorId: string; elevation: number; position: Vec3 }[];
}
export interface SceneData {
  version: number; units: string; axes: string;
  spawn: { position: Vec3; yaw: number; pitch?: number };
  collisions: Collision[]; rooms: Room[]; floors: Floor[]; doors: Door[];
  elevator?: Elevator; targetShellNodes?: string[]; title?: string;
  vehicles?: {id:string;name:string;url:string;position:Vec3;location?:string}[];
}

function isVec(value: unknown): value is Vec3 {
  return Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
}

/** Fail visibly rather than silently loading an unsafe or mis-scaled scene. */
export function validateScene(value: unknown): SceneData {
  if (!value || typeof value !== 'object') throw new Error('Scene metadata is missing.');
  const data = value as SceneData;
  if (data.version !== 1 || data.units !== 'meters') throw new Error('Scene must use schema v1 and meters.');
  if (!data.spawn || !isVec(data.spawn.position) || !Number.isFinite(data.spawn.yaw)) throw new Error('Scene spawn is invalid.');
  for (const key of ['collisions', 'rooms', 'floors', 'doors'] as const) {
    if (!Array.isArray(data[key])) throw new Error(`Scene ${key} are missing.`);
    const ids = data[key].map(item => item.id);
    if (new Set(ids).size !== ids.length) throw new Error(`Duplicate ${key} IDs.`);
  }
  for (const c of data.collisions) {
    if (!isVec(c.center) || (c.shape !== 'trimesh' && (!isVec(c.halfExtents) || c.halfExtents.some(v => v <= 0)))) throw new Error(`Invalid collision ${c.id}.`);
    if (c.shape === 'trimesh' && (!c.vertices?.length || !c.indices?.length || c.vertices.length % 3 || c.indices.length % 3)) throw new Error(`Invalid triangle mesh ${c.id}.`);
  }
  for (const room of data.rooms) if (!isVec(room.position)) throw new Error(`Invalid destination ${room.id}.`);
  const colliderIds=new Set(data.collisions.map(c=>c.id));
  for(const door of data.doors){
    if(!isVec(door.position)||!Number.isFinite(door.openAngle)||!door.hingeNode)throw new Error(`Invalid door ${door.id}.`);
    for(const id of [door.colliderId,door.secondaryColliderId,door.fixedColliderId])if(id&&!colliderIds.has(id))throw new Error(`Missing door collider ${id}.`);
    for(const value of [door.openDistance,door.secondaryOpenDistance,door.panelWidth,door.panelHeight])if(value!==undefined&&!Number.isFinite(value))throw new Error(`Invalid door motion ${door.id}.`);
    if(door.type==='bifold'&&(!door.secondaryNode||!door.secondaryColliderId||!(door.panelWidth!>0)))throw new Error(`Incomplete folding door ${door.id}.`);
    if(!!door.secondaryNode!==!!door.secondaryColliderId)throw new Error(`Unpaired door leaf ${door.id}.`);
  }
  return data;
}

export function contains(bounds: Bounds, point: Vec3, padding = 0): boolean {
  return point.every((value, index) => value >= bounds.min[index] - padding && value <= bounds.max[index] + padding);
}

/** Exact plan polygon membership avoids labeling cut-outs of concave halls. */
export function containsXZPolygon(polygon: [number,number][], point: Vec3, boundaryTolerance = .025): boolean {
  const x=point[0],z=point[2];let inside=false;
  for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){
    const [ax,az]=polygon[j],[bx,bz]=polygon[i];
    const dx=bx-ax,dz=bz-az,lengthSquared=dx*dx+dz*dz;
    const t=lengthSquared?Math.max(0,Math.min(1,((x-ax)*dx+(z-az)*dz)/lengthSquared)):0;
    if(Math.hypot(x-ax-t*dx,z-az-t*dz)<=boundaryTolerance)return true;
    if((az>z)!==(bz>z)&&x<(bx-ax)*(z-az)/(bz-az)+ax)inside=!inside;
  }
  return inside;
}

export function smoothstep(value: number): number { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); }
