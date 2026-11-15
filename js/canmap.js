// DBC signal name -> dash signal key. The starter DBC uses the keys directly; the aliases let a DBC
// made with the cansub-reverse-engineering skill (or a community DBC) plug in with its own names.
const KEYS = ['rpm', 'speed', 'throttle', 'coolant', 'steer', 'brake', 'ws_fl', 'ws_fr', 'ws_rl', 'ws_rr', 'vdc_off', 'abs', 'tcs',
  'turn_l', 'turn_r', 'hazard', 'pbrake', 'lights', 'wiper', 'door_fl', 'door_fr', 'hatch', 'locked', 'belt', 'ignition',
  'cruise', 'clutch', 'odo', 'fuel_level', 'tpms_fl', 'tpms_fr', 'tpms_rl', 'tpms_rr',
  // EcuTek RaceROM CAN output (tuner-defined messages) and other engine values
  'boost', 'afr', 'lambda', 'iat', 'oil_temp', 'ethanol', 'timing', 'knock', 'fuel_pressure', 'battery', 'maf'];
const ALIASES = {
  enginespeed: 'rpm', engine_rpm: 'rpm', vehiclespeed: 'speed', vehicle_speed: 'speed', steeringangle: 'steer', steering_angle: 'steer',
  brakepressure: 'brake', brake_pressure: 'brake', wheelspeedfl: 'ws_fl', wheelspeedfr: 'ws_fr', wheelspeedrl: 'ws_rl', wheelspeedrr: 'ws_rr',
  knock_retard: 'knock', knockretard: 'knock', rr_knock: 'knock', ethanol_content: 'ethanol', flex_fuel: 'ethanol', ethanolcontent: 'ethanol',
  oiltemp: 'oil_temp', oil_temperature: 'oil_temp', boostpressure: 'boost', boost_psi: 'boost', intaketemp: 'iat', intake_air_temp: 'iat',
  ignitiontiming: 'timing', ignition_timing: 'timing', fuelpressure: 'fuel_pressure', rail_pressure: 'fuel_pressure', batteryvoltage: 'battery',
  doorlock: 'locked', seatbelt: 'belt', parkingbrake: 'pbrake', fuellevel: 'fuel_level', odometer: 'odo', clutchswitch: 'clutch',
};
export const CAN_KEYS = Object.fromEntries([...KEYS.map((k) => [k, k]), ...Object.entries(ALIASES)]);
