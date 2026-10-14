import type { Collision, Door, Quaternion, Vec3 } from './schema';

/** Limit each fixed-tick leaf sweep so it cannot jump across the capsule. */
export function doorAnimationAmount(door:Door, current:number, open:boolean, dt:number) {
  const amount=Math.max(0,Math.min(1,Number.isFinite(current)?current:0));
  const sliding=door.type==='sliding'||door.type==='elevator';
  // Direction belongs to the signed travel, never to the rate limiter. A
  // negative pocket-door distance previously advanced forever, even on close.
  const elapsed=Number.isFinite(dt)?Math.max(0,dt):0;
  const maxStep=sliding ? 2*elapsed/Math.max(.01,Math.abs(door.openDistance||1)) : 3*elapsed/Math.max(.01,Math.abs(door.type==='garage'?Math.PI/2:door.openAngle));
  return Math.max(0,Math.min(1,amount+Math.max(-maxStep,Math.min(maxStep,(open?1:0)-amount))));
}

export function garageDoorMotion(door: Door, amount: number) {
  const angle = Math.max(0, Math.min(1, amount)) * Math.PI / 2;
  const height = door.panelHeight ?? ((door.liftHeight ?? 2.5) - .1);
  return {angle:-angle, rise:height * (1 - Math.cos(angle))};
}

/** The physics and validation paths share the same door movement equations. */
export function doorColliderTransform(door: Door, collision: Collision, hinge: Vec3, slideDirection: Vec3, amount: number): {center: Vec3; rotation: Quaternion} {
  amount=Math.max(0,Math.min(1,Number.isFinite(amount)?amount:0));
  const original = collision.rotation || [0,0,0,1];
  const center = [...collision.center] as Vec3;
  if (door.type === 'garage') {
    const {angle,rise} = garageDoorMotion(door,amount);
    const [ax,ay,az] = slideDirection;
    const x=center[0]-hinge[0],y=center[1]-hinge[1],z=center[2]-hinge[2];
    const cos=Math.cos(angle),sin=Math.sin(angle),dot=ax*x+ay*y+az*z;
    center[0]=hinge[0]+x*cos+(ay*z-az*y)*sin+ax*dot*(1-cos);
    center[1]=hinge[1]+y*cos+(az*x-ax*z)*sin+ay*dot*(1-cos)+rise;
    center[2]=hinge[2]+z*cos+(ax*y-ay*x)*sin+az*dot*(1-cos);
    const s=Math.sin(angle/2),w=Math.cos(angle/2),qx=ax*s,qy=ay*s,qz=az*s;
    const [bx,by,bz,bw]=original;
    return {center,rotation:[w*bx+qx*bw+qy*bz-qz*by,w*by-qx*bz+qy*bw+qz*bx,w*bz+qx*by-qy*bx+qz*bw,w*bw-qx*bx-qy*by-qz*bz]};
  }
  if (door.type === 'sliding' || door.type === 'elevator') {
    const distance = amount * (door.openDistance || 1);
    return {center:center.map((v,i)=>v+slideDirection[i]*distance) as Vec3,rotation:original};
  }
  const angle = amount * door.openAngle;
  const x = center[0]-hinge[0], z = center[2]-hinge[2];
  center[0] = hinge[0]+x*Math.cos(angle)+z*Math.sin(angle);
  center[2] = hinge[2]-x*Math.sin(angle)+z*Math.cos(angle);
  const s=Math.sin(angle/2),c=Math.cos(angle/2),[qx,qy,qz,qw]=original;
  return {center,rotation:[c*qx+s*qz,c*qy+s*qw,c*qz-s*qx,c*qw-s*qy]};
}

/** Every authored moving leaf participates in obstruction checks and physics. */
export function doorColliderTransforms(door: Door, definitions: ReadonlyMap<string, Collision>, hinge: Vec3, slideDirection: Vec3, amount: number): {id: string; center: Vec3; rotation: Quaternion}[] {
  amount=Math.max(0,Math.min(1,Number.isFinite(amount)?amount:0));
  const primary=door.colliderId&&definitions.get(door.colliderId);
  if(!primary)return [];
  const result=[{id:primary.id,...doorColliderTransform(door,primary,hinge,slideDirection,amount)}];
  const secondary=door.secondaryColliderId&&definitions.get(door.secondaryColliderId);
  if(!secondary)return result;
  if(door.type==='bifold'){
    const width=door.panelWidth??0;
    const closedHinge=hinge.map((v,i)=>v+slideDirection[i]*width) as Vec3;
    const angle=door.openAngle*amount,cos=Math.cos(angle),sin=Math.sin(angle);
    const x=closedHinge[0]-hinge[0],z=closedHinge[2]-hinge[2];
    const openedHinge:Vec3=[hinge[0]+x*cos+z*sin,closedHinge[1],hinge[2]-x*sin+z*cos];
    const pose=doorColliderTransform({...door,openAngle:-door.openAngle},secondary,closedHinge,slideDirection,amount);
    result.push({id:secondary.id,center:pose.center.map((v,i)=>v+openedHinge[i]-closedHinge[i]) as Vec3,rotation:pose.rotation});
  }else{
    result.push({id:secondary.id,...doorColliderTransform({...door,openDistance:door.secondaryOpenDistance},secondary,hinge,slideDirection,amount)});
  }
  return result;
}

export function elevatorGateCanOpen(doorElevation: number, carElevation: number, moving: boolean): boolean {
  return !moving && Math.abs(carElevation-doorElevation) <= .2;
}
