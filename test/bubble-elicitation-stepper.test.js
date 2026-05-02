const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleHtml = fs.readFileSync(path.join(__dirname, "..", "src", "bubble.html"), "utf8");

function functionBody(name) {
  const start = bubbleHtml.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const next = bubbleHtml.indexOf("\nfunction ", start + 1);
  return next === -1 ? bubbleHtml.slice(start) : bubbleHtml.slice(start, next);
}

describe("AskUserQuestion bubble stepper", () => {
  it("tracks active question and answers in local renderer state", () => {
    assert.match(bubbleHtml, /let elicitationAnswers = \{\};/);
    assert.match(bubbleHtml, /let activeQuestionIndex = 0;/);
    assert.match(bubbleHtml, /function renderElicitationStep\(\)/);
  });

  it("renders only the active full question and compact summaries for answered questions", () => {
    const body = functionBody("renderElicitationStep");
    assert.match(body, /if \(i === activeQuestionIndex\) \{/);
    assert.match(body, /createElicitationQuestionCard\(question, i\)/);
    assert.match(body, /else if \(isElicitationAnswerComplete\(i\)\) \{/);
    assert.match(body, /createQuestionSummary\(question, i\)/);
    assert.doesNotMatch(body, /forEach\(\(question, questionIndex\)/);
  });

  it("does not auto-select the first option on initial focus (form-like elicitation)", () => {
    const body = functionBody("renderElicitationStep");

    // B route: form-like elicitation for both single-choice and multi-select.
    // Initial focus puts the cursor on the first preset so arrow keys / Tab work
    // immediately, but it must not call .click() and must not pre-select.
    //
    // Source guard only. If first.click() appears in any rewritten form
    // (first.click({preventScroll:true}), first?.click(), inputs[0].click(), …)
    // update the guard or replace it with a renderer behavior test.
    assert.doesNotMatch(body, /first\.click\(/);
    assert.match(body, /if \(first\) first\.focus\(\);/);
  });

  it("lets answered summary rows reopen their question", () => {
    const body = functionBody("createQuestionSummary");
    assert.match(body, /summaryButton\.addEventListener\("click", \(\) => \{/);
    assert.match(body, /activeQuestionIndex = questionIndex;/);
    assert.match(body, /renderElicitationStep\(\);/);
  });

  it("uses Back and Next before the final Submit Answer action", () => {
    const stateBody = functionBody("updateElicitationSubmitState");
    const primaryBody = functionBody("handleElicitationPrimaryAction");
    const backBody = functionBody("handleElicitationBackAction");

    assert.match(stateBody, /btnDeny\.textContent = bubbleText\(currentLang, "previousQuestion"\);/);
    assert.match(stateBody, /btnAllow\.textContent = isLastQuestion[\s\S]*"submitAnswer"[\s\S]*"nextQuestion"/);
    assert.match(primaryBody, /if \(!isElicitationAnswerComplete\(activeQuestionIndex\)\) \{/);
    assert.match(primaryBody, /activeQuestionIndex \+= 1;/);
    assert.match(backBody, /activeQuestionIndex -= 1;/);
  });

  it("submits all answers together with the existing elicitation response contract", () => {
    const collectBody = functionBody("collectElicitationAnswers");
    const primaryBody = functionBody("handleElicitationPrimaryAction");

    assert.match(collectBody, /answers\[question\.question\] = answerText;/);
    assert.match(primaryBody, /const answers = collectElicitationAnswers\(\);/);
    assert.match(primaryBody, /window\.bubbleAPI\.decide\(\{ type: "elicitation-submit", answers \}\);/);
  });

  it("treats selected Other with empty custom text as an incomplete answer", () => {
    const body = functionBody("getElicitationAnswerText");

    assert.match(body, /if \(optionKey === ELICITATION_OTHER_KEY\) \{/);
    assert.match(body, /const otherText = answer\.otherText\.trim\(\);/);
    assert.match(body, /if \(!otherText\) return "";/);
  });

  it("keeps terminal fallback separate from Back/Next/Submit controls", () => {
    const body = functionBody("renderElicitationTerminalFallback");
    assert.match(body, /btn\.className = "btn-suggestion";/);
    assert.match(body, /btn\.textContent = bubbleText\(currentLang, "goToTerminal"\);/);
    assert.match(body, /window\.bubbleAPI\.decide\("deny"\);/);
  });

  it("does not recalculate submit state twice when a non-Other radio hides the Other textarea", () => {
    const body = functionBody("createElicitationQuestionCard");

    assert.match(body, /const updateOtherTextarea = \(\{ updateSubmitState = true \} = \{\}\) => \{/);
    assert.match(body, /if \(updateSubmitState\) updateElicitationSubmitState\(\);/);
    assert.match(body, /r\.addEventListener\("change", \(\) => updateOtherTextarea\(\{ updateSubmitState: false \}\)\);/);
  });
});
