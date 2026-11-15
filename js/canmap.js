// DBC signal name -> dash signal key. The starter DBC uses the keys directly; the aliases let a DBC
// made with the cansub-reverse-engineering skill (or a community DBC) plug in with its own names.
const KEYS = ['rpm', 'speed', 'throttle', 'coolant', 'steer', 'brake', 'ws_fl', 'ws_fr', 'ws_rl', 'ws_rr', 'vdc_off', 'abs', 'tcs',
  'turn_l', 'turn_r', 'hazard', 'pbrake', 'lights', 'wiper', 'door_fl', 'door_fr', 'hatch', 'locked', 'belt', 'ignition',
  'cruise', 'clutch', 'odo', 'fuel_level', 'tpms_fl', 'tpms_fr', 'tpms_rl', 'tpms_rr'];
const ALIASES = {
  enginespeed: 'rpm', engine_rpm: 'rpm', vehiclespeed: 'speed', vehicle_speed: 'speed', steeringangle: 'steer', steering_angle: 'steer',
  brakepressure: 'brake', brake_pressure: 'brake', wheelspeedfl: 'ws_fl', wheelspeedfr: 'ws_fr', wheelspeedrl: 'ws_rl', wheelspeedrr: 'ws_rr',
  doorlock: 'locked', seatbelt: 'belt', parkingbrake: 'pbrake', fuellevel: 'fuel_level', odometer: 'odo', clutchswitch: 'clutch',
};
export const CAN_KEYS = Object.fromEntries([...KEYS.map((k) => [k, k]), ...Object.entries(ALIASES)]);
