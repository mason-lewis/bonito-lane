import * as THREE from 'three/webgpu';
import { assetUrl } from './asset-url';
import { texture, equirectUV } from 'three/tsl';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

/** Photographed linear HDR daylight. One sky drives background and PBR reflections. */
export async function createDaylight(renderer: THREE.WebGPURenderer, scene: THREE.Scene, sun: THREE.DirectionalLight) {
  const sky = await new HDRLoader().setDataType(THREE.HalfFloatType).loadAsync(assetUrl('/environments/coastal-sky-2k.hdr'));
  sky.mapping = THREE.EquirectangularReflectionMapping;
  // HDRLoader already marks this linear. Never apply an sRGB decode to radiance.
  const { data, width, height } = sky.image as {data:Uint16Array;width:number;height:number};
  let brightest=0, sunX=0, sunY=0;
  const indirectPixels = new Uint16Array(data);
  const linear=(i:number)=>THREE.DataUtils.fromHalfFloat(data[i]);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const i=(y*width+x)*4;
    const luminance=linear(i)*.2126+linear(i+1)*.7152+linear(i+2)*.0722;
    if(y<height/2 && luminance>brightest){brightest=luminance;sunX=x;sunY=y;}
    // The shadow-casting sun supplies the direct solar energy. Remove only its
    // extreme core from indirect illumination to avoid counting it twice.
    const scale=luminance>12?12/luminance:1;
    for(let c=0;c<3;c++)indirectPixels[i+c]=THREE.DataUtils.toHalfFloat(linear(i+c)*scale);
  }
  const phi=((sunX+.5)/width-.5)*Math.PI*2;
  const elevation=(.5-(sunY+.5)/height)*Math.PI;
  const direction=new THREE.Vector3(Math.cos(elevation)*Math.cos(phi),Math.sin(elevation),Math.cos(elevation)*Math.sin(phi));
  sun.position.copy(sun.target.position).addScaledVector(direction,65);
  sun.updateMatrixWorld();
  const indirect=new THREE.DataTexture(indirectPixels,width,height,THREE.RGBAFormat,THREE.HalfFloatType);
  indirect.mapping=THREE.EquirectangularReflectionMapping;indirect.colorSpace=THREE.LinearSRGBColorSpace;
  indirect.flipY=true;indirect.needsUpdate=true;
  const generator=new THREE.PMREMGenerator(renderer) as THREE.PMREMGenerator & {
    fromEquirectangularAsync(texture:THREE.Texture):Promise<THREE.RenderTarget>;
  };
  const environment=await generator.fromEquirectangularAsync(indirect);
  scene.environment=environment.texture;scene.environmentIntensity=.5;
  scene.background=sky;scene.backgroundNode=texture(sky,equirectUV()) as unknown as NonNullable<THREE.Scene['backgroundNode']>;scene.backgroundIntensity=1.3;scene.backgroundBlurriness=0;
  indirect.dispose();generator.dispose();
  return { environment, sky, direction, dispose(){environment.dispose();sky.dispose();} };
}
