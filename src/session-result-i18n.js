"use strict";
const dictionaries = {
  en: {
    title: "Session results", completed: "Task completed", failed: "This turn failed",
    completedBody: "Open the session to view the result.", failedBody: "Open the original session for error details.",
    open: "View session", close: "Dismiss result", opening: "Opening…",
    unavailable: "Clawd cannot open this session. View it in the original app.",
    unconfirmed: "Open requested. You can dismiss this card after viewing.",
    openFailed: "Could not confirm opening. Try again or view it in the original app.",
  },
  zh: {
    title: "会话结果", completed: "任务已完成", failed: "本轮执行失败",
    completedBody: "在原会话中查看执行结果。", failedBody: "在原会话中查看错误详情。",
    open: "查看会话", close: "关闭结果卡", opening: "正在打开…",
    unavailable: "无法从 Clawd 打开此会话，请在原应用中查看。",
    unconfirmed: "已尝试打开，可查看后关闭此卡片。",
    openFailed: "未能确认打开，请重试或在原应用中查看。",
  },
  "zh-TW": {
    title: "工作階段結果", completed: "任務已完成", failed: "本輪執行失敗",
    completedBody: "在原工作階段中查看執行結果。", failedBody: "在原工作階段中查看錯誤詳情。",
    open: "查看工作階段", close: "關閉結果卡", opening: "正在開啟…",
    unavailable: "無法從 Clawd 開啟此工作階段，請在原應用程式中查看。",
    unconfirmed: "已嘗試開啟，查看後可關閉此卡片。",
    openFailed: "未能確認開啟，請重試或在原應用程式中查看。",
  },
  ko: {
    title: "세션 결과", completed: "작업 완료", failed: "이번 실행 실패",
    completedBody: "원래 세션에서 결과를 확인하세요.", failedBody: "원래 세션에서 오류 내용을 확인하세요.",
    open: "세션 보기", close: "결과 닫기", opening: "여는 중…",
    unavailable: "Clawd에서 이 세션을 열 수 없습니다. 원래 앱에서 확인하세요.",
    unconfirmed: "열기를 요청했습니다. 확인 후 이 카드를 닫을 수 있습니다.",
    openFailed: "열기를 확인하지 못했습니다. 다시 시도하거나 원래 앱에서 확인하세요.",
  },
  ja: {
    title: "セッションの結果", completed: "タスク完了", failed: "今回の実行は失敗しました",
    completedBody: "元のセッションで結果を確認できます。", failedBody: "元のセッションでエラーの詳細を確認できます。",
    open: "セッションを表示", close: "結果を閉じる", opening: "開いています…",
    unavailable: "Clawdからこのセッションを開けません。元のアプリで確認してください。",
    unconfirmed: "開く操作を送信しました。確認後にこのカードを閉じてください。",
    openFailed: "開いたことを確認できませんでした。再試行するか元のアプリで確認してください。",
  },
  "pt-BR": {
    title: "Resultados das sessões", completed: "Tarefa concluída", failed: "Esta execução falhou",
    completedBody: "Abra a sessão para ver o resultado.", failedBody: "Veja os detalhes do erro na sessão original.",
    open: "Ver sessão", close: "Dispensar resultado", opening: "Abrindo…",
    unavailable: "O Clawd não pode abrir esta sessão. Consulte o aplicativo original.",
    unconfirmed: "Abertura solicitada. Você pode dispensar este cartão após conferir.",
    openFailed: "Não foi possível confirmar a abertura. Tente novamente ou consulte o aplicativo original.",
  },
  es: {
    title: "Resultados de sesiones", completed: "Tarea completada", failed: "Esta ejecución falló",
    completedBody: "Abre la sesión para ver el resultado.", failedBody: "Consulta los detalles del error en la sesión original.",
    open: "Ver sesión", close: "Descartar resultado", opening: "Abriendo…",
    unavailable: "Clawd no puede abrir esta sesión. Consúltala en la aplicación original.",
    unconfirmed: "Se solicitó la apertura. Puedes descartar esta tarjeta después de revisarla.",
    openFailed: "No se pudo confirmar la apertura. Reintenta o consulta la aplicación original.",
  },
};
module.exports = {
  dictionaries,
  getSessionResultDictionary: lang => dictionaries[lang] || dictionaries.en,
};
