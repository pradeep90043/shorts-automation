/**
 * The dashboard never receives a channel's real secrets. They are shown as "••••<last 4>", and when the dashboard saves a
 * channel back, any field still holding such a mask is replaced by the stored value, so editing a name or a schedule
 * cannot wipe or leak a token.
 */
export const MASK = "••••";

const SECRET_FIELDS = [
  "instagramAccessToken",
  "instagramPassword",
  "instagramSessionId",
  "youtubeRefreshToken",
  "youtubeClientSecret",
  "facebookAccessToken",
] as const;

export const isMasked = (v: unknown): boolean => typeof v === "string" && v.startsWith(MASK);

export const maskSecret = (v: unknown): string | undefined => {
  if (typeof v !== "string" || !v) return undefined;
  return v.length >= 24 ? `${MASK}${v.slice(-4)}` : MASK;
};

/** A copy of a stored channel config that is safe to send to a browser. */
export function maskChannel<T extends Record<string, any>>(c: T): T {
  const out: Record<string, any> = { ...c };
  for (const f of SECRET_FIELDS) if (out[f] !== undefined) out[f] = maskSecret(out[f]);
  if (Array.isArray(out.instagramAccounts)) {
    out.instagramAccounts = out.instagramAccounts.map((a: any) => ({ ...a, accessToken: maskSecret(a.accessToken) }));
  }
  if (Array.isArray(out.youtubeChannels)) {
    out.youtubeChannels = out.youtubeChannels.map((y: any) => ({ ...y, refreshToken: maskSecret(y.refreshToken) }));
  }
  return out as T;
}

/**
 * Put the stored secret back wherever the posted body still carries a mask (or nothing, for a field the form never
 * shows). Accounts are matched by igUserId, then by position; YouTube channels by name, then by position.
 */
export function restoreMasked(body: Record<string, any>, stored: Record<string, any> | undefined): Record<string, any> {
  if (!stored) return body;
  const out: Record<string, any> = { ...body };
  for (const f of SECRET_FIELDS) if (isMasked(out[f])) out[f] = stored[f];
  if (Array.isArray(out.instagramAccounts)) {
    const old: any[] = stored.instagramAccounts || [];
    out.instagramAccounts = out.instagramAccounts.map((a: any, i: number) =>
      isMasked(a?.accessToken)
        ? { ...a, accessToken: (old[i]?.igUserId === a.igUserId ? old[i] : old.find((o) => o.igUserId && o.igUserId === a.igUserId) || old[i])?.accessToken || "" }
        : a,
    );
  }
  if (Array.isArray(out.youtubeChannels)) {
    const old: any[] = stored.youtubeChannels || [];
    out.youtubeChannels = out.youtubeChannels.map((y: any, i: number) =>
      isMasked(y?.refreshToken)
        ? { ...y, refreshToken: (old[i]?.name === y.name ? old[i] : old.find((o) => o.name && o.name === y.name) || old[i])?.refreshToken || "" }
        : y,
    );
  }
  return out;
}
