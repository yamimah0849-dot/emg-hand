// "Demon" look for the hand: charcoal skin with glowing veins, and claws on the fingertips.
//
// The veins are drawn by a shader, not a texture. The pattern is computed from each point's position
// on the hand in its rest pose, so it stays stuck to the skin when the fingers bend. Each bone has a
// glow level (0..1), blended across the skin with the same weights that bend the mesh, so the veins
// on the thumb light up when the thumb flexes, and so on.
import * as THREE from 'three';

// 3D simplex noise by Ashima Arts / Stefan Gustavson (webgl-noise, MIT license).
const NOISE_GLSL = /* glsl */`
vec3 dh_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 dh_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 dh_permute(vec4 x) { return dh_mod289(((x * 34.0) + 10.0) * x); }
vec4 dh_taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float dh_snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = dh_mod289(i);
  vec4 p = dh_permute(dh_permute(dh_permute(
            i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = dh_taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

export const DEMON_SKIN = 0x2a2727;   // dark charcoal

// Skin material for the demon hand. boneCount must match the skeleton; veinAxis is the wrist-to-
// fingertip direction in the model's rest pose, so the veins run along the hand like real ones.
export function createDemonMaterial({ boneCount, veinAxis, handLength }) {
  const uniforms = {
    uBoneGlow: { value: new Float32Array(boneCount) },
    uPhase: { value: 0 },
    uVeinAxis: { value: veinAxis.clone().normalize() },
    uVeinScale: { value: 5.2 / handLength },   // about five vein "cells" from wrist to fingertip
    uVeinDim: { value: new THREE.Color(0x8a0d04) },
    uVeinHot: { value: new THREE.Color(0xff5a12) },
    uRim: { value: new THREE.Color(0xff2a10) },
  };

  const material = new THREE.MeshPhysicalMaterial({
    color: DEMON_SKIN,
    roughness: 0.58,
    metalness: 0.0,
    sheen: 0.5, sheenRoughness: 0.5, sheenColor: new THREE.Color(0x5a1410),   // faint ember-red edge
    clearcoat: 0.18, clearcoatRoughness: 0.45,
    specularIntensity: 0.45,
  });
  material.userData.uniforms = uniforms;

  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        #define DH_BONES ${boneCount}
        uniform float uBoneGlow[DH_BONES];
        varying vec3 vRestPos;
        varying float vGlow;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vRestPos = position;
        #ifdef USE_SKINNING
          vGlow = uBoneGlow[int(skinIndex.x)] * skinWeight.x + uBoneGlow[int(skinIndex.y)] * skinWeight.y
                + uBoneGlow[int(skinIndex.z)] * skinWeight.z + uBoneGlow[int(skinIndex.w)] * skinWeight.w;
        #else
          vGlow = uBoneGlow[0];
        #endif`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uPhase;
        uniform vec3 uVeinAxis;
        uniform float uVeinScale;
        uniform vec3 uVeinDim;
        uniform vec3 uVeinHot;
        uniform vec3 uRim;
        varying vec3 vRestPos;
        varying float vGlow;
        ${NOISE_GLSL}
        // A line along the places where the noise value n crosses zero. |n| divided by its slope is
        // roughly the distance to that line in pixels; times the size of a pixel on the model, it's a
        // distance on the skin. So the line keeps the same real width everywhere (width and pxSize
        // are in model units), anti-aliased over about one pixel.
        float dh_line(float n, float width, float pxSize) {
          float slope = max(length(vec2(dFdx(n), dFdy(n))), 1e-5);
          float d = abs(n) / slope * pxSize;
          return 1.0 - smoothstep(width - pxSize * 0.75, width + pxSize * 0.75, d);
        }
        // Bump mapping without a texture: tilt the normal by the screen-space slope of a height value.
        vec3 dh_bump(vec3 surfPos, vec3 surfNorm, float height, float faceDir) {
          vec3 sx = normalize(dFdx(surfPos));
          vec3 sy = normalize(dFdy(surfPos));
          vec3 r1 = cross(sy, surfNorm);
          vec3 r2 = cross(surfNorm, sx);
          float det = dot(sx, r1) * faceDir;
          vec3 grad = sign(det) * (dFdx(height) * r1 + dFdy(height) * r2);
          return normalize(abs(det) * surfNorm - grad);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          // Stretch the pattern along the hand so the veins run lengthwise, then warp it so they wander.
          vec3 q = vRestPos * uVeinScale;
          q -= uVeinAxis * dot(q, uVeinAxis) * 0.55;
          q += 0.45 * vec3(dh_snoise(q * 0.6 + 11.3), dh_snoise(q * 0.6 + 27.1), dh_snoise(q * 0.6 + 43.7));
          float px = length(fwidth(vRestPos));            // size of one screen pixel on the model
          float L = 1.0 / uVeinScale;                       // one vein "cell", in model units
          float n1 = dh_snoise(q);
          float n2 = dh_snoise(q * 2.3 + 5.7);
          // Masks break the lines up so they end and branch instead of forming closed loops.
          float mainMask = smoothstep(-0.55, -0.05, dh_snoise(q * 0.45 + 31.0));
          float branchMask = smoothstep(0.0, 0.5, dh_snoise(q * 0.8 + 71.0));
          float mainVein = dh_line(n1, L * 0.022, px) * mainMask;
          float branch = dh_line(n2, L * 0.012, px) * branchMask * mainMask;
          float vein = max(mainVein, branch * 0.8);
          // Soft glow spreading into the skin around the veins (only visible while flexing).
          float halo = (1.0 - smoothstep(0.0, 0.16, abs(n1))) * mainMask * 0.4
                     + (1.0 - smoothstep(0.0, 0.1, abs(n2))) * branchMask * mainMask * 0.18;

          // Mottled, leathery skin, with the veins slightly raised.
          float mottle = dh_snoise(vRestPos * uVeinScale * 7.0);
          diffuseColor.rgb *= 0.84 + 0.2 * mottle;
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.008, 0.006), vein * 0.8);
          roughnessFactor = clamp(roughnessFactor - vein * 0.15, 0.05, 1.0);
          normal = dh_bump(-vViewPosition, normal, vein * 0.35 + mottle * 0.03, faceDirection);

          // Glow: a dim ember at rest, brightening and shifting toward orange as the muscle works.
          float g = clamp(vGlow, 0.0, 1.0);
          float pulse = 0.8 + 0.2 * sin(uPhase - dot(vRestPos, uVeinAxis) * uVeinScale * 2.2);
          vec3 veinColor = mix(uVeinDim, uVeinHot, g * g);
          float strength = (0.35 + 4.0 * g * g) * pulse;
          totalEmissiveRadiance += veinColor * (vein + halo * g * g) * strength;

          // Red rim light on the silhouette that grows with effort, so the whole hand seems to smoulder.
          float rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 2.5);
          totalEmissiveRadiance += uRim * rim * (0.06 + 0.7 * g * g);
        }`);
  };
  // Tell three.js this material's shader differs from a plain MeshPhysicalMaterial.
  material.customProgramCacheKey = () => `demon-skin-${boneCount}`;
  return material;
}

// A curved, tapering claw that starts at the origin and points along -Z, curling toward -Y
// (in WebXR joint space that is toward the palm). Laterally flattened like an animal claw.
export function createClawGeometry({ length, radius, curl = 0.32, rings = 18, sides = 14 }) {
  const positions = [];
  const indices = [];
  const center = t => new THREE.Vector3(0, -curl * length * t * t, -length * t);
  const tangentAt = t => new THREE.Vector3(0, -2 * curl * length * t, -length).normalize();
  const side = new THREE.Vector3(1, 0, 0);
  for (let r = 0; r < rings; r++) {
    const t = r / (rings - 1) * 0.985;                  // stop just short of the tip, then close it
    const c = center(t);
    const tan = tangentAt(t);
    const up = new THREE.Vector3().crossVectors(tan, side).normalize().negate();
    const taper = Math.pow(1 - t, 0.85);
    const rx = radius * 0.72 * taper;                   // narrower side to side
    const ry = radius * taper;                          // taller top to bottom
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      // Slightly pointed on top, like a keel along the back of the claw.
      const keel = 1 + 0.18 * Math.max(0, Math.sin(a)) ** 6;
      const p = c.clone()
        .addScaledVector(side, Math.cos(a) * rx)
        .addScaledVector(up, Math.sin(a) * ry * keel);
      positions.push(p.x, p.y, p.z);
    }
  }
  const tip = center(1);
  positions.push(tip.x, tip.y, tip.z);
  const tipIndex = rings * sides;
  for (let r = 0; r < rings - 1; r++) {
    for (let s = 0; s < sides; s++) {
      const a = r * sides + s, b = r * sides + (s + 1) % sides;
      const c = a + sides, d = b + sides;
      indices.push(a, c, b, b, c, d);
    }
  }
  const last = (rings - 1) * sides;
  for (let s = 0; s < sides; s++) indices.push(last + s, tipIndex, last + (s + 1) % sides);
  // The base is hidden inside the fingertip, so it needs no cap.
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

export function createClawMaterial() {
  return new THREE.MeshPhysicalMaterial({
    color: 0x0c0a0a,          // glossy obsidian black
    roughness: 0.22,
    metalness: 0.15,
    clearcoat: 1.0, clearcoatRoughness: 0.12,
    emissive: 0x7a1206,       // heats up red with effort (intensity set per frame)
    emissiveIntensity: 0,
  });
}
