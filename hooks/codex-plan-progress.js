"use strict";

const MAX_PLAN_STEPS = 200;
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

function normalizePlanProgress(value) {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.total)
    || value.total < 1 || value.total > MAX_PLAN_STEPS
    || !Number.isSafeInteger(value.completed) || value.completed < 0 || value.completed > value.total) {
    return null;
  }
  return {
    completed: value.completed,
    total: value.total,
    percent: Math.round(value.completed / value.total * 100),
  };
}

function isCodexPlanTool(name) {
  return name === "update_plan" || name === "functions.update_plan";
}

// Only the count crosses the hook boundary, never step text or explanations.
function planProgressFromToolInput(name, input) {
  if (!isCodexPlanTool(name)) return undefined;
  const plan = input && input.plan;
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_PLAN_STEPS
    || plan.some((step) => !step || !PLAN_STATUSES.has(step.status))) return null;
  return normalizePlanProgress({
    total: plan.length,
    completed: plan.filter((step) => step.status === "completed").length,
  });
}

// A matching update_plan call with invalid arguments clears the previous plan;
// unrelated calls leave it alone. Do not parse or evaluate Code Mode JavaScript:
// its nested calls arrive as structured PostToolUse hooks instead.
function planProgressFromCall(payload) {
  if (!payload || payload.type !== "function_call" || !isCodexPlanTool(payload.name)) return undefined;
  try {
    const args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
    return planProgressFromToolInput(payload.name, args);
  } catch {
    return null;
  }
}

module.exports = { MAX_PLAN_STEPS, normalizePlanProgress, isCodexPlanTool,
  planProgressFromToolInput, planProgressFromCall };
