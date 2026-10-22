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

// A matching update_plan call with invalid arguments clears the previous plan;
// unrelated calls return undefined and leave plan state alone.
function planProgressFromCall(payload) {
  if (!payload || payload.type !== "function_call"
    || !["update_plan", "functions.update_plan"].includes(payload.name)) return undefined;
  let args;
  try {
    args = typeof payload.arguments === "string" ? JSON.parse(payload.arguments) : payload.arguments;
  } catch {
    return null;
  }
  const plan = args && args.plan;
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > MAX_PLAN_STEPS
    || plan.some((step) => !step || !PLAN_STATUSES.has(step.status))) return null;
  return normalizePlanProgress({
    total: plan.length,
    completed: plan.filter((step) => step.status === "completed").length,
  });
}

module.exports = { MAX_PLAN_STEPS, normalizePlanProgress, planProgressFromCall };
