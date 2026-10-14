import RAPIER from '@dimforge/rapier3d-compat';
import type { Collision, Vec3, Quaternion } from './schema';

export const BODY_HALF_HEIGHT = 0.84;
export const EYE_HEIGHT = 1.65;
export const WALK_SPEED = 2.0;
export const SPRINT_SPEED = 3.6;
export const JUMP_SPEED = 4.4;
export class Physics {
  world: RAPIER.World;
  body: RAPIER.RigidBody;
  player: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  colliders = new Map<string, RAPIER.Collider>();
  private colliderIds = new Map<number,string>();
  definitions = new Map<string, Collision>();
  grounded = false;
  velocityY = 0;
  collisionsLastStep = 0;
  steps = 0;
  jumps = 0;
  jumpLocked = false;

  static async create(collisions: Collision[], spawn: Vec3) {
    await RAPIER.init();
    return new Physics(collisions, spawn);
  }

  private constructor(collisions: Collision[], spawn: Vec3) {
    this.world = new RAPIER.World({x: 0, y: -9.81, z: 0});
    this.world.timestep = 1 / 60;
    for (const c of collisions) this.add(c);
    this.body = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(spawn[0], spawn[1] + BODY_HALF_HEIGHT + 0.02, spawn[2]));
    this.player = this.world.createCollider(RAPIER.ColliderDesc.capsule(0.62, 0.22), this.body);
    this.controller = this.world.createCharacterController(0.015);
    this.controller.enableAutostep(0.25, 0.12, false);
    this.controller.enableSnapToGround(0.32);
    this.controller.setMaxSlopeClimbAngle(Math.PI / 3);
    this.controller.setMinSlopeSlideAngle(Math.PI / 3 + 0.05);
    this.world.step();
  }

  add(c: Collision) {
    const desc = c.shape === 'trimesh'
      ? RAPIER.ColliderDesc.trimesh(new Float32Array(c.vertices!), new Uint32Array(c.indices!))
      : RAPIER.ColliderDesc.cuboid(...c.halfExtents);
    desc.setTranslation(...c.center);
    if (c.rotation) desc.setRotation({x:c.rotation[0], y:c.rotation[1], z:c.rotation[2], w:c.rotation[3]});
    const collider=this.world.createCollider(desc);
    this.colliders.set(c.id,collider);this.colliderIds.set(collider.handle,c.id);
    this.definitions.set(c.id, c);
  }

  remove(id: string) {
    const collider = this.colliders.get(id);
    if (collider) {this.colliderIds.delete(collider.handle);this.world.removeCollider(collider, true);}
    this.colliders.delete(id);
  }

  transform(id: string, center: Vec3, rotation?: Quaternion) {
    const c = this.colliders.get(id);
    if (!c) return;
    c.setTranslation({x:center[0], y:center[1], z:center[2]});
    if (rotation) c.setRotation({x:rotation[0], y:rotation[1], z:rotation[2], w:rotation[3]});
  }

  /** Preview a moving leaf against the actual player capsule, without mutation. */
  canPlaceCollider(id: string, center: Vec3, rotation?: Quaternion): boolean {
    const collider=this.colliders.get(id);
    if(!collider)return true;
    const [x,y,z,w]=rotation||[0,0,0,1];
    const contact=this.player.contactShape(collider.shape,{x:center[0],y:center[1],z:center[2]},{x,y,z,w},.012);
    return !contact || contact.distance>=.008;
  }

  firstRayHit(origin:Vec3, direction:Vec3, maxDistance:number):{id:string;distance:number}|null {
    const length=Math.hypot(...direction);if(length<1e-6)return null;
    const ray=new RAPIER.Ray({x:origin[0],y:origin[1],z:origin[2]},{x:direction[0]/length,y:direction[1]/length,z:direction[2]/length});
    const hit=this.world.castRay(ray,maxDistance,true,undefined,undefined,this.player);
    if(!hit)return null;
    return {id:this.colliderIds.get(hit.collider.handle)||'',distance:hit.timeOfImpact};
  }

  /** Actual terrain support, isolated from architecture overhead. */
  terrainSurface(x:number,z:number,groundY:number) {
    const terrain=this.colliders.get('terrain');if(!terrain)return null;
    const ray=new RAPIER.Ray({x,y:groundY+1,z},{x:0,y:-1,z:0});
    const hit=this.world.castRayAndGetNormal(ray,2,true,undefined,undefined,this.player,undefined,c=>c.handle===terrain.handle);
    return hit?{y:groundY+1-hit.timeOfImpact,nx:hit.normal.x,ny:hit.normal.y,nz:hit.normal.z}:null;
  }

  /** Inflated dog envelope includes muzzle, tail and turning clearance. */
  crewClear(x:number,z:number,radius:number,groundY:number):boolean {
    const surface=this.terrainSurface(x,z,groundY);if(!surface)return false;
    let clear=true;
    this.world.intersectionsWithShape({x,y:surface.y+.43,z},{x:0,y:0,z:0,w:1},new RAPIER.Cylinder(.39,radius),c=>{clear=false;return false;},undefined,undefined,this.player,undefined,c=>this.colliderIds.get(c.handle)!=='terrain');
    return clear;
  }

  get feet(): Vec3 {
    const p = this.body.translation();
    return [p.x, p.y - BODY_HALF_HEIGHT, p.z];
  }

  teleport(position: Vec3) {
    const p = {x:position[0], y:position[1] + BODY_HALF_HEIGHT + 0.02, z:position[2]};
    this.body.setTranslation(p, true);
    this.body.setNextKinematicTranslation(p);
    this.velocityY = 0;
    this.grounded = false;
    this.world.step();
  }

  jump(): boolean {
    if (!this.grounded || this.jumpLocked) return false;
    this.velocityY = JUMP_SPEED;
    this.grounded = false;
    this.jumps++;
    return true;
  }

  carry(deltaY: number) {
    const p = this.body.translation();
    this.body.setTranslation({x:p.x,y:p.y + deltaY,z:p.z}, true);
    this.body.setNextKinematicTranslation({x:p.x,y:p.y + deltaY,z:p.z});
    this.velocityY = 0;
    // Refresh the moved platform's broad phase before the controller sweeps.
    // Otherwise descending platforms retain their previous-frame query height.
    this.world.step();
  }

  step(direction: Vec3, dt: number) {
    this.world.timestep = dt;
    this.velocityY = Math.max(-12, this.velocityY - 9.81 * dt);
    this.controller.computeColliderMovement(this.player, {x:direction[0] * dt,y:this.velocityY * dt,z:direction[2] * dt});
    const corrected = this.controller.computedMovement();
    const current = this.body.translation();
    this.body.setNextKinematicTranslation({x: current.x + corrected.x,y:current.y + corrected.y,z:current.z + corrected.z});
    // Floor contact from the launch frame must never enable a second jump.
    this.grounded = this.velocityY <= 0 && this.controller.computedGrounded();
    this.collisionsLastStep = this.controller.numComputedCollisions();
    if (this.velocityY > 0) {
      for (let i = 0; i < this.collisionsLastStep; i++) {
        if ((this.controller.computedCollision(i)?.normal1.y ?? 0) < -.2) {
          this.velocityY = 0;
          break;
        }
      }
    }
    if (this.grounded) this.velocityY = 0;
    this.world.step();
    this.steps++;
  }
}
