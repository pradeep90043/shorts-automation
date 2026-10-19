/**
 * The address cloud runners use to reach THIS app (project bundles, progress callbacks). One rule for every renderer, so
 * dev and prod behave the same way and a dev job never points a runner at prod: PUBLIC_URL (or BASE_URL) when set, else the
 * dev address when BOT_ENV=dev, else the prod address.
 */
export const PROD_PUBLIC_URL = "https://shorts-automation.duckdns.org";
export const DEV_PUBLIC_URL = "https://shorts-dev.duckdns.org";

export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const fallback = (env.BOT_ENV || "").toLowerCase() === "dev" ? DEV_PUBLIC_URL : PROD_PUBLIC_URL;
  return (env.BASE_URL || env.PUBLIC_URL || fallback).replace(/\/+$/, "");
}
