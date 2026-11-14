const R_GAS = 8.314;
const M_O2 = 0.032;
const M_INERT = 0.0285;
const CV_GAS = 718;
const G0 = 9.80665;

export const P_ATM = 101.325;

/**
 * How well fresh oxidizer reaches a flame, 0..~1.1.
 *
 * At 1 g the hot products rise and pull fresh air into the base of the flame, so
 * the supply is good regardless of forced flow. In microgravity there is no
 * buoyant plume: a flame in still air is fed by diffusion only and chokes on its
 * own products, while a slow forced flow (~0.1-0.2 m/s) feeds it very well.
 * Very fast flow (decompression wind) strains the flame until it blows off.
 */
export function oxygenTransport(gNorm, flowSpeed) {
  const g = Math.min(1, Math.max(0, gNorm));
  const buoyant = 0.3 + 0.7 * Math.sqrt(g);
  const x = flowSpeed / 0.15;
  const forced = 0.75 * (1 - g) * x * Math.exp(1 - x);
  const sustained = (1 - g) * 0.45 * (1 - Math.exp(-flowSpeed / 0.4));
  const blowOff = 1 / (1 + (flowSpeed / 7) ** 2);
  return Math.min(1.1, buoyant + Math.max(forced, sustained)) * blowOff;
}

/** Effective oxygen index seen by a flame; compare against a material's LOI. */
export function effectiveOxygen(o2Fraction, pressureKPa, transport) {
  const pAtm = Math.max(0, pressureKPa / P_ATM);
  return o2Fraction * Math.sqrt(Math.min(pAtm, 1.5)) * (0.55 + 0.45 * transport);
}

/**
 * A volume of gas that fuel burns in: a sealed cabin, a module, or open space.
 * Tracks oxygen and inert gas mass, so combustion depletes the oxidizer, heats
 * the gas, raises pressure, and a hull breach vents everything to vacuum.
 */
export class Compartment {
  constructor(options = {}) {
    this.name = options.name ?? 'Bölme';
    this.volume = options.volume ?? 70;
    this.isVacuum = options.vacuum === true || !Number.isFinite(this.volume);
    this.wallTemperature = options.temperature ?? 295;
    this.temperature = this.wallTemperature;
    this.ventilation = { x: 0, y: 0, z: 0 };
    if (options.ventilation) this.setVentilation(options.ventilation.x, options.ventilation.y, options.ventilation.z);
    /** Speeds up oxygen depletion so a demo does not take minutes; 1 = physical. */
    this.chemistryScale = options.chemistryScale ?? 1;
    /** Overpressure (kPa above initial) the hull tolerates before `onOverpressure` fires. */
    this.burstOverpressure = options.burstOverpressure ?? 60;
    /** Share of the heat release that ends up in the gas; the rest goes into walls and structure. */
    this.gasHeatFraction = options.gasHeatFraction ?? 1;
    /** Positive-pressure relief valve: vents gas above this overpressure (kPa); 0 = none. */
    this.reliefOverpressure = options.reliefOverpressure ?? 0;
    this.reliefOpen = false;
    this.onOverpressure = null;
    this.breaches = [];
    this.ventMassRate = 0;
    this.index = -1;
    this._o2 = 0;
    this._inert = 0;
    this._initial = {
      pressure: this.isVacuum ? 0 : options.pressure ?? P_ATM,
      o2Fraction: this.isVacuum ? 0 : options.o2Fraction ?? 0.209,
    };
    this.setAtmosphere(this._initial.pressure, this._initial.o2Fraction);
    this._designPressure = this._initial.pressure;
    this._burstFired = false;
  }

  setAtmosphere(pressureKPa, o2Fraction) {
    if (this.isVacuum) return;
    const moles = (pressureKPa * 1000 * this.volume) / (R_GAS * this.temperature);
    const f = Math.min(1, Math.max(0, o2Fraction));
    this._o2 = moles * f * M_O2;
    this._inert = moles * (1 - f) * M_INERT;
  }

  setO2Fraction(o2Fraction) {
    this.setAtmosphere(this.pressure, o2Fraction);
  }

  setVentilation(x, y, z) {
    this.ventilation.x = x;
    this.ventilation.y = y;
    this.ventilation.z = z;
  }

  get moles() {
    return this._o2 / M_O2 + this._inert / M_INERT;
  }

  /** kPa */
  get pressure() {
    if (this.isVacuum) return 0;
    return (this.moles * R_GAS * this.temperature) / this.volume / 1000;
  }

  /** Mole fraction of O2, 0..1 */
  get o2Fraction() {
    const n = this.moles;
    return n > 1e-9 ? this._o2 / M_O2 / n : 0;
  }

  get gasMass() {
    return this._o2 + this._inert;
  }

  /** Combustion: removes oxygen, adds products and heat. */
  consume(o2Kg, fuelKg, heatMJ) {
    if (this.isVacuum) return;
    const scale = this.chemistryScale;
    const used = Math.min(this._o2, o2Kg * scale);
    this._o2 -= used;
    this._inert += used + fuelKg * scale;
    this.addHeat(heatMJ * this.gasHeatFraction);
  }

  addGas(o2Kg, inertKg = 0) {
    if (this.isVacuum) return;
    this._o2 += o2Kg;
    this._inert += inertKg;
  }

  addHeat(heatMJ) {
    if (this.isVacuum) return;
    const m = this.gasMass;
    if (m < 1e-6) return;
    this.temperature = Math.min(1600, this.temperature + (heatMJ * 1e6) / (m * CV_GAS));
  }

  breach(x, y, z, area = 0.05, nx = 0, ny = 0, nz = 0) {
    if (this.isVacuum) return null;
    const hole = { x, y, z, nx, ny, nz, area };
    this.breaches.push(hole);
    return hole;
  }

  get breached() {
    return this.breaches.length > 0;
  }

  step(dt) {
    if (this.isVacuum) return;
    this.ventMassRate = 0;
    const m = this.gasMass;
    if (this.breaches.length > 0 && m > 1e-5) {
      const pPa = this.pressure * 1000;
      let area = 0;
      for (const b of this.breaches) area += b.area;
      // Choked flow of air through an orifice into vacuum.
      const mdot = (0.62 * area * pPa * 0.0404) / Math.sqrt(this.temperature);
      const out = Math.min(m, mdot * dt);
      const keep = 1 - out / m;
      this._o2 *= keep;
      this._inert *= keep;
      this.ventMassRate = out / dt;
      // Expanding gas cools (the fog seen during rapid decompression).
      this.temperature = Math.max(220, this.temperature * (1 - 0.28 * (1 - keep)));
    }
    this.temperature += (this.wallTemperature - this.temperature) * Math.min(1, dt / 25);

    // Relief valve: a slow pressure rise (fire heating the gas) is vented overboard, composition unchanged.
    this.reliefOpen = false;
    if (this.reliefOverpressure > 0 && this.breaches.length === 0) {
      const limit = this._designPressure + this.reliefOverpressure;
      const p = this.pressure;
      if (p > limit) {
        const keep = Math.max(limit / p, 1 - 0.5 * dt);
        this._o2 *= keep;
        this._inert *= keep;
        this.reliefOpen = true;
      }
    }

    if (!this._burstFired && this.onOverpressure && this.pressure - this._designPressure > this.burstOverpressure) {
      this._burstFired = true;
      this.onOverpressure(this);
    }
  }

  /** Gas velocity (m/s) at a point: ventilation plus the sink flow toward any breach. */
  flowAt(x, y, z, out) {
    out[0] = this.ventilation.x;
    out[1] = this.ventilation.y;
    out[2] = this.ventilation.z;
    if (this.ventMassRate > 0) {
      const rho = this.gasMass / this.volume;
      const total = this.ventMassRate / Math.max(rho, 1e-4);
      let area = 0;
      for (const b of this.breaches) area += b.area;
      for (const b of this.breaches) {
        const q = (total * b.area) / area;
        const dx = b.x - x;
        const dy = b.y - y;
        const dz = b.z - z;
        const r2 = Math.max(dx * dx + dy * dy + dz * dz, 0.04);
        const r = Math.sqrt(r2);
        const speed = Math.min(60, q / (2 * Math.PI * r2));
        out[0] += (dx / r) * speed;
        out[1] += (dy / r) * speed;
        out[2] += (dz / r) * speed;
      }
    }
    return out;
  }

  reset() {
    this.breaches.length = 0;
    this.ventMassRate = 0;
    this.temperature = this.wallTemperature;
    this._burstFired = false;
    this.setAtmosphere(this._initial.pressure, this._initial.o2Fraction);
  }
}

export { G0 };
