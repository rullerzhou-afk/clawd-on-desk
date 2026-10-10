"use strict";

const { CLAWD_SERVER_HEADER, CLAWD_SERVER_ID } = require("../hooks/server-config");
const { SOURCES, PROTOCOL, supportedVersion, prepareQuestionRequest } = require("./agent-question-wire");
const { classifyPermissionInteraction } = require("./permission-automation-policy");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { resolveSessionIdentity, LOCAL_SESSION_PROFILE_ID } = require("./session-key");
const { arePermissionBubblesEnabled, shouldBypassFamilyBubble } = require("./server-route-permission");

function showUnconfirmedQuestion(entry, ctx) {
  if (!ctx.pendingPermissions.includes(entry)) return;
  entry.questionAwaitingDelivery = false;
  entry.questionDeliveryUnconfirmed = true;
  entry.isElicitation = false;
  entry.interaction = {
    intent: "human-question", automationEligibility: { autoTools: false, unattended: false },
    capabilities: { answerQuestions: false, allowDeny: false, planFeedback: false, nativeFallback: true },
  };
  if (typeof ctx.syncPermissionBubbleContent === "function") ctx.syncPermissionBubbleContent(entry);
}

function handleQuestionPost(req, res, { ctx, remoteProfile }) {
  const fallback = () => {
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(204, { [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID });
      res.end();
    }
  };
  // Remote deployments do not install this local plugin channel.
  if (remoteProfile) { fallback(); req.resume(); return; }
  const chunks = [];
  let size = 0;
  req.on("data", chunk => {
    size += chunk.length;
    if (size > 64 * 1024) { chunks.length = 0; fallback(); }
    else chunks.push(chunk);
  });
  req.on("end", () => {
    if (size > 64 * 1024 || res.destroyed || res.writableEnded) return;
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fallback(); return; }
    const agentId = data && data.agent_id;
    const prepared = prepareQuestionRequest(data && data.request);
    if (!Object.prototype.hasOwnProperty.call(SOURCES, agentId) || data.hook_source !== SOURCES[agentId]
      || data.question_protocol !== PROTOCOL || !supportedVersion(agentId, data.host_version)
      || typeof data.question_instance_id !== "string" || !/^[a-f0-9]{32}$/.test(data.question_instance_id)
      || !prepared || data.host || data.wsl || data.headless === true) {
      fallback(); return;
    }
    const identity = resolveSessionIdentity(`${agentId}:${prepared.wire.sessionID}`, LOCAL_SESSION_PROFILE_ID);
    const { sessionId, rawSessionId, profileId } = identity;
    if (data.question_result !== undefined) {
      const entry = ctx.pendingPermissions.find(item => item.isFamilyQuestion
        && item.agentId === agentId && item.sessionId === sessionId && item.familyRequestId === prepared.wire.id
        && item.questionInstanceId === data.question_instance_id
        && item.questionHostVersion === data.host_version);
      const token = data.confirmation_token;
      if (!entry || typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)
        || !entry.questionSubmissionToken || !timingSafeEqual(Buffer.from(token), Buffer.from(entry.questionSubmissionToken))
        || JSON.stringify(prepared.wire) !== JSON.stringify(entry.familyQuestionWire)
        || !["accepted", "resolved-elsewhere", "native-fallback", "unknown"].includes(data.question_result)) {
        fallback(); return;
      }
      clearTimeout(entry.autoCloseTimer); entry.autoCloseTimer = null;
      if (data.question_result === "accepted" || data.question_result === "resolved-elsewhere") {
        ctx.resolvePermissionEntry(entry, "no-decision", "Native question resolved");
      } else showUnconfirmedQuestion(entry, ctx);
      fallback(); return;
    }
    if (ctx.doNotDisturb || (typeof ctx.isAgentEnabled === "function" && !ctx.isAgentEnabled(agentId))
      || !arePermissionBubblesEnabled(ctx) || shouldBypassFamilyBubble(ctx, agentId)) {
      fallback(); return;
    }
    const duplicate = ctx.pendingPermissions.some(entry => entry.isFamilyQuestion
      && entry.agentId === agentId && entry.sessionId === sessionId
      && entry.familyRequestId === prepared.wire.id);
    if (duplicate) { fallback(); return; }
    const entry = {
      res, abortHandler: null, sessionId, rawSessionId, profileId, agentId, toolName: "AskUserQuestion", suggestions: [],
      toolInput: prepared.displayInput, elicitationDetailInput: prepared.displayInput,
      familyQuestionWire: prepared.wire, familyRequestId: prepared.wire.id,
      questionInstanceId: data.question_instance_id, questionHostVersion: data.host_version,
      isFamilyQuestion: true, isElicitation: true,
      interaction: classifyPermissionInteraction({ agentId, eventKind: "question", toolName: "AskUserQuestion" }),
      createdAt: Date.now(), bubble: null,
    };
    entry.submitQuestionAnswers = (answers) => {
      if (!ctx.pendingPermissions.includes(entry) || entry.questionAwaitingDelivery
        || entry.questionDeliveryUnconfirmed || res.writableEnded || res.destroyed) return;
      entry.questionAwaitingDelivery = true;
      entry.questionSubmissionToken = randomBytes(32).toString("hex");
      entry.autoCloseTimer = setTimeout(() => {
        entry.autoCloseTimer = null;
        showUnconfirmedQuestion(entry, ctx);
      }, 12000);
      entry.autoCloseTimer.unref?.();
      res.writeHead(200, { "Content-Type": "application/json", [CLAWD_SERVER_HEADER]: CLAWD_SERVER_ID,
        "x-clawd-question-confirmation": entry.questionSubmissionToken });
      res.end(JSON.stringify({ answers, confirmation_token: entry.questionSubmissionToken }));
      if (typeof ctx.syncPermissionBubbleContent === "function") ctx.syncPermissionBubbleContent(entry);
    };
    entry.abortHandler = () => {
      if (!res.writableEnded) ctx.resolvePermissionEntry(entry, "no-decision", "Question owner disconnected");
    };
    res.on("close", entry.abortHandler);
    ctx.addPendingPermission(entry, "question-added");
    try { ctx.showPermissionBubble(entry); }
    catch { ctx.resolvePermissionEntry(entry, "no-decision", "Question bubble unavailable"); }
  });
  req.on("error", fallback);
}

module.exports = { handleQuestionPost };
