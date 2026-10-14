/** Walk intent is independent of browser pointer capture and temporary menus. */
export class WalkSession {
  active = false;
  suspended = false;
  mouseLook = false;
  pointerLocked = false;
  private freeLook = false;

  start(mouseLook = false) {
    this.active = true;
    this.suspended = false;
    this.mouseLook ||= mouseLook;
  }
  pause() { this.suspended = true; }
  resume() { this.suspended = false; }
  stop() {
    this.active = false;
    this.suspended = false;
    this.mouseLook = false;
    this.pointerLocked = false;
    this.freeLook = false;
  }
  captureChanged(locked: boolean) {
    this.pointerLocked = locked;
    // Embedded browsers may refuse capture or release it when a panel opens.
    // Preserve mouse look intent; Escape explicitly stops the walk session.
    this.freeLook = !locked && this.mouseLook;
  }
  get reticleVisible() { return this.active && !this.suspended; }
  get hoverLook() { return this.reticleVisible && this.mouseLook && this.freeLook; }
  get wantsCapture() { return this.reticleVisible && this.mouseLook && !this.pointerLocked; }
}

/** Repeated keydown after Escape/blur must not restart a held movement key. */
export class MovementKeys {
  readonly down = new Set<string>();
  private suppressed = new Set<string>();
  press(code: string, repeat: boolean) {
    if(!repeat)this.suppressed.delete(code);
    if(this.suppressed.has(code) || (repeat && !this.down.has(code)))return false;
    this.down.add(code);return true;
  }
  release(code: string) {this.down.delete(code);this.suppressed.delete(code);}
  clear() {for(const code of this.down)this.suppressed.add(code);this.down.clear();}
}

/** Uncaptured cursors need edge turning to look all the way around the room. */
export function edgeLookVelocity(x: number, y: number, width: number, height: number): [number, number] {
  const edge=(value:number,size:number)=>Math.sign(value-size/2)*Math.max(0,Math.min(1,(Math.abs(value-size/2)/Math.max(1,size/2)-.88)/.12));
  return [edge(x,width)*1.15,edge(y,height)*.8];
}
