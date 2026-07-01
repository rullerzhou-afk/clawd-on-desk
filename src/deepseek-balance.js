"use strict";

const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
const CACHE_TTL_MS = 60_000;

const apiKey = process.env.DEEPSEEK_API_KEY || "";
const isAvailable = !!apiKey;

let cache = null;
let cacheTime = 0;

async function fetchBalance() {
  if (!isAvailable) return null;

  const now = Date.now();
  if (cache && now - cacheTime < CACHE_TTL_MS) {
    return cache;
  }

  try {
    const response = await fetch(DEEPSEEK_BALANCE_URL, {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
    });

    if (response.status === 401) {
      cache = { error: "auth_failed" };
      cacheTime = now;
      return cache;
    }
    if (response.status === 429) {
      cache = { error: "rate_limited" };
      cacheTime = now;
      return cache;
    }
    if (!response.ok) {
      cache = { error: `request_failed` };
      cacheTime = now;
      return cache;
    }

    const data = await response.json();
    cache = data;
    cacheTime = now;
    return cache;
  } catch (err) {
    cache = { error: "network_error" };
    cacheTime = now;
    return cache;
  }
}

async function getBalance() {
  return fetchBalance();
}

async function refreshBalance() {
  cache = null;
  cacheTime = 0;
  return fetchBalance();
}

module.exports = { isAvailable, getBalance, refreshBalance };
