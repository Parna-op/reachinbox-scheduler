import type Redis from 'ioredis';
import { config } from '../config/env.js';

export type SlotDecision =
  | {
      status: 'ALLOWED';
      targetMs: number;
      hourCount: number;
      hourWindow: number;
    }
  | {
      status: 'SPACING_DELAY';
      targetMs: number;
      hourCount: number;
      hourWindow: number;
    }
  | {
      status: 'RATE_LIMITED';
      targetMs: number;
      hourCount: number;
      hourWindow: number;
    };

/**
 * Atomic Redis Lua script enforcing:
 * 1. Per-sender hourly rate limit (keyed by senderId + hourWindow)
 * 2. Minimum inter-email delay (MIN_DELAY_MS) per sender
 * 3. Order-preserving overflow into the next available hour window
 */
const ACQUIRE_SLOT_LUA = `
local senderId = ARGV[1]
local nowMs = tonumber(ARGV[2])
local hourlyLimit = tonumber(ARGV[3])
local minDelayMs = tonumber(ARGV[4])

local hourMs = 3600000
local currentHour = math.floor(nowMs / hourMs)

local sentKey = "rate_limit:sent:" .. senderId .. ":" .. currentHour
local currentCount = tonumber(redis.call("GET", sentKey) or "0")

local nextAllowedKey = "rate_limit:next_allowed:" .. senderId
local nextAllowed = tonumber(redis.call("GET", nextAllowedKey) or "0")

if currentCount < hourlyLimit then
  if nowMs >= nextAllowed then
    local newCount = redis.call("INCR", sentKey)
    if newCount == 1 then
      redis.call("EXPIRE", sentKey, 7200)
    end
    if minDelayMs > 0 then
      redis.call("SET", nextAllowedKey, tostring(nowMs + minDelayMs), "PX", 7200000)
    end
    return { "ALLOWED", tostring(nowMs), tostring(newCount), tostring(currentHour) }
  else
    local nextAllowedHour = math.floor(nextAllowed / hourMs)
    if nextAllowedHour == currentHour then
      return { "SPACING_DELAY", tostring(nextAllowed), tostring(currentCount), tostring(currentHour) }
    end
  end
end

-- Hourly limit reached (or spacing pushed past current hour):
-- Reserve ordered slot in the next available hour window.
for offset = 1, 168 do
  local targetHour = currentHour + offset
  local targetSentKey = "rate_limit:sent:" .. senderId .. ":" .. targetHour
  local targetReservedKey = "rate_limit:reserved:" .. senderId .. ":" .. targetHour

  local sentInTarget = tonumber(redis.call("GET", targetSentKey) or "0")
  local reservedInTarget = tonumber(redis.call("GET", targetReservedKey) or "0")

  if (sentInTarget + reservedInTarget) < hourlyLimit then
    local slotIdx = redis.call("INCR", targetReservedKey) - 1
    redis.call("EXPIRE", targetReservedKey, 604800)

    local effectiveSpacing = math.max(minDelayMs, 0)
    local slotOffsetMs = slotIdx * effectiveSpacing
    if slotOffsetMs < hourMs then
      local targetMs = (targetHour * hourMs) + slotOffsetMs
      return { "RATE_LIMITED", tostring(targetMs), tostring(currentCount), tostring(currentHour) }
    end
  end
end

-- Fallback 1 hour from now if 7 days are somehow full
return { "RATE_LIMITED", tostring((currentHour + 1) * hourMs), tostring(currentCount), tostring(currentHour) }
`;

export async function acquireSendSlot(
  redisClient: Redis,
  params: {
    senderId: string;
    nowMs?: number;
    hourlyLimit?: number | null;
    minDelayMs?: number | null;
  },
): Promise<SlotDecision> {
  const nowMs = params.nowMs ?? Date.now();
  const hourlyLimit = Math.max(1, params.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR);
  const minDelayMs = Math.max(config.MIN_DELAY_MS, params.minDelayMs ?? 0);

  const raw = (await redisClient.eval(
    ACQUIRE_SLOT_LUA,
    0,
    params.senderId,
    String(nowMs),
    String(hourlyLimit),
    String(minDelayMs),
  )) as [string, string, string, string];

  return {
    status: raw[0] as SlotDecision['status'],
    targetMs: Number(raw[1]),
    hourCount: Number(raw[2]),
    hourWindow: Number(raw[3]),
  };
}
