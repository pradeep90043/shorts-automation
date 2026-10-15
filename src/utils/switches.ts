/**
 * Feature switches that are ON unless explicitly turned off. One place, one meaning, so every module and the startup
 * banner agree: unset = on; "off", "0", "false", "no" or "disabled" = off; anything else = on.
 */
const OFF = /^(0|false|off|no|disabled?|none)$/i;

export const isOffValue = (v: string | undefined): boolean => v !== undefined && OFF.test(v.trim());

/** `name` unset -> `defaultOn`; set -> on unless it is an "off" value. */
export function switchOn(name: string, env: NodeJS.ProcessEnv = process.env, defaultOn = true): boolean {
  const v = env[name];
  if (v === undefined || v.trim() === "") return defaultOn;
  return !isOffValue(v);
}

/** For the startup banner: "on (default)", "on (SHORTS_GRID=on)", "OFF (SHORTS_GRID=off)". */
export function describeSwitch(name: string, env: NodeJS.ProcessEnv = process.env, defaultOn = true): string {
  const on = switchOn(name, env, defaultOn);
  const v = env[name];
  const src = v === undefined || v.trim() === "" ? "default" : `${name}=${v}`;
  return `${on ? "on" : "OFF"} (${src})`;
}
