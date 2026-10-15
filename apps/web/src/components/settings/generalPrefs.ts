export const FOLLOW_UP_KEY = "tide.followUpMode";
export const LIMIT_POLICY_KEY = "tide.limitPolicy";

export type FollowUpMode = "steer" | "queue";
export type LimitPolicy = "manual" | "reset";

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: the choice lasts for this session only */
  }
}

export const readFollowUpMode = (): FollowUpMode => read(FOLLOW_UP_KEY, ["steer", "queue"], "steer");
export const readLimitPolicy = (): LimitPolicy => read(LIMIT_POLICY_KEY, ["manual", "reset"], "manual");
export const writeFollowUpMode = (v: FollowUpMode): void => write(FOLLOW_UP_KEY, v);
export const writeLimitPolicy = (v: LimitPolicy): void => write(LIMIT_POLICY_KEY, v);
