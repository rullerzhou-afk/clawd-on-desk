"use strict";

const { timingSafeEqual } = require("node:crypto");
const { getFamilyConfig } = require("../agents/opencode-family");
const {
  normalizeOpencodeFamilyBridgeUrl,
  isValidOpencodeFamilyBridgeToken,
} = require("./opencode-family-bridge-url");

function opencodeFamilyBridgeTokensEqual(expected, candidate) {
  if (
    !isValidOpencodeFamilyBridgeToken(expected)
    || !isValidOpencodeFamilyBridgeToken(candidate)
  ) return false;
  const expectedBytes = Buffer.from(expected, "utf8");
  const candidateBytes = Buffer.from(candidate, "utf8");
  if (expectedBytes.length !== candidateBytes.length) return false;
  try {
    return timingSafeEqual(expectedBytes, candidateBytes);
  } catch {
    return false;
  }
}

function normalizeExternalFamilyPermissionIdentity(identity) {
  if (!identity || typeof identity !== "object") return null;
  const agentId = typeof identity.agentId === "string" ? identity.agentId : "";
  if (!getFamilyConfig(agentId)) return null;
  const requestId = typeof identity.requestId === "string" && identity.requestId
    ? identity.requestId
    : null;
  const sessionId = typeof identity.sessionId === "string" && identity.sessionId
    ? identity.sessionId
    : null;
  const bridgeUrl = normalizeOpencodeFamilyBridgeUrl(identity.bridgeUrl);
  const bridgeToken = isValidOpencodeFamilyBridgeToken(identity.bridgeToken)
    ? identity.bridgeToken
    : null;
  if (!requestId || !sessionId || !bridgeUrl || !bridgeToken) return null;
  return { agentId, requestId, sessionId, bridgeUrl, bridgeToken };
}

module.exports = {
  normalizeExternalFamilyPermissionIdentity,
  opencodeFamilyBridgeTokensEqual,
};
