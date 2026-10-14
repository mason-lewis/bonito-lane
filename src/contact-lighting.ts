import * as THREE from 'three/webgpu';
import { mix, pass, vec4 } from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';

/** Optional, bounded GTAO contact shading; no geometry or material replacement. */
export function createContactLighting(renderer:THREE.WebGPURenderer, scene:THREE.Scene, camera:THREE.PerspectiveCamera, debug:string|null) {
  // A sampled depth texture must agree with the beauty pass. Explicitly avoid
  // the renderer's 4x MSAA here; the direct low-quality render keeps its MSAA.
  const scenePass=pass(scene,camera,{samples:0});
  const beauty=scenePass.getTextureNode('output');
  const depth=scenePass.getTextureNode('depth');
  // r180 supports null (reconstruct normals from depth); @types omits null.
  const contact=ao(depth,null as unknown as THREE.Node,camera);
  contact.resolutionScale=.5;
  contact.radius.value=.23;
  contact.thickness.value=.18;
  contact.distanceExponent.value=1.2;
  contact.distanceFallOff.value=1;
  contact.samples.value=16;
  contact.scale.value=1;
  const visibility=contact.getTextureNode().r.clamp(0,1);
  const post=new THREE.PostProcessing(renderer);
  post.outputNode=debug==='beauty'?beauty:debug==='ao'?vec4(visibility,visibility,visibility,1):vec4(beauty.rgb.mul(mix(.74,1,visibility)),beauty.a);
  return {
    render(){post.render();},
    dispose(){post.dispose();contact.dispose();scenePass.dispose();},
    description:debug?`Contact preview · ${debug}`:'GTAO contact shading · half resolution',
  };
}
