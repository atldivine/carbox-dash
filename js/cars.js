// Car profiles: gearing for the gear display, rev / boost limits for the gauges, and which values each
// car can actually give over OBD-II, so every gauge on screen is one that works for that car.
//
// Gear ratios, final drive and tyre size come from the makers' spec sheets. The app also learns a small
// correction while you drive (tyre wear, a different tyre size, speedometer error), so a few percent
// off is fine. ios/App/Telemetry.swift has the same table: keep the two in step.
//
// Not readable over standard OBD-II on these cars, so never shown: knock, and (Integra) oil temp / ethanol.
export const MPH_PER_MPS = 2.23694;

const Z_GAUGES = {
  rpm: { hi: 7500, specMax: 8000, warn: 6600, crit: 7000, shift: 6800 },
  boost: { warn: 18, crit: 22 },
  tiles: ['boost', 'afr', 'iat', 'oil_temp', 'knock', 'ethanol'],
  minis: ['boost', 'afr', 'coolant'],
  rows: ['boost', 'throttle', 'afr', 'coolant', 'oil_temp'],
  chips: ['ON BOOST', 'WOT', 'KNOCK', 'LEAN', 'ETHANOL', 'PAUSED'],
  side: 'ethanol', callout: 'oil_temp', peaks: ['boost', 'knock', 'iat', 'rpm'],
};

export const CARS = {
  // 2023+ Nissan Z (RZ34), 3.0 twin-turbo V6. Spec sheet: final drive 3.538 manual / 3.133 automatic.
  'z-6mt': { id: 'z-6mt', name: 'NISSAN Z · 6MT', short: 'Z', mark: 'Z', ratios: [3.794, 2.324, 1.624, 1.271, 1.000, 0.794], final: 3.538, tire: 2.121, ...Z_GAUGES },
  'z-9at': { id: 'z-9at', name: 'NISSAN Z · 9AT', short: 'Z AUTO', mark: 'Z', ratios: [5.425, 3.263, 2.249, 1.649, 1.221, 1.000, 0.862, 0.713, 0.597], final: 3.133, tire: 2.121, ...Z_GAUGES },
  // 2023+ Acura Integra A-Spec with Technology Package, 6-speed manual: 1.5 L VTEC Turbo, 200 hp,
  // redline 6500, 235/40R18 tyres (2.027 m round). Gears 3.643 / 2.080 / 1.361 / 1.024 / 0.830 / 0.686, final 4.353.
  'integra-6mt': {
    id: 'integra-6mt', name: 'ACURA INTEGRA · A-SPEC 6MT', short: 'INTEGRA', mark: 'A',
    ratios: [3.643, 2.080, 1.361, 1.024, 0.830, 0.686], final: 4.353, tire: 2.027,
    rpm: { hi: 7000, specMax: 7000, warn: 6200, crit: 6500, shift: 6400 },
    boost: { warn: 17, crit: 20 },
    // The 1.5T has no oil-temp sensor and no flex-fuel sensor, and knock is not an OBD value, so those
    // are swapped for engine load and the fuel-rail pressure of its direct injection.
    tiles: ['boost', 'afr', 'iat', 'load', 'fuel_pressure', 'battery'],
    minis: ['boost', 'afr', 'coolant'],
    rows: ['boost', 'throttle', 'afr', 'coolant', 'load'],
    chips: ['ON BOOST', 'WOT', 'HOT', 'LEAN', 'LOAD', 'PAUSED'],
    side: 'load', callout: 'coolant', peaks: ['boost', 'load', 'iat', 'rpm'],
  },
};
export const CAR_IDS = Object.keys(CARS);
export const DEFAULT_CAR = 'z-6mt';
export const getCar = (id) => CARS[id] || CARS[DEFAULT_CAR];

// Kept for the older imports.
export const GEARS_6MT = CARS['z-6mt'].ratios, FINAL_6MT = CARS['z-6mt'].final, TIRE_M = CARS['z-6mt'].tire;
