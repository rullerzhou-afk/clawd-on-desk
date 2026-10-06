const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const bubbleRenderer = fs.readFileSync(path.join(__dirname, "..", "src", "bubble-renderer.js"), "utf8");

function functionBody(name) {
  const start = bubbleRenderer.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `missing function ${name}`);
  const next = bubbleRenderer.indexOf("\nfunction ", start + 1);
  return next === -1 ? bubbleRenderer.slice(start) : bubbleRenderer.slice(start, next);
}

describe("AskUserQuestion bubble stepper", () => {
  it("tracks active question and answers in local renderer state", () => {
    assert.match(bubbleRenderer, /let elicitationAnswers = \{\};/);
    assert.match(bubbleRenderer, /let activeQuestionIndex = 0;/);
    assert.match(bubbleRenderer, /function renderElicitationStep\(\)/);
  });

  it("renders only the active full question and compact summaries for answered questions", () => {
    const body = functionBody("renderElicitationStep");
    assert.match(body, /if \(i === activeQuestionIndex\) \{/);
    assert.match(body, /createElicitationQuestionCard\(question, i\)/);
    assert.match(body, /else if \(isElicitationAnswerComplete\(i\)\) \{/);
    assert.match(body, /createQuestionSummary\(question, i\)/);
    assert.doesNotMatch(body, /forEach\(\(question, questionIndex\)/);
  });

  it("focuses an option only from the explicit restore event, never from visual expansion", () => {
    const body = functionBody("renderElicitationStep");
    const focusBody = functionBody("focusActiveElicitationControl");
    const presentationBody = functionBody("applyPresentationView");
    assert.doesNotMatch(body, /\.focus\(/);
    assert.doesNotMatch(focusBody, /\.click\(/);
    assert.match(focusBody, /if \(first\) first\.focus\(\);/);
    assert.doesNotMatch(presentationBody, /requestAnimationFrame\(focusActiveElicitationControl\)/);
    assert.match(
      bubbleRenderer,
      /onRestoreActiveControl[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*focusActiveElicitationControl\(\)/
    );
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

  it("submits all answers by stable question id, never by display copy", () => {
    const collectBody = functionBody("collectElicitationAnswers");
    const primaryBody = functionBody("handleElicitationPrimaryAction");

    assert.match(collectBody, /answers\[String\(i\)\] = answerText;/);
    assert.doesNotMatch(collectBody, /answers\[question\.question\]/);
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
    assert.match(body, /data && data\.isHermes \? "deny-and-focus" : "deny"/);
  });

  it("does not recalculate submit state twice when a non-Other radio hides the Other textarea", () => {
    const body = functionBody("createElicitationQuestionCard");

    assert.match(body, /const updateOtherTextarea = \(\{ updateSubmitState = true \} = \{\}\) => \{/);
    assert.match(body, /if \(updateSubmitState\) updateElicitationSubmitState\(\);/);
    assert.match(body, /r\.addEventListener\("change", \(\) => updateOtherTextarea\(\{ updateSubmitState: false \}\)\);/);
  });
});

describe("Codex request_user_input preview", () => {
  it("renders a read-only stepped preview and delegates answering to Codex", () => {
    const cardBody = functionBody("createCodexUserInputQuestionCard");
    const stepBody = functionBody("renderCodexUserInputStep");
    assert.match(cardBody, /question\.options/);
    assert.doesNotMatch(cardBody, /createElement\("input"\)|createElement\("textarea"\)/);
    assert.match(stepBody, /activeQuestionIndex -= 1/);
    assert.match(stepBody, /activeQuestionIndex \+= 1/);
    assert.match(bubbleRenderer, /window\.bubbleAPI\.decide\("codex-user-input-focus"\)/);
  });

  it("marks every option as visually non-interactive, unlike the real elicitation picker", () => {
    const cardBody = functionBody("createCodexUserInputQuestionCard");
    const elicitationBody = functionBody("createElicitationQuestionCard");
    // Both regular options and the synthesized "Other" row must carry the
    // readonly modifier — .option-item alone still has a pointer cursor.
    assert.match(cardBody, /item\.className = "option-item option-item-readonly"/);
    assert.match(cardBody, /other\.className = "option-item option-item-other option-item-readonly"/);
    assert.doesNotMatch(elicitationBody, /option-item-readonly/);
  });

  it("shows a remote handoff instead of claiming it can focus a local terminal", () => {
    const body = functionBody("renderCodexUserInputStep");
    assert.match(body, /if \(data\.isRemote\)/);
    assert.match(body, /returnToRemoteCodex/);
  });
});
