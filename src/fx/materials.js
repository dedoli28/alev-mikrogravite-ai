/**
 * Combustion properties per material. Values are order-of-magnitude figures taken
 * from fire-safety literature (piloted ignition temperature, limiting oxygen index,
 * heat of combustion); they are meant to rank materials correctly against each
 * other, not to replace a certified flammability test.
 *
 *  ignitionTemp      K     piloted ignition (a flame or spark is already present)
 *  autoIgnitionTemp  K     ignition by heat alone
 *  loi               0..1  limiting oxygen index: minimum effective O2 fraction that sustains a flame
 *  fuelLoad          kg/m² burnable mass per unit of surface
 *  burnRate          kg/m²/s mass loss rate in normal air at 1 g
 *  heatOfCombustion  MJ/kg
 *  stoichO2          kg of O2 consumed per kg of fuel
 *  flameTemp         K     visible flame temperature in normal air at 1 g
 *  soot              0..1  smoke yield
 *  thermalInertia    -     >1 heats up slower (dense / thick), <1 faster (thin / light)
 *  conductivity      1/s   how fast heat spreads inside the object
 *  coolRate          1/s   heat loss to the surrounding gas at 1 atm
 *  burnsAway         bool  thin fuel that is consumed completely (leaves holes)
 */
export const MATERIALS = {
  kablo: {
    label: 'Kablo yalıtımı (PE/PVC)',
    ignitionTemp: 600, autoIgnitionTemp: 720, loi: 0.18,
    fuelLoad: 0.55, burnRate: 0.012, heatOfCombustion: 40, stoichO2: 3.2,
    flameTemp: 1950, soot: 0.75, thermalInertia: 0.65, conductivity: 0.6, coolRate: 0.3,
    burnsAway: false,
  },
  kopuk: {
    label: 'Poliüretan köpük',
    ignitionTemp: 570, autoIgnitionTemp: 690, loi: 0.17,
    fuelLoad: 0.8, burnRate: 0.02, heatOfCombustion: 26, stoichO2: 2.1,
    flameTemp: 1900, soot: 0.9, thermalInertia: 0.6, conductivity: 0.25, coolRate: 0.25,
    burnsAway: false,
  },
  kumas: {
    label: 'Pamuklu kumaş',
    ignitionTemp: 530, autoIgnitionTemp: 680, loi: 0.18,
    fuelLoad: 0.25, burnRate: 0.012, heatOfCombustion: 16.5, stoichO2: 1.2,
    flameTemp: 1850, soot: 0.3, thermalInertia: 0.5, conductivity: 0.2, coolRate: 0.35,
    burnsAway: true,
  },
  kagit: {
    label: 'Kâğıt',
    ignitionTemp: 505, autoIgnitionTemp: 560, loi: 0.18,
    fuelLoad: 0.09, burnRate: 0.011, heatOfCombustion: 17, stoichO2: 1.2,
    flameTemp: 1800, soot: 0.2, thermalInertia: 0.3, conductivity: 0.15, coolRate: 0.45,
    burnsAway: true,
  },
  nomex: {
    label: 'Nomex (aramid)',
    ignitionTemp: 770, autoIgnitionTemp: 880, loi: 0.29,
    fuelLoad: 0.3, burnRate: 0.006, heatOfCombustion: 28, stoichO2: 2.0,
    flameTemp: 1750, soot: 0.4, thermalInertia: 0.8, conductivity: 0.2, coolRate: 0.35,
    burnsAway: false,
  },
  kompozit: {
    label: 'Epoksi kompozit panel',
    ignitionTemp: 700, autoIgnitionTemp: 810, loi: 0.24,
    fuelLoad: 1.2, burnRate: 0.008, heatOfCombustion: 30, stoichO2: 2.3,
    flameTemp: 1850, soot: 0.8, thermalInertia: 1.6, conductivity: 0.35, coolRate: 0.25,
    burnsAway: false,
  },
  elektronik: {
    label: 'Elektronik (polikarbonat/PCB)',
    ignitionTemp: 720, autoIgnitionTemp: 830, loi: 0.25,
    fuelLoad: 1.0, burnRate: 0.009, heatOfCombustion: 30, stoichO2: 2.3,
    flameTemp: 1850, soot: 0.85, thermalInertia: 1.3, conductivity: 0.4, coolRate: 0.25,
    burnsAway: false,
  },
  kapton: {
    label: 'Kapton / MLI battaniye',
    ignitionTemp: 900, autoIgnitionTemp: 1000, loi: 0.37,
    fuelLoad: 0.1, burnRate: 0.004, heatOfCombustion: 26, stoichO2: 2.0,
    flameTemp: 1700, soot: 0.3, thermalInertia: 0.5, conductivity: 0.3, coolRate: 0.4,
    burnsAway: false,
  },
  aluminyum: {
    label: 'Alüminyum',
    ignitionTemp: Infinity, autoIgnitionTemp: Infinity, loi: Infinity,
    fuelLoad: 0, burnRate: 0, heatOfCombustion: 0, stoichO2: 0,
    flameTemp: 0, soot: 0, thermalInertia: 5, conductivity: 2.5, coolRate: 0.3,
    burnsAway: false,
  },
  celik: {
    label: 'Çelik / titanyum',
    ignitionTemp: Infinity, autoIgnitionTemp: Infinity, loi: Infinity,
    fuelLoad: 0, burnRate: 0, heatOfCombustion: 0, stoichO2: 0,
    flameTemp: 0, soot: 0, thermalInertia: 7, conductivity: 1.2, coolRate: 0.2,
    burnsAway: false,
  },
};

export function isCombustible(material) {
  return material.fuelLoad > 0 && Number.isFinite(material.ignitionTemp);
}
