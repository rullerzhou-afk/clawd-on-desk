const { formatDetail, truncate, parseMcpToolName, detectIrreversible } = window.ClawdBubbleFormat;
const card = document.getElementById("card");
const toolPill = document.getElementById("toolPill");
const toolPillText = document.getElementById("toolPillText");
function stopMarquee() {
  toolPill.classList.remove("is-marquee");
  toolPill.style.removeProperty("--marquee-shift");
}
function startMarqueeIfOverflowing() {
  const overflow = toolPillText.scrollWidth - toolPillText.clientWidth;
  if (overflow <= 0) return;
  toolPill.style.setProperty("--marquee-shift", `-${overflow}px`);
  toolPill.classList.add("is-marquee");
}
toolPill.addEventListener("mouseenter", startMarqueeIfOverflowing);
toolPill.addEventListener("mouseleave", stopMarquee);
const commandBlock = document.getElementById("commandBlock");
const compactBlock = document.getElementById("compactBlock");
const detailScroll = document.getElementById("detailScroll");
const detailTruncation = document.getElementById("detailTruncation");
const btnExpand = document.getElementById("btnExpand");
const btnCollapse = document.getElementById("btnCollapse");
const irreversibleBadge = document.getElementById("irreversibleBadge");
const elicitationForm = document.getElementById("elicitationForm");
const elicitationProgress = document.getElementById("elicitationProgress");
const planFeedbackForm = document.getElementById("planFeedbackForm");
const planFeedbackTextarea = document.getElementById("planFeedbackTextarea");
const planFeedbackBack = document.getElementById("planFeedbackBack");
const planFeedbackSubmit = document.getElementById("planFeedbackSubmit");
const btnAllow = document.getElementById("btnAllow");
const btnDeny = document.getElementById("btnDeny");
const suggestionsContainer = document.getElementById("suggestions");
const actionsContainer = document.getElementById("actions");
const footerSecondary = document.getElementById("footerSecondary");
const headerTitle = document.querySelector(".header-title");
const sessionTag = document.getElementById("sessionTag");
let elicitationMode = false;
let codexUserInputMode = false;
let elicitationQuestions = [];
let elicitationAnswers = {};
let activeQuestionIndex = 0;
let currentLang = "en";
let heightReportFrame = 0;
let currentData = null;
let currentExpanded = false;
let measurementEpoch = 0;
let currentIsPlanReview = false;
let planFeedbackMode = false;
let pendingRestoreState = null;
let sessionTrustErrorElement = null;
let compactContentOverflow = false;

// Mirrors body { padding: 6px; } above. Keep this in sync if the body padding changes.
const BUBBLE_BODY_PADDING_Y = 12;
const MIN_ELICITATION_FORM_HEIGHT = 80;
const ELICITATION_OTHER_KEY = "__other__";

function setSessionTag(data) {
  const parts = [];
  if (data.isCodexSubagent) parts.push(data.codexAgentNickname || bubbleText(data.lang, "agent"));
  if (data.sessionFolder) parts.push(data.sessionFolder);
  if (data.sessionShortId) parts.push("#" + data.sessionShortId);
  if (parts.length) {
    sessionTag.textContent = parts.join(" \u00B7 ");
    sessionTag.classList.add("visible");
  } else {
    sessionTag.textContent = "";
    sessionTag.classList.remove("visible");
  }
}


const BUBBLE_STRINGS = {
  en: {
    irreversibleHint: "Destructive action \u2014 may not be recoverable",
    autoAcceptEdits: "Auto-accept edits",
    switchToPlanMode: "Switch to plan mode",
    allowInDir: "Allow {tool} in {dir}/",
    alwaysAllowRule: "Always allow `{rule}`",
    alwaysAllow: "Always allow",
    sessionTrust: "Don’t ask again in this session",
    permissionRequest: "Permission Request",
    agent: "Agent",
    allow: "Allow",
    deny: "Deny",
    alwaysAllowBlanket: "Always Allow (blanket)",
    alwaysAllowBlanketTitle: "Warning: {agent}'s 'always' rule auto-approves every subsequent tool call of the same category in this session (including rm and similar destructive commands). The rule lives only in memory — restart {agent} to revoke.",
    needsInput: "Needs Input",
    goToTerminal: "Go to Terminal",
    submitAnswer: "Submit Answer",
    nextQuestion: "Next",
    previousQuestion: "Back",
    questionProgress: "{current} / {total}",
    chooseOneOption: "Choose one option",
    chooseAtLeastOneOption: "Multi-select, choose at least one",
    questionLabel: "Question {index}",
    other: "Other",
    otherPlaceholder: "Type your answer…",
    codexPermission: "Codex Permission",
    codexToolApproval: "Codex Tool Approval",
    kimiPermission: "Kimi Permission",
    checkKimiTerminal: "Approve or reject this request in the Kimi terminal.",
    gotIt: "Got it",
    codexNeedsInput: "Codex Needs Input",
    goToCodex: "Go to Codex",
    answerInCodex: "Choose or type your answer in Codex.",
    returnToRemoteCodex: "Return to the remote Codex terminal to answer.",
    otherInCodex: "Other (type in Codex)",
    planReview: "Plan Review",
    approve: "Approve",
    reject: "Reject",
    tellClaudeWhatToChange: "Suggest changes",
    planFeedbackPlaceholder: "What should be changed?",
    submitFeedback: "Send",
    back: "Back",
    viewDetails: "View details",
    moreOptions: "More options",
    viewPlan: "View plan",
    answer: "Answer",
    collapse: "Collapse",
    contentTruncated: "Content is too large and has been truncated.",
    questionCount: "Questions: {count}",
  },
  zh: {
    irreversibleHint: "\u7834\u574F\u6027\u64CD\u4F5C\u2014\u2014\u53EF\u80FD\u65E0\u6CD5\u6062\u590D",
    autoAcceptEdits: "\u81EA\u52A8\u63A5\u53D7\u7F16\u8F91",
    switchToPlanMode: "\u5207\u6362\u5230 Plan \u6A21\u5F0F",
    allowInDir: "\u5141\u8BB8 {tool} \u5728 {dir}/",
    alwaysAllowRule: "\u59CB\u7EC8\u5141\u8BB8 `{rule}`",
    alwaysAllow: "\u59CB\u7EC8\u5141\u8BB8",
    sessionTrust: "\u672C\u4F1A\u8BDD\u4E0D\u518D\u8BE2\u95EE",
    permissionRequest: "\u6743\u9650\u8BF7\u6C42",
    agent: "\u52A9\u624B",
    allow: "\u6279\u51C6",
    deny: "\u62D2\u7EDD",
    alwaysAllowBlanket: "\u59CB\u7EC8\u5141\u8BB8\uFF08\u901A\u914D\uFF09",
    alwaysAllowBlanketTitle: "\u8B66\u544A\uFF1A{agent} \u7684 always \u89C4\u5219\u4F1A\u8BA9\u672C\u6B21 session \u5185\u4E0B\u4E00\u6B21\u6240\u6709\u540C\u7C7B\u5DE5\u5177\u8C03\u7528\u81EA\u52A8\u653E\u884C\uFF08\u5305\u62EC rm \u7B49\u5371\u9669\u547D\u4EE4\uFF09\u3002\u8BE5\u89C4\u5219\u53EA\u5728\u5185\u5B58\u4E2D\uFF0C\u91CD\u542F {agent} \u5373\u6062\u590D\u3002",
    needsInput: "\u9700\u8981\u8F93\u5165",
    goToTerminal: "\u524D\u5F80\u7EC8\u7AEF",
    submitAnswer: "\u63D0\u4EA4\u56DE\u7B54",
    nextQuestion: "\u4E0B\u4E00\u6B65",
    previousQuestion: "\u4E0A\u4E00\u6B65",
    questionProgress: "{current} / {total}",
    chooseOneOption: "\u8BF7\u9009\u62E9\u4E00\u9879",
    chooseAtLeastOneOption: "\u53EF\u591A\u9009\uFF0C\u81F3\u5C11\u9009\u62E9\u4E00\u9879",
    questionLabel: "\u95EE\u9898 {index}",
    other: "\u5176\u4ED6",
    otherPlaceholder: "\u8F93\u5165\u4F60\u7684\u56DE\u7B54\u2026",
    codexPermission: "Codex \u6743\u9650\u8BF7\u6C42",
    codexToolApproval: "Codex \u5DE5\u5177\u8C03\u7528\u5BA1\u6279",
    kimiPermission: "Kimi \u6743\u9650\u8BF7\u6C42",
    checkKimiTerminal: "\u8BF7\u5728 Kimi \u7EC8\u7AEF\u4E2D\u6279\u51C6\u6216\u62D2\u7EDD\u8BE5\u8BF7\u6C42\u3002",
    gotIt: "\u77E5\u9053\u4E86",
    codexNeedsInput: "Codex \u9700\u8981\u4F60\u7684\u56DE\u7B54",
    goToCodex: "\u524D\u5F80 Codex",
    answerInCodex: "\u8BF7\u5728 Codex \u4E2D\u9009\u62E9\u6216\u8F93\u5165\u56DE\u7B54\u3002",
    returnToRemoteCodex: "\u8BF7\u8FD4\u56DE\u8FDC\u7AEF Codex \u7EC8\u7AEF\u56DE\u7B54\u3002",
    otherInCodex: "\u5176\u4ED6\uFF08\u5728 Codex \u4E2D\u8F93\u5165\uFF09",
    planReview: "\u8BA1\u5212\u5BA1\u6279",
    approve: "\u6279\u51C6",
    reject: "\u62D2\u7EDD",
    tellClaudeWhatToChange: "\u63D0\u4FEE\u6539\u610F\u89C1",
    planFeedbackPlaceholder: "\u54EA\u91CC\u9700\u8981\u6539?",
    submitFeedback: "\u53D1\u9001",
    back: "\u8FD4\u56DE",
    viewDetails: "\u67E5\u770B\u8BE6\u60C5",
    moreOptions: "\u66F4\u591A\u9009\u9879",
    viewPlan: "\u67E5\u770B\u8BA1\u5212",
    answer: "\u56DE\u7B54",
    collapse: "\u6536\u8D77",
    contentTruncated: "\u5185\u5BB9\u8FC7\u5927\uFF0C\u5DF2\u622A\u65AD\u3002",
    questionCount: "{count} \u4E2A\u95EE\u9898",
  },
  "zh-TW": {
    irreversibleHint: "\u7834\u58DE\u6027\u64CD\u4F5C\u2014\u2014\u53EF\u80FD\u7121\u6CD5\u5FA9\u539F",
    autoAcceptEdits: "自動接受編輯",
    switchToPlanMode: "切換到計劃模式",
    allowInDir: "允許 {tool} 在 {dir}/",
    alwaysAllowRule: "一律允許 `{rule}`",
    alwaysAllow: "一律允許",
    sessionTrust: "本工作階段不再詢問",
    permissionRequest: "權限請求",
    agent: "助手",
    allow: "允許",
    deny: "拒絕",
    alwaysAllowBlanket: "一律允許（全部）",
    alwaysAllowBlanketTitle: "警告：{agent} 的 'always' 規則會自動允許本次工作階段中後續所有同類工具呼叫（包含 rm 等破壞性命令）。此規則只儲存在記憶體中，重新啟動 {agent} 即可取消此規則。",
    needsInput: "需要回應",
    goToTerminal: "跳至終端機",
    submitAnswer: "送出答案",
    nextQuestion: "下一題",
    previousQuestion: "上一題",
    questionProgress: "{current} / {total}",
    chooseOneOption: "請選擇一個選項",
    chooseAtLeastOneOption: "可複選，請至少選擇一項",
    questionLabel: "問題 {index}",
    other: "其他",
    otherPlaceholder: "輸入你的回答…",
    codexPermission: "Codex 權限請求",
    codexToolApproval: "Codex 工具呼叫審批",
    kimiPermission: "Kimi 權限請求",
    checkKimiTerminal: "請在 Kimi 終端機中允許或拒絕此請求。",
    gotIt: "了解",
    codexNeedsInput: "Codex 需要你的回答",
    goToCodex: "前往 Codex",
    answerInCodex: "請在 Codex 中選擇或輸入回答。",
    returnToRemoteCodex: "請返回遠端 Codex 終端機回答。",
    otherInCodex: "其他（在 Codex 中輸入）",
    planReview: "計畫審查",
    approve: "允許",
    reject: "拒絕",
    tellClaudeWhatToChange: "提修改意見",
    planFeedbackPlaceholder: "哪裡需要改?",
    submitFeedback: "傳送",
    back: "返回",
    viewDetails: "查看詳情",
    moreOptions: "更多選項",
    viewPlan: "查看計畫",
    answer: "回答",
    collapse: "收合",
    contentTruncated: "內容過大，已截斷。",
    questionCount: "{count} 個問題",
  },
  ko: {
    irreversibleHint: "\uD30C\uAD34\uC801 \uC791\uC5C5 \u2014 \uBCF5\uAD6C\uB418\uC9C0 \uC54A\uC744 \uC218 \uC788\uC2B5\uB2C8\uB2E4",
    autoAcceptEdits: "\uD3B8\uC9D1 \uC790\uB3D9 \uC2B9\uC778",
    switchToPlanMode: "Plan \uBAA8\uB4DC\uB85C \uC804\uD658",
    allowInDir: "{dir}/\uC5D0\uC11C {tool} \uD5C8\uC6A9",
    alwaysAllowRule: "\uD56D\uC0C1 \uD5C8\uC6A9 `{rule}`",
    alwaysAllow: "\uD56D\uC0C1 \uD5C8\uC6A9",
    sessionTrust: "\uC774 \uC138\uC158\uC5D0\uC11C\uB294 \uB2E4\uC2DC \uBB3B\uC9C0 \uC54A\uAE30",
    permissionRequest: "\uAD8C\uD55C \uC694\uCCAD",
    agent: "\uC5D0\uC774\uC804\uD2B8",
    allow: "\uD5C8\uC6A9",
    deny: "\uAC70\uBD80",
    alwaysAllowBlanket: "\uD56D\uC0C1 \uD5C8\uC6A9 (\uC804\uCCB4)",
    alwaysAllowBlanketTitle: "\uACBD\uACE0: {agent}\uC758 'always' \uADDC\uCE59\uC740 \uC774 \uC138\uC158\uC5D0\uC11C \uAC19\uC740 \uC885\uB958\uC758 \uC774\uD6C4 \uBAA8\uB4E0 \uB3C4\uAD6C \uD638\uCD9C\uC744 \uC790\uB3D9 \uC2B9\uC778\uD569\uB2C8\uB2E4. (rm \uAC19\uC740 \uD30C\uAD34\uC801 \uBA85\uB839 \uD3EC\uD568) \uC774 \uADDC\uCE59\uC740 \uBA54\uBAA8\uB9AC\uC5D0\uB9CC \uB0A8\uC73C\uBA70, {agent}\uB97C \uC7AC\uC2DC\uC791\uD558\uBA74 \uD574\uC81C\uB429\uB2C8\uB2E4.",
    needsInput: "\uC785\uB825 \uD544\uC694",
    goToTerminal: "\uD130\uBBF8\uB110\uB85C \uC774\uB3D9",
    submitAnswer: "\uB2F5\uBCC0 \uC81C\uCD9C",
    nextQuestion: "\uB2E4\uC74C",
    previousQuestion: "\uC774\uC804",
    questionProgress: "{current} / {total}",
    chooseOneOption: "\uD56D\uBAA9 \uD558\uB098\uB97C \uC120\uD0DD\uD558\uC138\uC694",
    chooseAtLeastOneOption: "\uC5EC\uB7EC \uD56D\uBAA9 \uC120\uD0DD \uAC00\uB2A5, \uCD5C\uC18C \uD558\uB098 \uC120\uD0DD",
    questionLabel: "\uC9C8\uBB38 {index}",
    other: "\uAE30\uD0C0",
    otherPlaceholder: "\uC9C1\uC811 \uC785\uB825\u2026",
    codexPermission: "Codex \uAD8C\uD55C \uC694\uCCAD",
    codexToolApproval: "Codex \uB3C4\uAD6C \uD638\uCD9C \uC2B9\uC778",
    kimiPermission: "Kimi \uAD8C\uD55C \uC694\uCCAD",
    checkKimiTerminal: "Kimi \uD130\uBBF8\uB110\uC5D0\uC11C \uC774 \uC694\uCCAD\uC744 \uD5C8\uC6A9\uD558\uAC70\uB098 \uAC70\uBD80\uD558\uC138\uC694.",
    gotIt: "\uD655\uC778",
    codexNeedsInput: "Codex\uC5D0 \uC785\uB825\uC774 \uD544\uC694\uD569\uB2C8\uB2E4",
    goToCodex: "Codex\uB85C \uC774\uB3D9",
    answerInCodex: "Codex\uC5D0\uC11C \uB2F5\uBCC0\uC744 \uC120\uD0DD\uD558\uAC70\uB098 \uC785\uB825\uD558\uC138\uC694.",
    returnToRemoteCodex: "\uC6D0\uACA9 Codex \uD130\uBBF8\uB110\uB85C \uB3CC\uC544\uAC00 \uB2F5\uBCC0\uD558\uC138\uC694.",
    otherInCodex: "\uAE30\uD0C0 (Codex\uC5D0\uC11C \uC785\uB825)",
    planReview: "\uACC4\uD68D \uAC80\uD1A0",
    approve: "\uC2B9\uC778",
    reject: "\uAC70\uBD80",
    tellClaudeWhatToChange: "\uC218\uC815 \uC694\uCCAD",
    planFeedbackPlaceholder: "\uC5B4\uB514\uB97C \uBC14\uAFD4\uC57C \uD558\uB098\uC694?",
    submitFeedback: "\uBCF4\uB0B4\uAE30",
    back: "\uB4A4\uB85C",
    viewDetails: "\uC790\uC138\uD788 \uBCF4\uAE30",
    moreOptions: "\uB354 \uBCF4\uAE30",
    viewPlan: "\uACC4\uD68D \uBCF4\uAE30",
    answer: "\uB2F5\uBCC0",
    collapse: "\uC811\uAE30",
    contentTruncated: "\uB0B4\uC6A9\uC774 \uB108\uBB34 \uCEE4\uC11C \uC798\uB838\uC2B5\uB2C8\uB2E4.",
    questionCount: "\uC9C8\uBB38 {count}\uAC1C",
  },
  ja: {
    irreversibleHint: "\u7834\u58CA\u7684\u306A\u64CD\u4F5C \u2014 \u5FA9\u5143\u3067\u304D\u306A\u3044\u53EF\u80FD\u6027\u304C\u3042\u308A\u307E\u3059",
    autoAcceptEdits: "編集を自動承認",
    switchToPlanMode: "Plan モードに切り替え",
    allowInDir: "{dir}/ で {tool} を許可",
    alwaysAllowRule: "`{rule}` を常に許可",
    alwaysAllow: "常に許可",
    sessionTrust: "このセッションでは今後確認しない",
    permissionRequest: "権限リクエスト",
    agent: "エージェント",
    allow: "許可",
    deny: "拒否",
    alwaysAllowBlanket: "常に許可（包括）",
    alwaysAllowBlanketTitle: "警告: {agent} の 'always' ルールは、このセッション内で同じ種類の以後すべてのツール呼び出しを自動承認します（rm などの破壊的なコマンドを含む）。このルールはメモリ上だけに保存され、{agent} を再起動すると解除されます。",
    needsInput: "入力が必要",
    goToTerminal: "ターミナルへ移動",
    submitAnswer: "回答を送信",
    nextQuestion: "次へ",
    previousQuestion: "戻る",
    questionProgress: "{current} / {total}",
    chooseOneOption: "選択肢を 1 つ選んでください",
    chooseAtLeastOneOption: "複数選択、1 つ以上選んでください",
    questionLabel: "質問 {index}",
    other: "その他",
    otherPlaceholder: "回答を入力…",
    codexPermission: "Codex 権限リクエスト",
    codexToolApproval: "Codex ツール呼び出しの承認",
    kimiPermission: "Kimi 権限リクエスト",
    checkKimiTerminal: "Kimi ターミナルでこのリクエストを許可または拒否してください。",
    gotIt: "了解",
    codexNeedsInput: "Codex に入力が必要",
    goToCodex: "Codex へ移動",
    answerInCodex: "Codex で回答を選択または入力してください。",
    returnToRemoteCodex: "リモートの Codex ターミナルに戻って回答してください。",
    otherInCodex: "その他（Codex で入力）",
    planReview: "計画レビュー",
    approve: "承認",
    reject: "却下",
    tellClaudeWhatToChange: "修正を提案",
    planFeedbackPlaceholder: "どこを変更すべき?",
    submitFeedback: "送信",
    back: "戻る",
    viewDetails: "詳細を表示",
    moreOptions: "その他の選択肢",
    viewPlan: "計画を表示",
    answer: "回答",
    collapse: "閉じる",
    contentTruncated: "内容が大きすぎるため、省略されました。",
    questionCount: "質問 {count} 件",
  },
  "pt-BR": {
    irreversibleHint: "Ação destrutiva — pode não ter volta",
    autoAcceptEdits: "Aceitar edições automaticamente",
    switchToPlanMode: "Mudar para o modo plano",
    allowInDir: "Permitir {tool} em {dir}/",
    alwaysAllowRule: "Sempre permitir `{rule}`",
    alwaysAllow: "Sempre permitir",
    sessionTrust: "Não perguntar de novo nesta sessão",
    permissionRequest: "Pedido de permissão",
    agent: "Agente",
    allow: "Permitir",
    deny: "Negar",
    alwaysAllowBlanket: "Sempre permitir (irrestrito)",
    alwaysAllowBlanketTitle: "Aviso: a regra 'sempre' do {agent} aprova automaticamente todas as chamadas seguintes de ferramenta da mesma categoria nesta sessão (incluindo rm e outros comandos destrutivos). A regra vive só na memória — reinicie o {agent} para revogá-la.",
    needsInput: "Precisa de resposta",
    goToTerminal: "Ir para o terminal",
    submitAnswer: "Enviar resposta",
    nextQuestion: "Avançar",
    previousQuestion: "Voltar",
    questionProgress: "{current} / {total}",
    chooseOneOption: "Escolha uma opção",
    chooseAtLeastOneOption: "Múltipla escolha, marque pelo menos uma",
    questionLabel: "Pergunta {index}",
    other: "Outra",
    otherPlaceholder: "Digite sua resposta…",
    codexPermission: "Permissão do Codex",
    codexToolApproval: "Aprovação de ferramenta do Codex",
    kimiPermission: "Permissão do Kimi",
    checkKimiTerminal: "Aprove ou recuse este pedido no terminal do Kimi.",
    gotIt: "Entendi",
    codexNeedsInput: "O Codex precisa de resposta",
    goToCodex: "Ir para o Codex",
    answerInCodex: "Escolha ou digite sua resposta no Codex.",
    returnToRemoteCodex: "Volte ao terminal remoto do Codex para responder.",
    otherInCodex: "Outra (digite no Codex)",
    planReview: "Revisão do plano",
    approve: "Aprovar",
    reject: "Recusar",
    tellClaudeWhatToChange: "Sugerir mudanças",
    planFeedbackPlaceholder: "O que deveria mudar?",
    submitFeedback: "Enviar",
    back: "Voltar",
    viewDetails: "Ver detalhes",
    moreOptions: "Mais opções",
    viewPlan: "Ver plano",
    answer: "Responder",
    collapse: "Recolher",
    contentTruncated: "O conteúdo é muito grande e foi truncado.",
    questionCount: "Perguntas: {count}",
  },
  es: {
    irreversibleHint: "Acción destructiva — puede ser irreversible",
    autoAcceptEdits: "Aceptar ediciones automáticamente",
    switchToPlanMode: "Cambiar al modo plan",
    allowInDir: "Permitir {tool} en {dir}/",
    alwaysAllowRule: "Permitir siempre `{rule}`",
    alwaysAllow: "Permitir siempre",
    sessionTrust: "No volver a preguntar en esta sesión",
    permissionRequest: "Solicitud de permiso",
    agent: "Agente",
    allow: "Permitir",
    deny: "Denegar",
    alwaysAllowBlanket: "Permitir siempre (sin restricciones)",
    alwaysAllowBlanketTitle: "Advertencia: la regla 'siempre' de {agent} aprueba automáticamente todas las llamadas posteriores a herramientas de la misma categoría durante esta sesión (incluidos rm y otros comandos destructivos). La regla solo se guarda en memoria; reinicia {agent} para revocarla.",
    needsInput: "Necesita una respuesta",
    goToTerminal: "Ir a la terminal",
    submitAnswer: "Enviar respuesta",
    nextQuestion: "Siguiente",
    previousQuestion: "Atrás",
    questionProgress: "{current} / {total}",
    chooseOneOption: "Elige una opción",
    chooseAtLeastOneOption: "Selección múltiple; elige al menos una opción",
    questionLabel: "Pregunta {index}",
    other: "Otra",
    otherPlaceholder: "Escribe tu respuesta…",
    codexPermission: "Permiso de Codex",
    codexToolApproval: "Aprobación de herramienta de Codex",
    kimiPermission: "Permiso de Kimi",
    checkKimiTerminal: "Aprueba o rechaza esta solicitud en la terminal de Kimi.",
    gotIt: "Entendido",
    codexNeedsInput: "Codex necesita una respuesta",
    goToCodex: "Ir a Codex",
    answerInCodex: "Elige o escribe tu respuesta en Codex.",
    returnToRemoteCodex: "Vuelve a la terminal remota de Codex para responder.",
    otherInCodex: "Otra (escríbela en Codex)",
    planReview: "Revisión del plan",
    approve: "Aprobar",
    reject: "Rechazar",
    tellClaudeWhatToChange: "Sugerir cambios",
    planFeedbackPlaceholder: "¿Qué habría que cambiar?",
    submitFeedback: "Enviar",
    back: "Atrás",
    viewDetails: "Ver detalles",
    moreOptions: "Más opciones",
    viewPlan: "Ver plan",
    answer: "Responder",
    collapse: "Contraer",
    contentTruncated: "El contenido es demasiado grande y se ha truncado.",
    questionCount: "Preguntas: {count}",
  },
};

function bubbleText(lang, key, vars) {
  const dict = BUBBLE_STRINGS[lang] || BUBBLE_STRINGS.en;
  let value = dict[key] || BUBBLE_STRINGS.en[key] || key;
  if (!vars) return value;
  for (const [name, replacement] of Object.entries(vars)) {
    // replaceAll: some templates repeat a placeholder (e.g. {agent} appears
    // twice in alwaysAllowBlanketTitle); every existing key uses each
    // placeholder at most once, so this is behavior-preserving for them.
    value = value.split(`{${name}}`).join(replacement);
  }
  return value;
}

function getSuggestionLabel(s, lang) {
  if (s.type === "setMode") {
    if (s.mode === "acceptEdits") return bubbleText(lang, "autoAcceptEdits");
    if (s.mode === "plan") return bubbleText(lang, "switchToPlanMode");
    return s.mode;
  }
  if (s.type === "addRules") {
    // Support both flat (toolName/ruleContent) and nested (rules:[]) formats
    const rule = Array.isArray(s.rules) && s.rules[0] ? s.rules[0] : s;
    const rc = rule.ruleContent || s.ruleContent;
    const tn = rule.toolName || s.toolName || "";
    if (rc) {
      if (rc.includes("**")) {
        const dir = rc.split("**")[0].replace(/[\\/]$/, "").split(/[\\/]/).pop() || rc;
        return bubbleText(lang, "allowInDir", { tool: tn, dir });
      }
      const short = rc.length > 30 ? rc.slice(0, 29) + "\u2026" : rc;
      return bubbleText(lang, "alwaysAllowRule", { rule: short });
    }
  }
  return bubbleText(lang, "alwaysAllow");
}

function disableAll() {
  btnAllow.disabled = true;
  btnDeny.disabled = true;
  btnExpand.disabled = true;
  for (const btn of suggestionsContainer.children) btn.disabled = true;
  for (const btn of footerSecondary.children) btn.disabled = true;
  for (const el of elicitationForm.querySelectorAll("input, textarea, button")) el.disabled = true;
}

function withUnconstrainedElicitationForm(fn) {
  if (!elicitationMode && !codexUserInputMode) return fn();
  const previousMaxHeight = elicitationForm.style.maxHeight;
  const wasScrollable = card.classList.contains("elicitation-scrollable");

  card.classList.remove("elicitation-scrollable");
  elicitationForm.style.maxHeight = "";
  try {
    return fn();
  } finally {
    elicitationForm.style.maxHeight = previousMaxHeight;
    card.classList.toggle("elicitation-scrollable", wasScrollable);
  }
}

function measureNaturalBubbleHeight() {
  return withUnconstrainedElicitationForm(() => {
    card.classList.add("measuring");
    const height = Math.ceil(Math.max(card.offsetHeight, card.scrollHeight) + BUBBLE_BODY_PADDING_Y);
    card.classList.remove("measuring");
    return height;
  });
}

function applyElicitationViewport() {
  // Intentionally a no-op.
  //
  // The expanded interaction model owns overflow in one outer detail scroller.
  // Keeping the form itself unconstrained preserves radio-key navigation and
  // avoids nested scroll regions; main still receives the natural height and
  // caps the BrowserWindow against its target work area.
  //
  // Safety: "User answered in terminal" cannot be triggered by elicitation
  // bubbles. That denial path is wired to PostToolUse/Stop hook events matched
  // by toolUseId (server.js:694) — elicitation uses a completely separate
  // code path (server.js:1008, isElicitation: true) and is explicitly excluded
  // from the shortcut-navigation and resolve logic (permission.js:321, 630).
}

function scheduleBubbleHeightReport() {
  if (heightReportFrame) cancelAnimationFrame(heightReportFrame);
  heightReportFrame = requestAnimationFrame(() => {
    heightReportFrame = 0;
    const height = measureNaturalBubbleHeight();
    const computed = typeof window.getComputedStyle === "function"
      ? window.getComputedStyle(commandBlock)
      : null;
    const detailLineHeight = Number.parseFloat(computed && computed.lineHeight) || 18;
    const detailHeight = Math.max(detailScroll.scrollHeight || 0, commandBlock.scrollHeight || 0);
    window.bubbleAPI.reportHeight({
      height,
      state: currentExpanded ? "expanded" : "compact",
      measurementEpoch,
      chromeHeight: currentExpanded ? Math.max(0, height - detailHeight) : 0,
      detailLineHeight,
    });
    applyElicitationViewport();
  });
}

function revealCard() {
  restoreDraftStateIfNeeded();
  applyPresentationView();
  card.classList.remove("hiding");
  card.classList.add("visible");
  scheduleBubbleHeightReport();
}

function resetBubbleContent() {
  if (heightReportFrame) {
    cancelAnimationFrame(heightReportFrame);
    heightReportFrame = 0;
  }
  elicitationMode = false;
  codexUserInputMode = false;
  elicitationQuestions = [];
  elicitationAnswers = {};
  activeQuestionIndex = 0;
  card.classList.remove("elicitation-scrollable");
  commandBlock.style.display = "";
  commandBlock.textContent = "";
  irreversibleBadge.style.display = "none";
  irreversibleBadge.textContent = "";
  irreversibleBadge.removeAttribute("data-reason");
  elicitationForm.innerHTML = "";
  elicitationForm.style.maxHeight = "";
  elicitationForm.classList.remove("visible");
  elicitationProgress.textContent = "";
  elicitationProgress.classList.remove("visible");
  // NOTE: this resets the feedback form's visibility + textarea value only, not
  // the other side effects of enterPlanFeedbackMode() (suggestionsContainer
  // display:none and the disabled flags on textarea/back/submit). That's safe
  // today because every ExitPlanMode bubble is a fresh BrowserWindow/document —
  // show() runs once per window so resetBubbleContent never has to undo a prior
  // feedback session. If plan bubbles ever start reusing a window, restore those
  // here too (suggestionsContainer.style.display + the disabled flags).
  planFeedbackForm.classList.remove("visible");
  planFeedbackTextarea.value = "";
  toolPill.style.display = "";
  stopMarquee();
  btnAllow.style.display = "";
  btnAllow.disabled = false;
  btnDeny.style.display = "";
  btnDeny.disabled = false;
  suggestionsContainer.innerHTML = "";
  footerSecondary.innerHTML = "";
  footerSecondary.classList.remove("visible");
  sessionTrustErrorElement = null;
  suggestionsContainer.style.display = "";
  compactBlock.textContent = "";
  detailTruncation.textContent = "";
  detailTruncation.classList.remove("visible");
  btnExpand.classList.remove("visible");
  btnExpand.disabled = false;
  planFeedbackMode = false;
  compactContentOverflow = false;
}

function getCompactPreview(data) {
  if (elicitationMode || data.isCodexUserInputNotify) {
    const questions = data.toolInput && Array.isArray(data.toolInput.questions)
      ? data.toolInput.questions
      : [];
    const first = questions[0];
    return first && first.question ? first.question : bubbleText(data.lang, "needsInput");
  }
  return formatDetail(data.toolName, data.toolInput, { isAntigravity: !!data.isAntigravity })
    || commandBlock.textContent
    || "";
}

function restoreDraftStateIfNeeded() {
  const state = pendingRestoreState;
  pendingRestoreState = null;
  if (!state) return;
  if (elicitationMode) {
    elicitationAnswers = state.elicitationAnswers;
    activeQuestionIndex = state.activeQuestionIndex;
    renderElicitationStep();
  } else if (codexUserInputMode) {
    activeQuestionIndex = state.activeQuestionIndex;
    renderCodexUserInputStep(currentData);
  }
  planFeedbackTextarea.value = state.planFeedbackText;
  planFeedbackMode = state.planFeedbackMode;
  planFeedbackSubmit.disabled = !planFeedbackTextarea.value.trim();
  requestAnimationFrame(() => {
    detailScroll.scrollTop = state.scrollTop;
  });
}

function focusActiveElicitationControl() {
  const alreadyChecked = elicitationForm.querySelector(
    `input[name="elicitation-${activeQuestionIndex}"]:checked`
  );
  const first = alreadyChecked || elicitationForm.querySelector(
    `input[name="elicitation-${activeQuestionIndex}"]:not([data-other])`
  );
  if (first) first.focus();
}

function scheduleCompactOverflowMeasurement() {
  requestAnimationFrame(() => {
    if (currentExpanded || !(compactBlock.clientHeight > 0)) return;
    const overflow = compactBlock.scrollHeight > compactBlock.clientHeight + 1;
    if (overflow === compactContentOverflow) return;
    compactContentOverflow = overflow;
    applyPresentationView();
  });
}

function applyPresentationView() {
  if (!currentData) return;
  const data = currentData;
  const wasExpanded = card.classList.contains("expanded");
  card.classList.toggle("expanded", currentExpanded);
  btnCollapse.title = bubbleText(data.lang, "collapse");
  btnCollapse.setAttribute("aria-label", bubbleText(data.lang, "collapse"));
  btnCollapse.textContent = bubbleText(data.lang, "collapse");

  const compactPreview = getCompactPreview(data);
  compactBlock.textContent = compactPreview;
  if (!elicitationMode && !codexUserInputMode && typeof data.detailText === "string" && data.detailText) {
    commandBlock.textContent = data.detailText;
  }
  detailTruncation.textContent = data.detailTruncated
    ? bubbleText(data.lang, "contentTruncated")
    : "";
  detailTruncation.classList.toggle("visible", data.detailTruncated === true);

  const compactHidesSupplementaryActions = currentIsPlanReview || elicitationMode || codexUserInputMode;
  const hiddenOptions = compactHidesSupplementaryActions
    && (suggestionsContainer.children.length > 0 || footerSecondary.children.length > 0);
  const detailDiffers = typeof data.detailText === "string"
    && data.detailText
    && data.detailText !== compactPreview;
  const needsExpansion = currentIsPlanReview
    || elicitationMode
    || codexUserInputMode
    || detailDiffers
    || compactContentOverflow
    || data.detailTruncated === true
    || hiddenOptions;
  const expandLabel = currentIsPlanReview
    ? "viewPlan"
    : (elicitationMode
      ? "answer"
      : (hiddenOptions && !detailDiffers && !compactContentOverflow ? "moreOptions" : "viewDetails"));
  btnExpand.textContent = bubbleText(data.lang, expandLabel);
  if (elicitationMode) {
    const questions = data.toolInput && Array.isArray(data.toolInput.questions)
      ? data.toolInput.questions.length
      : 0;
    if (questions > 0) {
      btnExpand.textContent += ` · ${bubbleText(data.lang, "questionCount", { count: questions })}`;
    }
  }
  btnExpand.classList.toggle("visible", !currentExpanded && needsExpansion);

  if (!currentExpanded) {
    // Compact cards keep every pre-detail quick action. Ordinary permissions
    // retain Allow/Deny, permission suggestions (including Always Allow), and
    // session trust. Plan keeps its quick Approve path, while its feedback and
    // terminal actions remain behind View plan. Ask still requires expansion.
    actionsContainer.style.display = elicitationMode ? "none" : "";
    suggestionsContainer.style.display = compactHidesSupplementaryActions ? "none" : "";
    footerSecondary.classList.toggle(
      "visible",
      !compactHidesSupplementaryActions && footerSecondary.children.length > 0
    );
    planFeedbackForm.classList.remove("visible");
  } else if (planFeedbackMode) {
    actionsContainer.style.display = "none";
    suggestionsContainer.style.display = "none";
    footerSecondary.classList.remove("visible");
    planFeedbackForm.classList.add("visible");
  } else {
    actionsContainer.style.display = "";
    suggestionsContainer.style.display = "";
    footerSecondary.classList.toggle("visible", footerSecondary.children.length > 0);
    planFeedbackForm.classList.remove("visible");
  }

  if (currentExpanded && !wasExpanded && elicitationMode) {
    requestAnimationFrame(focusActiveElicitationControl);
  }
  scheduleCompactOverflowMeasurement();
  scheduleBubbleHeightReport();
}

function renderSessionTrustError(message) {
  if (sessionTrustErrorElement && typeof sessionTrustErrorElement.remove === "function") {
    sessionTrustErrorElement.remove();
  }
  sessionTrustErrorElement = null;
  if (typeof message !== "string" || !message) return;
  const error = document.createElement("div");
  error.className = "session-trust-error";
  error.textContent = message;
  error.setAttribute("role", "alert");
  footerSecondary.appendChild(error);
  footerSecondary.classList.toggle("visible", currentExpanded);
  sessionTrustErrorElement = error;
}

function getQuestionLabel(question, questionIndex) {
  return question.header || bubbleText(currentLang, "questionLabel", { index: questionIndex + 1 });
}

function ensureElicitationAnswer(questionIndex) {
  if (!elicitationAnswers[questionIndex]) {
    elicitationAnswers[questionIndex] = { selected: [], otherText: "" };
  }
  return elicitationAnswers[questionIndex];
}

function isElicitationOtherSelected(questionIndex) {
  const answer = elicitationAnswers[questionIndex];
  return !!(answer && answer.selected.includes(ELICITATION_OTHER_KEY));
}

function setElicitationSelection(question, questionIndex, optionKey, checked) {
  const answer = ensureElicitationAnswer(questionIndex);
  if (question.multiSelect) {
    const next = new Set(answer.selected);
    if (checked) next.add(optionKey);
    else next.delete(optionKey);
    answer.selected = [...next];
  } else if (checked) {
    answer.selected = [optionKey];
  }
}

function getOptionAnswerLabel(question, optionKey) {
  const optionIndex = Number(optionKey);
  const options = Array.isArray(question.options) ? question.options : [];
  const option = Number.isInteger(optionIndex) ? options[optionIndex] : null;
  return option && option.label ? option.label : "";
}

function getElicitationAnswerText(questionIndex) {
  const question = elicitationQuestions[questionIndex];
  const answer = elicitationAnswers[questionIndex];
  if (!question || !answer || !answer.selected.length) return "";

  const parts = [];
  for (const optionKey of answer.selected) {
    if (optionKey === ELICITATION_OTHER_KEY) {
      const otherText = answer.otherText.trim();
      if (!otherText) return "";
      parts.push(otherText);
    } else {
      const answerLabel = getOptionAnswerLabel(question, optionKey);
      if (answerLabel) parts.push(answerLabel);
    }
  }
  return parts.join(", ");
}

function isElicitationAnswerComplete(questionIndex) {
  return !!getElicitationAnswerText(questionIndex);
}

function updateElicitationSubmitState() {
  if (!elicitationMode) return;
  const total = elicitationQuestions.length;
  const currentComplete = total > 0 && isElicitationAnswerComplete(activeQuestionIndex);
  const allComplete = total > 0 && elicitationQuestions.every((_, i) => isElicitationAnswerComplete(i));
  const isLastQuestion = activeQuestionIndex >= total - 1;

  elicitationProgress.textContent = total > 0
    ? bubbleText(currentLang, "questionProgress", { current: activeQuestionIndex + 1, total })
    : "";
  elicitationProgress.classList.toggle("visible", total > 0);

  btnDeny.textContent = bubbleText(currentLang, "previousQuestion");
  btnDeny.disabled = activeQuestionIndex <= 0;
  btnAllow.textContent = isLastQuestion
    ? bubbleText(currentLang, "submitAnswer")
    : bubbleText(currentLang, "nextQuestion");
  btnAllow.disabled = isLastQuestion ? !allComplete : !currentComplete;
}

function collectElicitationAnswers() {
  const answers = {};

  for (let i = 0; i < elicitationQuestions.length; i++) {
    const question = elicitationQuestions[i];
    if (!question || String(question.id) !== String(i)) return null;

    const answerText = getElicitationAnswerText(i);
    if (!answerText) return null;
    answers[String(i)] = answerText;
  }

  return answers;
}

function createQuestionSummary(question, questionIndex) {
  const summaryButton = document.createElement("button");
  summaryButton.type = "button";
  summaryButton.className = "question-summary";

  const title = document.createElement("span");
  title.className = "question-summary-title";
  title.textContent = getQuestionLabel(question, questionIndex);
  summaryButton.appendChild(title);

  const answer = document.createElement("span");
  answer.className = "question-summary-answer";
  answer.textContent = getElicitationAnswerText(questionIndex);
  summaryButton.appendChild(answer);

  summaryButton.addEventListener("click", () => {
    activeQuestionIndex = questionIndex;
    renderElicitationStep();
  });
  return summaryButton;
}

function createElicitationQuestionCard(question, questionIndex) {
  const questionCard = document.createElement("div");
  questionCard.className = "question-card";

  const header = document.createElement("div");
  header.className = "question-header";
  header.textContent = getQuestionLabel(question, questionIndex);
  questionCard.appendChild(header);

  const text = document.createElement("div");
  text.className = "question-text";
  text.textContent = question.question || "";
  questionCard.appendChild(text);

  const hint = document.createElement("div");
  hint.className = "question-hint";
  hint.textContent = question.multiSelect
    ? bubbleText(currentLang, "chooseAtLeastOneOption")
    : bubbleText(currentLang, "chooseOneOption");
  questionCard.appendChild(hint);

  const optionList = document.createElement("div");
  optionList.className = "option-list";

  const answer = ensureElicitationAnswer(questionIndex);
  const options = Array.isArray(question.options) ? question.options : [];
  options.forEach((option, optionIndex) => {
    const optionKey = String(optionIndex);
    const label = document.createElement("label");
    label.className = "option-item";

    const input = document.createElement("input");
    input.type = question.multiSelect ? "checkbox" : "radio";
    input.name = `elicitation-${questionIndex}`;
    input.value = option.label || "";
    input.setAttribute("data-answer", option.label || "");
    input.checked = answer.selected.includes(optionKey);

    const copy = document.createElement("span");
    copy.className = "option-item-copy";

    const optionLabel = document.createElement("span");
    optionLabel.className = "option-item-label";
    optionLabel.textContent = option.label || String(optionIndex + 1);
    copy.appendChild(optionLabel);

    if (option.description) {
      const optionDescription = document.createElement("span");
      optionDescription.className = "option-item-description";
      optionDescription.textContent = option.description;
      copy.appendChild(optionDescription);
    }

    label.appendChild(input);
    label.appendChild(copy);
    optionList.appendChild(label);

    input.addEventListener("change", () => {
      setElicitationSelection(question, questionIndex, optionKey, input.checked);
      updateElicitationSubmitState();
    });
  });

  // CC's AskUserQuestion protocol auto-provides "Other" in terminal UI but
  // not in question.options — we inject it client-side.
  const otherLabel = document.createElement("label");
  otherLabel.className = "option-item option-item-other";

  const otherInput = document.createElement("input");
  otherInput.type = question.multiSelect ? "checkbox" : "radio";
  otherInput.name = `elicitation-${questionIndex}`;
  otherInput.value = ELICITATION_OTHER_KEY;
  otherInput.setAttribute("data-other", "true");
  otherInput.checked = answer.selected.includes(ELICITATION_OTHER_KEY);

  const otherCopy = document.createElement("span");
  otherCopy.className = "option-item-copy";
  const otherText = document.createElement("span");
  otherText.className = "option-item-label";
  otherText.textContent = bubbleText(currentLang, "other");
  otherCopy.appendChild(otherText);

  otherLabel.appendChild(otherInput);
  otherLabel.appendChild(otherCopy);
  optionList.appendChild(otherLabel);

  const otherTextarea = document.createElement("textarea");
  otherTextarea.className = "option-item-textarea";
  otherTextarea.placeholder = bubbleText(currentLang, "otherPlaceholder");
  otherTextarea.value = answer.otherText || "";
  otherTextarea.setAttribute("data-other-textarea", "true");
  otherTextarea.classList.toggle("visible", isElicitationOtherSelected(questionIndex));
  otherTextarea.addEventListener("input", () => {
    ensureElicitationAnswer(questionIndex).otherText = otherTextarea.value;
    updateElicitationSubmitState();
  });
  // Enter activates the primary action when it is enabled; Shift+Enter inserts a newline.
  // ArrowUp from the start of Other returns focus to the last preset option.
  otherTextarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      if (!btnAllow.disabled) btnAllow.click();
      return;
    }
    if (e.key === "ArrowUp" && !e.shiftKey && !e.isComposing) {
      const atStart = otherTextarea.selectionStart === 0 && otherTextarea.selectionEnd === 0;
      const isEmpty = otherTextarea.value.length === 0;
      const shouldEscape = isEmpty || atStart;
      if (shouldEscape) {
        e.preventDefault();
        const presetInputs = optionList.querySelectorAll(`input[name="elicitation-${questionIndex}"]:not([data-other])`);
        const target = presetInputs[presetInputs.length - 1];
        if (target) {
          target.focus();
          if (!question.multiSelect) target.click();
        }
      }
    }
  });
  optionList.appendChild(otherTextarea);

  const updateOtherTextarea = ({ updateSubmitState = true } = {}) => {
    const selected = isElicitationOtherSelected(questionIndex);
    otherTextarea.classList.toggle("visible", selected);
    if (updateSubmitState) updateElicitationSubmitState();
    scheduleBubbleHeightReport();
    if (selected) {
      requestAnimationFrame(() => otherTextarea.focus());
    }
  };

  otherInput.addEventListener("change", () => {
    setElicitationSelection(question, questionIndex, ELICITATION_OTHER_KEY, otherInput.checked);
    updateOtherTextarea();
  });
  // ArrowDown on Other moves focus into the textarea when it is visible.
  otherInput.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" && !e.shiftKey && !e.isComposing) {
      const ta = optionList.querySelector("[data-other-textarea]");
      if (ta && ta.classList.contains("visible")) {
        e.preventDefault();
        ta.focus();
      }
    }
  });
  if (!question.multiSelect) {
    optionList.querySelectorAll("input[type=radio]").forEach(r => {
      if (r !== otherInput) {
        r.addEventListener("change", () => updateOtherTextarea({ updateSubmitState: false }));
      }
    });
  }

  questionCard.appendChild(optionList);
  return questionCard;
}

function renderElicitationTerminalFallback(data) {
  const btn = document.createElement("button");
  btn.className = "btn-suggestion";
  btn.textContent = bubbleText(currentLang, "goToTerminal");
  btn.addEventListener("click", () => {
    btn.textContent = "...";
    disableAll();
    // Claude elicitation requires an explicit deny response to hand control
    // back to its terminal prompt. Hermes clarify instead treats deny as
    // cancellation; deny-and-focus is normalized to a bodyless no-decision,
    // which lets Hermes open its native clarification UI.
    window.bubbleAPI.decide(data && data.isHermes ? "deny-and-focus" : "deny");
  });
  footerSecondary.appendChild(btn);
  footerSecondary.classList.toggle("visible", currentExpanded);
}

function renderRegularTerminalFallback(lang) {
  const btn = document.createElement("button");
  btn.className = "btn-suggestion";
  btn.textContent = bubbleText(lang, "goToTerminal");
  btn.addEventListener("click", () => {
    disableAll();
    window.bubbleAPI.decide("deny-and-focus");
  });
  suggestionsContainer.appendChild(btn);
}

function renderElicitationStep() {
  const total = elicitationQuestions.length;
  if (total === 0) {
    activeQuestionIndex = 0;
  } else if (activeQuestionIndex >= total) {
    activeQuestionIndex = total - 1;
  } else if (activeQuestionIndex < 0) {
    activeQuestionIndex = 0;
  }

  elicitationForm.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const question = elicitationQuestions[i];
    if (i === activeQuestionIndex) {
      elicitationForm.appendChild(createElicitationQuestionCard(question, i));
    } else if (isElicitationAnswerComplete(i)) {
      elicitationForm.appendChild(createQuestionSummary(question, i));
    }
  }

  updateElicitationSubmitState();
  scheduleBubbleHeightReport();
}

function renderElicitationForm(data) {
  const input = data.elicitationDetailInput || data.toolInput;
  elicitationQuestions = input && Array.isArray(input.questions)
    ? input.questions
    : [];
  elicitationAnswers = {};
  activeQuestionIndex = 0;
  elicitationForm.classList.add("visible");
  commandBlock.style.display = "none";
  suggestionsContainer.innerHTML = "";
  renderElicitationTerminalFallback(data);
  renderElicitationStep();
}

function createCodexUserInputQuestionCard(question, questionIndex) {
  const questionCard = document.createElement("div");
  questionCard.className = "question-card";
  const header = document.createElement("div");
  header.className = "question-header";
  header.textContent = getQuestionLabel(question, questionIndex);
  questionCard.appendChild(header);
  const text = document.createElement("div");
  text.className = "question-text";
  text.textContent = question.question || "";
  questionCard.appendChild(text);
  const hint = document.createElement("div");
  hint.className = "question-hint";
  hint.textContent = bubbleText(currentLang, "answerInCodex");
  questionCard.appendChild(hint);
  const optionList = document.createElement("div");
  optionList.className = "option-list";
  const options = Array.isArray(question.options) ? question.options : [];
  for (const option of options) {
    const item = document.createElement("div");
    item.className = "option-item option-item-readonly";
    const copy = document.createElement("span");
    copy.className = "option-item-copy";
    const label = document.createElement("span");
    label.className = "option-item-label";
    label.textContent = option.label || "";
    copy.appendChild(label);
    if (option.description) {
      const description = document.createElement("span");
      description.className = "option-item-description";
      description.textContent = option.description;
      copy.appendChild(description);
    }
    item.appendChild(copy);
    optionList.appendChild(item);
  }
  if (question.isOther) {
    const other = document.createElement("div");
    other.className = "option-item option-item-other option-item-readonly";
    const label = document.createElement("span");
    label.className = "option-item-label";
    label.textContent = bubbleText(currentLang, "otherInCodex");
    other.appendChild(label);
    optionList.appendChild(other);
  }
  questionCard.appendChild(optionList);
  return questionCard;
}

function renderCodexUserInputStep(data) {
  const total = elicitationQuestions.length;
  activeQuestionIndex = Math.max(0, Math.min(activeQuestionIndex, Math.max(0, total - 1)));
  elicitationForm.innerHTML = "";
  if (total) {
    elicitationForm.appendChild(createCodexUserInputQuestionCard(
      elicitationQuestions[activeQuestionIndex],
      activeQuestionIndex
    ));
  }
  if (data.isRemote) {
    const remoteHint = document.createElement("div");
    remoteHint.className = "question-hint";
    remoteHint.textContent = bubbleText(currentLang, "returnToRemoteCodex");
    elicitationForm.appendChild(remoteHint);
  }
  elicitationProgress.textContent = total > 1
    ? bubbleText(currentLang, "questionProgress", { current: activeQuestionIndex + 1, total })
    : "";
  elicitationProgress.classList.toggle("visible", total > 1);
  suggestionsContainer.innerHTML = "";
  if (activeQuestionIndex > 0) {
    const previous = document.createElement("button");
    previous.className = "btn-suggestion";
    previous.textContent = bubbleText(currentLang, "previousQuestion");
    previous.addEventListener("click", () => {
      activeQuestionIndex -= 1;
      renderCodexUserInputStep(data);
    });
    suggestionsContainer.appendChild(previous);
  }
  if (activeQuestionIndex < total - 1) {
    const next = document.createElement("button");
    next.className = "btn-suggestion";
    next.textContent = bubbleText(currentLang, "nextQuestion");
    next.addEventListener("click", () => {
      activeQuestionIndex += 1;
      renderCodexUserInputStep(data);
    });
    suggestionsContainer.appendChild(next);
  }
  scheduleBubbleHeightReport();
}

function renderCodexUserInputPreview(data) {
  codexUserInputMode = true;
  elicitationQuestions = data.toolInput && Array.isArray(data.toolInput.questions)
    ? data.toolInput.questions
    : [];
  activeQuestionIndex = 0;
  elicitationForm.classList.add("visible");
  commandBlock.style.display = "none";
  renderCodexUserInputStep(data);
}

function show(data) {
  const isPassiveRefresh = data.toolName === "CodexExec"
    || data.toolName === "KimiPermission"
    || data.isCodexUserInputNotify === true;
  if (currentData && !isPassiveRefresh) {
    currentData = {
      ...currentData,
      lang: data.lang,
      sessionFolder: data.sessionFolder,
      sessionShortId: data.sessionShortId,
      canOfferSessionTrust: data.canOfferSessionTrust,
      sessionTrustError: data.sessionTrustError,
      presentation: data.presentation,
    };
    currentLang = currentData.lang || "en";
    setSessionTag(currentData);
    const presentation = currentData.presentation && typeof currentData.presentation === "object"
      ? currentData.presentation
      : {};
    currentExpanded = presentation.expanded === true;
    measurementEpoch = Number.isInteger(presentation.measurementEpoch)
      ? presentation.measurementEpoch
      : measurementEpoch;
    renderSessionTrustError(currentData.sessionTrustError);
    btnAllow.disabled = false;
    btnDeny.disabled = false;
    btnExpand.disabled = false;
    for (const button of suggestionsContainer.querySelectorAll("button")) button.disabled = false;
    for (const button of footerSecondary.querySelectorAll("button")) button.disabled = false;
    applyPresentationView();
    return;
  }
  if (currentData) {
    pendingRestoreState = {
      elicitationAnswers,
      activeQuestionIndex,
      planFeedbackText: planFeedbackTextarea.value,
      planFeedbackMode,
      scrollTop: detailScroll.scrollTop || 0,
    };
  }
  currentData = data;
  const presentation = data.presentation && typeof data.presentation === "object"
    ? data.presentation
    : {};
  currentExpanded = presentation.expanded === true;
  measurementEpoch = Number.isInteger(presentation.measurementEpoch)
    ? presentation.measurementEpoch
    : 0;
  resetBubbleContent();
  currentLang = data.lang || "en";
  const interaction = data.interaction && typeof data.interaction === "object"
    ? data.interaction
    : null;
  const interactionCapabilities = interaction && interaction.capabilities
    ? interaction.capabilities
    : {};
  const interactionIntent = interaction ? interaction.intent : "unknown";
  currentIsPlanReview = interactionIntent === "plan-review";
  elicitationMode = interactionIntent === "human-question"
    && interactionCapabilities.answerQuestions === true;
  setSessionTag(data);

  if (interactionIntent === "human-question" && !elicitationMode) {
    // The adapter identified a real user decision but cannot safely encode an
    // answer. Do not fabricate Claude updatedInput or show allow/deny controls;
    // hand the request back to the agent's native UI.
    headerTitle.textContent = bubbleText(data.lang, "needsInput");
    toolPill.style.display = "none";
    commandBlock.textContent = formatDetail(data.toolName, data.toolInput);
    btnAllow.style.display = "none";
    btnDeny.style.display = "none";
    suggestionsContainer.innerHTML = "";
    renderRegularTerminalFallback(data.lang);
    revealCard();
    return;
  }

  // opencode-family branch — Phase 2. Payload carries neutral family* fields
  // (familyAgentId presence selects this branch; the renderer has no registry
  // access). Three differences from CC:
  //   1. tool names are lowercase (edit/bash/write) — we PascalCase them so
  //      existing tool-pill CSS rules match (data-tool="Edit" etc).
  //   2. toolInput shape is opencode-native ({filepath,diff}/{command}/{url}),
  //      not CC's {file_path,command,pattern}. Custom picker below.
  //   3. "Always Allow" button maps to reply="always" via the single
  //      "family-always" behavior (handleDecide special-cases this).
  if (data.familyAgentId) {
    headerTitle.textContent = bubbleText(data.lang, "permissionRequest");

    const rawName = data.toolName || "unknown";
    const displayName = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    toolPillText.textContent = displayName;
    toolPill.setAttribute("data-tool", displayName);
    toolPill.style.display = "";

    // Command block preview: prefer concrete fields, then dedupe patterns,
    // then fall back to raw JSON. opencode edit metadata often repeats the
    // filepath (e.g. "foo.md, foo.md") — the Set dedupes that.
    const input = (data.toolInput && typeof data.toolInput === "object") ? data.toolInput : {};
    let detail = "";
    if (typeof input.filepath === "string" && input.filepath) {
      detail = [...new Set(input.filepath.split(",").map(s => s.trim()).filter(Boolean))].join(", ");
    } else if (typeof input.command === "string" && input.command) {
      detail = input.command;
    } else if (typeof input.url === "string" && input.url) {
      detail = input.url;
    } else if (Array.isArray(data.familyPatterns) && data.familyPatterns.length) {
      detail = [...new Set(data.familyPatterns)].join(", ");
    } else {
      try { detail = JSON.stringify(input); } catch { detail = "(n/a)"; }
    }
    commandBlock.textContent = truncate(detail, 200);

    btnAllow.textContent = bubbleText(data.lang, "allow");
    btnDeny.textContent = bubbleText(data.lang, "deny");
    btnAllow.style.display = "";
    btnDeny.style.display = "";
    btnAllow.disabled = false;
    btnDeny.disabled = false;

    // Always Allow button — shown only when the host provided persist candidates.
    // ⚠ The host's reply="always" is a BLANKET session rule: a single click
    // auto-approves every subsequent tool call of the same category in this
    // session (e.g. ALL bash commands including rm -rf). Unlike Claude Code,
    // opencode-family hosts do not scope "always" to the specific pattern of
    // this request. We keep the button to respect the native UX, but the label
    // + tooltip make the blast radius explicit — templated with the member's
    // real product name so a MiMo user never reads "opencode" in the warning.
    suggestionsContainer.innerHTML = "";
    if (Array.isArray(data.familyAlways) && data.familyAlways.length > 0) {
      const agentName = data.familyDisplayName || data.familyAgentId;
      const btn = document.createElement("button");
      btn.className = "btn-suggestion";
      btn.textContent = bubbleText(data.lang, "alwaysAllowBlanket");
      btn.title = bubbleText(data.lang, "alwaysAllowBlanketTitle", { agent: agentName });
      btn.addEventListener("click", () => {
        disableAll();
        window.bubbleAPI.decide("family-always");
      });
      suggestionsContainer.appendChild(btn);
    }
    renderRegularTerminalFallback(data.lang);
    revealCard();
    return;
  }

  if (elicitationMode) {
    // Elicitation mode — answer directly in the bubble, with terminal fallback.
    headerTitle.textContent = bubbleText(data.lang, "needsInput");
    toolPill.style.display = "none";
    renderElicitationForm(data);
    btnAllow.style.display = "";
    btnDeny.style.display = "";
    revealCard();
    return;
  }

  if (data.isCodexUserInputNotify) {
    headerTitle.textContent = bubbleText(data.lang, "codexNeedsInput");
    toolPillText.textContent = "CODEX";
    toolPill.setAttribute("data-tool", "CodexUserInput");
    toolPill.style.display = "";
    renderCodexUserInputPreview(data);
    btnAllow.textContent = data.isRemote
      ? bubbleText(data.lang, "gotIt")
      : bubbleText(data.lang, "goToCodex");
    btnAllow.disabled = false;
    btnDeny.style.display = "none";
    revealCard();
    return;
  }

  // Codex notify mode — informational bubble with Dismiss button only
  if (data.toolName === "CodexExec") {
    headerTitle.textContent = bubbleText(data.lang, "codexPermission");
    toolPillText.textContent = "CODEX";
    toolPill.setAttribute("data-tool", "CodexExec");
    toolPill.style.display = "";
    commandBlock.textContent = (data.toolInput && data.toolInput.command) || "(unknown)";
    btnAllow.textContent = bubbleText(data.lang, "gotIt");
    btnAllow.disabled = false;
    btnDeny.style.display = "none";
    suggestionsContainer.innerHTML = "";
    revealCard();
    return;
  }

  // Kimi notify mode — informational bubble with Dismiss button only
  if (data.toolName === "KimiPermission") {
    headerTitle.textContent = bubbleText(data.lang, "kimiPermission");
    // A native Kimi Code request forwards the real tool name plus a
    // whitelisted tool_input subset. When both are present, reuse the
    // standard cue path (formatDetail / detectIrreversible / real tool pill)
    // — display-only, the card stays dismiss-only. Without them (legacy
    // Python CLI, shape drift) this renders exactly the old generic card.
    const kimiTool = typeof data.kimiToolName === "string" && data.kimiToolName ? data.kimiToolName : null;
    const kimiInput = data.kimiToolInput && typeof data.kimiToolInput === "object" ? data.kimiToolInput : null;
    if (kimiTool && kimiInput) {
      const kimiMcp = parseMcpToolName(kimiTool);
      toolPillText.textContent = kimiMcp ? kimiMcp.display : kimiTool;
      toolPill.setAttribute("data-tool", kimiTool);
      // The fallbacks are defense-in-depth only: formatDetail's generic
      // last-resort loop returns non-empty for any server-normalized input.
      commandBlock.textContent = formatDetail(kimiTool, kimiInput)
        || (data.toolInput && data.toolInput.command)
        || bubbleText(data.lang, "checkKimiTerminal");
      const kimiIrreversible = detectIrreversible(kimiTool, kimiInput);
      if (kimiIrreversible) {
        irreversibleBadge.textContent = "\u26A0 " + bubbleText(data.lang, "irreversibleHint");
        irreversibleBadge.setAttribute("data-reason", kimiIrreversible.tag);
        irreversibleBadge.style.display = "";
      }
      // No else branch: resetBubbleContent() above already hid the badge.
    } else {
      toolPillText.textContent = "KIMI";
      toolPill.setAttribute("data-tool", "KimiPermission");
      commandBlock.textContent = (data.toolInput && data.toolInput.command) || bubbleText(data.lang, "checkKimiTerminal");
    }
    toolPill.style.display = "";
    btnAllow.textContent = bubbleText(data.lang, "goToTerminal");
    btnAllow.disabled = false;
    btnDeny.style.display = "none";
    suggestionsContainer.innerHTML = "";
    revealCard();
    return;
  }

  const isPlanReview = interactionIntent === "plan-review";
  const canPlanFeedback = isPlanReview && interactionCapabilities.planFeedback === true;
  // Issue #445: an MCP tool call (e.g. Codex + Vercel MCP) is not an OS
  // permission. For Codex MCP approvals, relabel the title and show a friendly
  // "server · tool" pill so "MCP__CODEX_APPS__VERCEL__LIST_PROJECTS" reads as
  // "vercel · list_projects". Parsing is display-only — Allow/Deny semantics and
  // the no-decision fallback are untouched.
  const mcp = parseMcpToolName(data.toolName);

  // Header
  let titleKey = "permissionRequest";
  if (isPlanReview) titleKey = "planReview";
  else if (mcp && data.isCodex) titleKey = "codexToolApproval";
  headerTitle.textContent = bubbleText(data.lang, titleKey);
  toolPill.style.display = isPlanReview ? "none" : "";
  btnDeny.style.display = canPlanFeedback ? "none" : "";

  // Tool pill — friendly "server · tool" for MCP, raw tool name otherwise
  toolPillText.textContent = mcp ? mcp.display : (data.toolName || "Unknown");
  toolPill.setAttribute("data-tool", data.toolName || "");

  // Command block (textContent only — never innerHTML)
  commandBlock.textContent = formatDetail(data.toolName, data.toolInput, { isAntigravity: !!data.isAntigravity });

  // Irreversible-action hint — display-only (like the MCP relabel above): routes the
  // human's attention to destructive decisions. Allow/Deny semantics, the
  // suggestion buttons, and the no-decision fallback are untouched. textContent only.
  const irreversible = detectIrreversible(data.toolName, data.toolInput);
  if (irreversible && !isPlanReview) {
    irreversibleBadge.textContent = "\u26A0 " + bubbleText(data.lang, "irreversibleHint");
    irreversibleBadge.setAttribute("data-reason", irreversible.tag);
    irreversibleBadge.style.display = "";
  } else {
    irreversibleBadge.textContent = "";
    irreversibleBadge.style.display = "none";
    irreversibleBadge.removeAttribute("data-reason");
  }

  // Button labels
  btnAllow.textContent = isPlanReview ? bubbleText(data.lang, "approve") : bubbleText(data.lang, "allow");
  btnDeny.textContent = isPlanReview ? bubbleText(data.lang, "reject") : bubbleText(data.lang, "deny");

  // Dynamic suggestion buttons
  suggestionsContainer.innerHTML = "";
  if (isPlanReview) {
    if (canPlanFeedback) {
      // Only adapters that explicitly support feedback get the Claude-style
      // textarea. A matching tool name alone is never sufficient.
      const tellBtn = document.createElement("button");
      tellBtn.className = "btn-suggestion";
      tellBtn.textContent = bubbleText(data.lang, "tellClaudeWhatToChange");
      tellBtn.addEventListener("click", () => enterPlanFeedbackMode(data.lang));
      suggestionsContainer.appendChild(tellBtn);
    }
    if (interactionCapabilities.nativeFallback === true) {
      renderRegularTerminalFallback(data.lang);
    }
  } else {
    if (Array.isArray(data.suggestions)) {
      const seenLabels = new Set();
      data.suggestions.forEach((s, i) => {
        const label = getSuggestionLabel(s, data.lang);
        if (seenLabels.has(label)) return;
        seenLabels.add(label);
        const btn = document.createElement("button");
        btn.className = "btn-suggestion";
        btn.textContent = label;
        btn.addEventListener("click", () => {
          disableAll();
          window.bubbleAPI.decide("suggestion:" + i);
        });
        suggestionsContainer.appendChild(btn);
      });
    }
    if (data.canOfferSessionTrust === true) {
      const trustBtn = document.createElement("button");
      trustBtn.className = "btn-suggestion";
      trustBtn.textContent = bubbleText(data.lang, "sessionTrust");
      trustBtn.addEventListener("click", () => {
        disableAll();
        window.bubbleAPI.decide("session-trust");
      });
      footerSecondary.appendChild(trustBtn);
      footerSecondary.classList.add("visible");
    }
    renderSessionTrustError(data.sessionTrustError);
    // Hermes and DSH permission cards get no generic terminal action. Hermes
    // has no native approval prompt; DSH's native web answerer is reached by
    // an explicit no-decision fallback, not a user allow/deny action.
    if (!data.isHermes && !data.isDsh) renderRegularTerminalFallback(data.lang);
  }
  // Re-enable buttons
  btnAllow.disabled = false;
  btnDeny.disabled = false;

  revealCard();
}

function hide() {
  card.classList.remove("visible");
  card.classList.add("hiding");
}

function handleElicitationPrimaryAction() {
  if (!isElicitationAnswerComplete(activeQuestionIndex)) {
    updateElicitationSubmitState();
    return;
  }

  if (activeQuestionIndex < elicitationQuestions.length - 1) {
    activeQuestionIndex += 1;
    renderElicitationStep();
    return;
  }

  const answers = collectElicitationAnswers();
  if (!answers) {
    updateElicitationSubmitState();
    return;
  }

  btnAllow.textContent = "...";
  disableAll();
  window.bubbleAPI.decide({ type: "elicitation-submit", answers });
}

function handleElicitationBackAction() {
  if (activeQuestionIndex <= 0) {
    updateElicitationSubmitState();
    return;
  }
  activeQuestionIndex -= 1;
  renderElicitationStep();
}

btnAllow.addEventListener("click", () => {
  if (elicitationMode) {
    handleElicitationPrimaryAction();
    return;
  }
  if (codexUserInputMode) {
    btnAllow.textContent = "...";
    disableAll();
    window.bubbleAPI.decide("codex-user-input-focus");
    return;
  }
  btnAllow.textContent = "...";
  disableAll();
  window.bubbleAPI.decide("allow");
});

btnDeny.addEventListener("click", () => {
  if (elicitationMode) {
    handleElicitationBackAction();
    return;
  }
  btnDeny.textContent = "...";
  disableAll();
  window.bubbleAPI.decide("deny");
});

// Elicitation-only Enter-to-submit: selecting a preset radio/checkbox then
// pressing Enter should send. textarea has its own Enter handler so we skip
// it here to avoid double-submit. Deliberately gated on elicitationMode so
// regular permission bubbles never auto-Allow on Enter.
document.addEventListener("keydown", (e) => {
  if (!elicitationMode) return;
  if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
  if (e.target && e.target.tagName === "TEXTAREA") return;
  if (btnAllow.disabled) return;
  e.preventDefault();
  btnAllow.click();
});

window.addEventListener("resize", applyElicitationViewport);

// ── Plan Feedback Mode ──

function enterPlanFeedbackMode(lang) {
  planFeedbackMode = true;
  // Hide action buttons and suggestions
  btnAllow.style.display = "none";
  btnDeny.style.display = "none";
  suggestionsContainer.style.display = "none";
  // Setup and show feedback form
  planFeedbackTextarea.placeholder = bubbleText(lang, "planFeedbackPlaceholder");
  planFeedbackSubmit.textContent = bubbleText(lang, "submitFeedback");
  planFeedbackBack.textContent = bubbleText(lang, "back");
  planFeedbackSubmit.disabled = true;
  planFeedbackForm.classList.add("visible");
  scheduleBubbleHeightReport();
  // Focus textarea after DOM settles (web-level focus, not window focus)
  requestAnimationFrame(() => planFeedbackTextarea.focus());
}

function exitPlanFeedbackMode() {
  planFeedbackMode = false;
  planFeedbackForm.classList.remove("visible");
  // Restore plan review layout: Approve visible, Deny hidden, suggestions visible
  btnAllow.style.display = "";
  btnDeny.style.display = "none";
  suggestionsContainer.style.display = "";
  scheduleBubbleHeightReport();
}

planFeedbackTextarea.addEventListener("input", () => {
  planFeedbackSubmit.disabled = !planFeedbackTextarea.value.trim();
  scheduleBubbleHeightReport();
});

planFeedbackTextarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!planFeedbackSubmit.disabled) planFeedbackSubmit.click();
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    exitPlanFeedbackMode();
  }
});

planFeedbackSubmit.addEventListener("click", () => {
  const feedback = planFeedbackTextarea.value.trim();
  if (!feedback) return;
  planFeedbackSubmit.disabled = true;
  planFeedbackBack.disabled = true;
  planFeedbackTextarea.disabled = true;
  window.bubbleAPI.decide({ type: "plan-feedback", feedback });
});

planFeedbackBack.addEventListener("click", () => {
  exitPlanFeedbackMode();
});

btnExpand.addEventListener("click", () => {
  if (btnExpand.disabled) return;
  window.bubbleAPI.setExpanded(true);
});

btnCollapse.addEventListener("click", () => {
  window.bubbleAPI.setExpanded(false);
});

if (typeof window.bubbleAPI.onPresentation === "function") {
  window.bubbleAPI.onPresentation((presentation) => {
    if (!presentation || typeof presentation !== "object") return;
    const nextEpoch = Number(presentation.measurementEpoch);
    if (!Number.isInteger(nextEpoch) || nextEpoch < measurementEpoch) return;
    measurementEpoch = nextEpoch;
    currentExpanded = presentation.expanded === true;
    applyPresentationView();
  });
}

if (typeof window.bubbleAPI.setCompositionActive === "function") {
  document.addEventListener("compositionstart", () => {
    window.bubbleAPI.setCompositionActive(true);
  });
  document.addEventListener("compositionend", () => {
    window.bubbleAPI.setCompositionActive(false);
  });
}

// While a text input inside the bubble is focused, tell the main process so it
// can drop the bubble out of always-on-top on macOS — otherwise the OS IME
// candidate window (Chinese/Japanese/Korean input popup) is occluded by the
// topmost bubble. focusin/focusout bubble up from any current or future text
// field (elicitation "Other", ExitPlanMode feedback) without per-field wiring.
function isTextInputElement(el) {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return type === "text" || type === "search";
  }
  return false;
}

if (window.bubbleAPI && typeof window.bubbleAPI.setImeEditing === "function") {
  // Dedupe so redundant transitions don't spam the main process (and so the
  // window-blur/focus net below only fires a real state change).
  let imeEditing = false;
  const setImeEditing = (active) => {
    if (active === imeEditing) return;
    imeEditing = active;
    window.bubbleAPI.setImeEditing(active);
  };
  document.addEventListener("focusin", (e) => {
    if (isTextInputElement(e.target)) setImeEditing(true);
  });
  document.addEventListener("focusout", (e) => {
    if (isTextInputElement(e.target)) setImeEditing(false);
  });
  // focusin/focusout are element-level: they do NOT fire when the whole window
  // loses/regains OS focus (e.g. Cmd-Tab away mid-composition to check a
  // reference — a routine CJK move). Without this, the editing flag would stay
  // set and reapplyMacVisibility() would strand the bubble out of always-on-top
  // for good. Mirror the window-blur listener used elsewhere in the app
  // (hit-renderer.js, tutorial-renderer.js): restore normal topmost while the
  // window is backgrounded, and re-drop it on return if a text field still
  // holds focus.
  window.addEventListener("blur", () => setImeEditing(false));
  window.addEventListener("focus", () => {
    if (isTextInputElement(document.activeElement)) setImeEditing(true);
  });
}

window.bubbleAPI.onPermissionShow(show);
window.bubbleAPI.onPermissionHide(hide);
