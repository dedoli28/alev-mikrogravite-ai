import { G0, effectiveOxygen, oxygenTransport } from './Compartment.js';

export const CELL_VIRGIN = 0;
export const CELL_BURNING = 1;
export const CELL_BURNT = 2;
export const CELL_DEAD = 3;

const SAME_BODY_NEIGHBORS = 10;
const OTHER_BODY_NEIGHBORS = 6;
const MAX_NEIGHBORS = SAME_BODY_NEIGHBORS + OTHER_BODY_NEIGHBORS;

/** Flame-to-fuel heating rate (1/s) between two cells one reference spacing apart. */
const SPREAD_RATE = 0.075;
const REFERENCE_SPACING = 0.08;
const PILOT_WINDOW = 0.6;
/** Seconds for the gas around a flame to settle to what the oxidizer supply can sustain. */
const LOCAL_OXYGEN_TIME = 2.5;

const _flow = [0, 0, 0];

function speedAt(comp, pos, i) {
  comp.flowAt(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2], _flow);
  return Math.hypot(_flow[0], _flow[1], _flow[2]);
}

/**
 * Fire-triangle simulation on a cloud of surface cells. Every cell carries fuel,
 * a temperature and a state; it ignites only when fuel, heat (ignition
 * temperature) and oxidizer (effective O2 above the material's LOI) are present
 * together, and goes out as soon as one of them is removed.
 *
 * Plain typed arrays and no rendering dependencies, so it runs headless.
 */
export class CombustionCore {
  constructor(capacity = 4096) {
    this.count = 0;
    this.capacity = 0;
    this._allocate(capacity);

    this.bodyDetached = new Uint8Array(1024);

    this.nbrStart = new Uint32Array(1);
    this.nbrIndex = new Uint32Array(0);
    this.nbrWeight = new Float32Array(0);
    this.nbrDir = new Float32Array(0);

    this.burningCount = 0;
    this.hotCount = 0;
    this.heatReleaseKW = 0;
    this.time = 0;
  }

  _allocate(capacity) {
    const grow = (Type, old, perCell = 1) => {
      const next = new Type(capacity * perCell);
      if (old) next.set(old.subarray(0, this.count * perCell));
      return next;
    };
    this.position = grow(Float32Array, this.position, 3);
    this.normal = grow(Float32Array, this.normal, 3);
    this.temperature = grow(Float32Array, this.temperature);
    this.fuel = grow(Float32Array, this.fuel);
    this.char = grow(Float32Array, this.char);
    this.intensity = grow(Float32Array, this.intensity);
    this.area = grow(Float32Array, this.area);
    this.suppress = grow(Float32Array, this.suppress);
    this.pilot = grow(Float32Array, this.pilot);
    this.localOxygen = grow(Float32Array, this.localOxygen);
    this.rateScale = grow(Float32Array, this.rateScale);
    this.state = grow(Uint8Array, this.state);
    this.material = grow(Uint8Array, this.material);
    this.compartment = grow(Uint8Array, this.compartment);
    this.body = grow(Uint16Array, this.body);
    this.burningList = new Uint32Array(capacity);
    this.hotList = new Uint32Array(capacity);
    this.capacity = capacity;
  }

  addCell(x, y, z, nx, ny, nz, materialIndex, compartmentIndex, bodyIndex, area, temperature, combustible) {
    if (this.count === this.capacity) this._allocate(this.capacity * 2);
    const i = this.count++;
    const i3 = i * 3;
    this.position[i3] = x;
    this.position[i3 + 1] = y;
    this.position[i3 + 2] = z;
    this.normal[i3] = nx;
    this.normal[i3 + 1] = ny;
    this.normal[i3 + 2] = nz;
    this.temperature[i] = temperature;
    this.fuel[i] = combustible ? 1 : 0;
    this.char[i] = 0;
    this.intensity[i] = 0;
    this.area[i] = area;
    this.suppress[i] = 0;
    this.pilot[i] = 0;
    this.localOxygen[i] = 0;
    this.rateScale[i] = 1;
    this.state[i] = CELL_VIRGIN;
    this.material[i] = materialIndex;
    this.compartment[i] = compartmentIndex;
    this.body[i] = bodyIndex;
    if (bodyIndex >= this.bodyDetached.length) {
      const next = new Uint8Array(this.bodyDetached.length * 2);
      next.set(this.bodyDetached);
      this.bodyDetached = next;
    }
    return i;
  }

  /**
   * Links every cell to its nearest cells of the same body (conduction, flame
   * spread along the surface) and of other bodies in the same compartment
   * (radiation / flame contact across a gap).
   */
  buildNeighbors(radius = 0.22) {
    const n = this.count;
    const pos = this.position;
    const inv = 1 / radius;
    const grid = new Map();
    const keyOf = (cx, cy, cz) => (cx * 73856093) ^ (cy * 19349663) ^ (cz * 83492791);
    for (let i = 0; i < n; i++) {
      const k = keyOf(Math.floor(pos[i * 3] * inv), Math.floor(pos[i * 3 + 1] * inv), Math.floor(pos[i * 3 + 2] * inv));
      let bucket = grid.get(k);
      if (!bucket) grid.set(k, (bucket = []));
      bucket.push(i);
    }

    const start = new Uint32Array(n + 1);
    const index = new Uint32Array(n * MAX_NEIGHBORS);
    const weight = new Float32Array(n * MAX_NEIGHBORS);
    const dir = new Float32Array(n * MAX_NEIGHBORS * 3);
    const spacing = new Float32Array(n);
    const r2 = radius * radius;
    const same = [];
    const other = [];
    const byDistance = (a, b) => a.d2 - b.d2;
    let cursor = 0;

    for (let i = 0; i < n; i++) {
      start[i] = cursor;
      same.length = 0;
      other.length = 0;
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const cx = Math.floor(x * inv);
      const cy = Math.floor(y * inv);
      const cz = Math.floor(z * inv);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (let oz = -1; oz <= 1; oz++) {
            const bucket = grid.get(keyOf(cx + ox, cy + oy, cz + oz));
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const j = bucket[b];
              if (j === i || this.compartment[j] !== this.compartment[i]) continue;
              const dx = pos[j * 3] - x;
              const dy = pos[j * 3 + 1] - y;
              const dz = pos[j * 3 + 2] - z;
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 > r2 || d2 < 1e-10) continue;
              (this.body[j] === this.body[i] ? same : other).push({ j, d2, dx, dy, dz });
            }
          }
        }
      }
      same.sort(byDistance);
      other.sort(byDistance);
      const take = (list, limit) => {
        const m = Math.min(limit, list.length);
        for (let k = 0; k < m; k++) {
          const e = list[k];
          const d = Math.sqrt(e.d2);
          index[cursor] = e.j;
          weight[cursor] = d;
          dir[cursor * 3] = e.dx / d;
          dir[cursor * 3 + 1] = e.dy / d;
          dir[cursor * 3 + 2] = e.dz / d;
          cursor++;
        }
      };
      take(same, SAME_BODY_NEIGHBORS);
      take(other, OTHER_BODY_NEIGHBORS);

      // Local cell spacing: mean distance to the nearest few cells of the same body.
      let h = 0;
      const near = Math.min(4, same.length);
      for (let k = 0; k < near; k++) h += Math.sqrt(same[k].d2);
      spacing[i] = near > 0 ? h / near : REFERENCE_SPACING;
    }
    start[n] = cursor;

    // A finer mesh has thinner cells that heat and cool proportionally faster. With
    // every rate scaled by 1/spacing, both the flame front speed and the conditions
    // under which spread stalls stop depending on how densely an object is meshed.
    for (let i = 0; i < n; i++) {
      this.rateScale[i] = Math.min(3, Math.max(0.5, REFERENCE_SPACING / spacing[i]));
    }
    for (let i = 0; i < n; i++) {
      for (let k = start[i]; k < start[i + 1]; k++) {
        const j = index[k];
        const sameBody = this.body[j] === this.body[i];
        const h = sameBody ? spacing[j] : Math.max(spacing[j], REFERENCE_SPACING);
        const q = weight[k] / (h * 2.6);
        weight[k] = this.rateScale[j] * Math.max(0, 1 - q * q);
      }
    }
    this.nbrStart = start;
    this.nbrIndex = index.slice(0, cursor);
    this.nbrWeight = weight.slice(0, cursor);
    this.nbrDir = dir.slice(0, cursor * 3);
  }

  /**
   * @param {number} dt seconds
   * @param {{gravity:number[], compartments:object[], materials:object[]}} env
   */
  step(dt, env) {
    const { compartments, materials } = env;
    const gx = env.gravity[0];
    const gy = env.gravity[1];
    const gz = env.gravity[2];
    const gMag = Math.hypot(gx, gy, gz);
    const gN = Math.min(1, gMag / G0);
    const upx = gMag > 1e-6 ? -gx / gMag : 0;
    const upy = gMag > 1e-6 ? -gy / gMag : 0;
    const upz = gMag > 1e-6 ? -gz / gMag : 0;

    const n = this.count;
    const { position: pos, temperature: temp, fuel, char, intensity, state, suppress, pilot, localOxygen } = this;
    const { nbrStart, nbrIndex, nbrWeight, nbrDir, body, bodyDetached, rateScale } = this;
    let nBurn = 0;
    let nHot = 0;
    let heatKW = 0;
    this.time += dt;

    for (let i = 0; i < n; i++) {
      const st = state[i];
      if (st === CELL_DEAD) continue;
      if (suppress[i] > 0) suppress[i] -= dt;
      if (pilot[i] > 0) pilot[i] -= dt;

      const comp = compartments[this.compartment[i]];
      const mat = materials[this.material[i]];
      let T = temp[i];

      if (st === CELL_BURNING) {
        const i3 = i * 3;
        comp.flowAt(pos[i3], pos[i3 + 1], pos[i3 + 2], _flow);
        const u = Math.hypot(_flow[0], _flow[1], _flow[2]);
        const transport = oxygenTransport(gN, u);
        let supply = effectiveOxygen(comp.o2Fraction, comp.pressure, transport);
        if (mat.selfOxidizing) supply = Math.max(supply, 0.21);
        // The gas right at the flame drifts toward what the supply can sustain: a
        // flame lit in still microgravity air burns the oxygen around it, then
        // fades as its own products pile up.
        localOxygen[i] += (supply - localOxygen[i]) * Math.min(1, dt / LOCAL_OXYGEN_TIME);
        const oxEff = localOxygen[i];
        const limit = mat.loi * 0.93;

        if (oxEff < limit || suppress[i] > 0) {
          // Oxidizer side of the triangle removed: the flame goes out, the fuel stays.
          // Without the flame the surface drops back below its ignition point, so
          // it does not simply relight itself from its own stored heat.
          state[i] = CELL_VIRGIN;
          intensity[i] = 0;
          pilot[i] = 0;
          temp[i] = Math.min(T, mat.ignitionTemp * 0.85);
          continue;
        }

        const margin = Math.min(1, (oxEff - limit) / (mat.loi * 0.2));
        const power = Math.min(3, (oxEff / 0.21) ** 1.6) * (0.25 + 0.75 * margin * (2 - margin));
        const rate = mat.burnRate * power;
        const burnt = rate * dt * this.area[i];
        fuel[i] -= (rate * dt) / mat.fuelLoad;
        comp.consume(burnt * mat.stoichO2, burnt, burnt * mat.heatOfCombustion);
        heatKW += rate * this.area[i] * mat.heatOfCombustion * 1000;

        const flameT = mat.flameTemp * (0.72 + 0.28 * Math.min(1, transport)) * (0.9 + 0.1 * Math.min(power, 2));
        T += (flameT - T) * Math.min(1, dt * 4);
        temp[i] = T;
        intensity[i] += (power - intensity[i]) * Math.min(1, dt * 2.5);
        char[i] = Math.max(char[i], 0.35 + 0.65 * (1 - Math.max(0, fuel[i])));

        // Direction the flame leans: up the buoyant plume at 1 g, with the wind in
        // strong flow, and toward the incoming fresh oxidizer in microgravity.
        const uInv = u > 1e-5 ? 1 / u : 0;
        const fx = _flow[0] * uInv;
        const fy = _flow[1] * uInv;
        const fz = _flow[2] * uInv;
        const flowBias =
          gN * 0.8 * Math.min(1, u) - (1 - gN) * 0.5 * Math.min(1, u / 0.3) + Math.min(1.5, Math.max(0, u - 0.6) * 0.6);
        // Without buoyancy the flame stands off the surface and feeds less heat back into the fuel.
        const reach = SPREAD_RATE * intensity[i] * (0.5 + 0.5 * gN) * (0.45 + 0.55 * Math.min(1, transport)) * dt;
        const myBody = body[i];
        const myDetached = bodyDetached[myBody];

        for (let k = nbrStart[i], end = nbrStart[i + 1]; k < end; k++) {
          const j = nbrIndex[k];
          if (state[j] === CELL_DEAD) continue;
          if (body[j] !== myBody && (myDetached || bodyDetached[body[j]])) continue;
          const k3 = k * 3;
          const ex = nbrDir[k3];
          const ey = nbrDir[k3 + 1];
          const ez = nbrDir[k3 + 2];
          const cosUp = ex * upx + ey * upy + ez * upz;
          const cosFlow = ex * fx + ey * fy + ez * fz;
          const bias = Math.max(0.12, (1 + gN * (cosUp > 0 ? 2.2 * cosUp : 0.7 * cosUp)) * (1 + cosFlow * flowBias));
          const w = nbrWeight[k];
          const dT = (reach * w * bias * (flameT - temp[j])) / materials[this.material[j]].thermalInertia;
          if (dT > 0) {
            temp[j] += dT;
            pilot[j] = PILOT_WINDOW;
            if (state[j] === CELL_VIRGIN && char[j] < 0.5) char[j] += (mat.soot * dt * 0.05 * w) / rateScale[j];
          }
        }

        if (fuel[i] <= 0) {
          fuel[i] = 0;
          char[i] = 1;
          state[i] = CELL_BURNT;
          intensity[i] = 0;
        } else {
          this.burningList[nBurn++] = i;
        }
        continue;
      }

      const ambient = comp.temperature;
      if (T <= ambient + 1) continue;

      if (T > ambient + 25) {
        const kdt = Math.min(0.06, (dt * mat.conductivity * rateScale[i]) / SAME_BODY_NEIGHBORS);
        const myBody = body[i];
        for (let k = nbrStart[i], end = nbrStart[i + 1]; k < end; k++) {
          const j = nbrIndex[k];
          if (body[j] !== myBody || state[j] === CELL_DEAD || state[j] === CELL_BURNING) continue;
          const diff = T - temp[j];
          if (diff > 0) {
            const f = diff * kdt;
            temp[j] += f;
            T -= f;
          }
        }
      }

      // Convection needs gas: in vacuum only radiation is left, so things stay hot longer.
      const pAtm = Math.min(1, comp.pressure / 101.325);
      T += (ambient - T) * Math.min(1, dt * mat.coolRate * rateScale[i] * (0.2 + 0.8 * pAtm));
      temp[i] = T;

      if (st === CELL_VIRGIN && fuel[i] > 0 && suppress[i] <= 0) {
        const threshold = pilot[i] > 0 ? mat.ignitionTemp : mat.autoIgnitionTemp;
        if (T >= threshold) {
          // Ignition needs the surrounding gas itself to be flammable; whether the
          // flame then survives depends on how well oxidizer keeps reaching it.
          let ambientOx = effectiveOxygen(comp.o2Fraction, comp.pressure, 1);
          if (mat.selfOxidizing) ambientOx = Math.max(ambientOx, 0.21);
          if (ambientOx >= mat.loi) {
            state[i] = CELL_BURNING;
            intensity[i] = 0.05;
            // Lit by a neighbouring flame, the gas here is already partly used up.
            const supply = effectiveOxygen(comp.o2Fraction, comp.pressure, oxygenTransport(gN, speedAt(comp, pos, i)));
            localOxygen[i] = Math.max(supply, supply + (ambientOx - supply) * 0.6);
            this.burningList[nBurn++] = i;
            continue;
          }
        }
        if (T > mat.ignitionTemp * 0.82) this.hotList[nHot++] = i;
      }
    }

    this.burningCount = nBurn;
    this.hotCount = nHot;
    this.heatReleaseKW = heatKW;
  }

  /** Adds heat to every cell inside a sphere; `pilot` marks it as a flame/spark source. */
  heatSphere(x, y, z, radius, deltaT, pilot = true, maxTemp = 2600, inertia = null) {
    const r2 = radius * radius;
    const pos = this.position;
    let touched = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === CELL_DEAD) continue;
      const dx = pos[i * 3] - x;
      const dy = pos[i * 3 + 1] - y;
      const dz = pos[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const falloff = 1 - d2 / r2;
      // inertia: malzeme dizini → ısıl eylemsizlik. Kısa bir ısı darbesi (patlama) kalın metali
      // ince kumaş kadar ısıtmaz; verilmezse (alev tüyü, kıvılcım) hepsi aynı ısınır.
      const k = inertia ? 1 / Math.max(1, inertia[this.material[i]]) : 1;
      this.temperature[i] = Math.min(maxTemp, this.temperature[i] + deltaT * falloff * falloff * k);
      if (pilot) this.pilot[i] = Math.max(this.pilot[i], 1.5);
      touched++;
    }
    return touched;
  }

  /** Extinguishing agent: displaces oxygen for `seconds` and cools the fuel. */
  suppressSphere(x, y, z, radius, seconds, coolTo = 320) {
    const r2 = radius * radius;
    const pos = this.position;
    let touched = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === CELL_DEAD) continue;
      const dx = pos[i * 3] - x;
      const dy = pos[i * 3 + 1] - y;
      const dz = pos[i * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      this.suppress[i] = Math.max(this.suppress[i], seconds);
      this.temperature[i] = Math.min(this.temperature[i], coolTo);
      touched++;
    }
    return touched;
  }

  scorchSphere(x, y, z, radius, amount) {
    const r2 = radius * radius;
    const pos = this.position;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === CELL_DEAD) continue;
      const dx = pos[i * 3] - x;
      const dy = pos[i * 3 + 1] - y;
      const dz = pos[i * 3 + 2] - z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) continue;
      const f = 1 - d2 / r2;
      this.char[i] = Math.min(1, Math.max(this.char[i], amount * f));
    }
  }
}
