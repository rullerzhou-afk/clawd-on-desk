"use strict";

(function initRoamFencePicker() {
  const STRINGS = {
    en: { title: "Choose Clawd's activity area", hint: "Drag to draw an area, then drag inside to move it or an edge to resize. Keyboard: an arrow creates a centered area; arrows move it and Shift+arrows resize it. The whole pet must fit inside.", confirm: "Use this area", cancel: "Cancel", tooSmall: "Too small" },
    zh: { title: "框选 Clawd 的活动范围", hint: "拖动鼠标框选；松开后可拖动框内移动，也可拖动边缘或角点缩放。键盘：方向键先建立居中选区，再用方向键移动、Shift+方向键缩放。范围必须放得下整个桌宠。", confirm: "使用此范围", cancel: "取消", tooSmall: "范围太小" },
    "zh-TW": { title: "框選 Clawd 的活動範圍", hint: "拖曳滑鼠框選；放開後可拖曳框內移動，也可拖曳邊緣或角點縮放。鍵盤：方向鍵先建立置中選區，再用方向鍵移動、Shift+方向鍵縮放。範圍必須容納完整桌寵。", confirm: "使用此範圍", cancel: "取消", tooSmall: "範圍太小" },
    ko: { title: "Clawd 활동 영역 선택", hint: "드래그해 영역을 그린 뒤 안쪽을 드래그해 이동하거나 가장자리를 드래그해 크기를 조절하세요. 키보드에서는 화살표로 가운데 영역을 만들고, 화살표로 이동하며 Shift+화살표로 크기를 조절합니다. 펫 전체가 들어가야 합니다.", confirm: "이 영역 사용", cancel: "취소", tooSmall: "영역이 너무 작음" },
    ja: { title: "Clawd の活動範囲を選択", hint: "ドラッグで範囲を描き、内側をドラッグして移動、辺や角をドラッグしてサイズ変更できます。キーボードでは矢印キーで中央に範囲を作成し、矢印で移動、Shift+矢印でサイズ変更します。ペット全体が収まる必要があります。", confirm: "この範囲を使う", cancel: "キャンセル", tooSmall: "範囲が小さすぎます" },
    "pt-BR": { title: "Escolher a área de atividade do Clawd", hint: "Arraste para desenhar uma área; depois arraste por dentro para mover ou pelas bordas para redimensionar. Teclado: uma seta cria uma área central; as setas movem e Shift+setas redimensionam. O pet inteiro precisa caber.", confirm: "Usar esta área", cancel: "Cancelar", tooSmall: "Área pequena demais" },
    es: { title: "Elegir el área de actividad de Clawd", hint: "Arrastra para dibujar un área; después arrastra dentro para moverla o desde los bordes para cambiar su tamaño. Teclado: una flecha crea un área centrada; las flechas la mueven y Mayús+flechas cambian su tamaño. La mascota debe caber por completo.", confirm: "Usar esta área", cancel: "Cancelar", tooSmall: "El área es demasiado pequeña" },
  };
  const api = window.roamFencePickerAPI;
  const geometry = window.roamFencePickerGeometry;
  const selectionElement = document.getElementById("selection");
  const sizeElement = document.getElementById("selection-size");
  const titleElement = document.getElementById("title");
  const hintElement = document.getElementById("hint");
  const confirmButton = document.getElementById("confirm");
  const cancelButton = document.getElementById("cancel");
  let context = null;
  let strings = STRINGS.en;
  let selection = null;
  let start = null;
  let initialSelection = null;
  let dragMode = "draw";
  let dragging = false;
  let activePointerId = null;
  const KEYBOARD_STEP = 10;

  function isSelectionValid() {
    return !!selection && !!context
      && selection.width >= context.minimumSize.width
      && selection.height >= context.minimumSize.height;
  }

  function renderSelection() {
    if (!selection) {
      selectionElement.style.display = "none";
      confirmButton.disabled = true;
      return;
    }
    selectionElement.style.display = "block";
    selectionElement.style.left = `${selection.x}px`;
    selectionElement.style.top = `${selection.y}px`;
    selectionElement.style.width = `${selection.width}px`;
    selectionElement.style.height = `${selection.height}px`;
    selectionElement.classList.toggle("editing", !dragging || dragMode !== "draw");
    const valid = isSelectionValid();
    selectionElement.classList.toggle("invalid", !valid);
    sizeElement.textContent = valid
      ? `${Math.round(selection.width)} × ${Math.round(selection.height)}`
      : `${strings.tooSmall} · ${Math.round(selection.width)} × ${Math.round(selection.height)}`;
    confirmButton.disabled = !valid;
  }

  function pointerPoint(event) {
    return {
      x: Math.min(Math.round(context.workArea.width), Math.max(0, Math.round(event.clientX))),
      y: Math.min(Math.round(context.workArea.height), Math.max(0, Math.round(event.clientY))),
    };
  }

  function updateFromPoint(point) {
    selection = geometry.updateSelection(
      dragMode,
      start,
      point,
      initialSelection,
      context.workArea,
    );
    renderSelection();
  }

  function updateHoverCursor(point) {
    const mode = geometry.hitTestSelection(selection, point);
    document.body.style.cursor = geometry.cursorForMode(mode);
  }

  function finishPointerInteraction(event, updateFinalPoint = true) {
    if (!dragging || activePointerId === null || event.pointerId !== activePointerId) return;
    const pointerId = activePointerId;
    const point = context ? pointerPoint(event) : null;
    if (updateFinalPoint && start && point) updateFromPoint(point);
    dragging = false;
    activePointerId = null;
    start = null;
    initialSelection = null;
    try { document.body.releasePointerCapture(pointerId); } catch {}
    renderSelection();
    if (point) updateHoverCursor(point);
  }

  function createCenteredSelection() {
    const areaWidth = Math.max(1, Math.round(context.workArea.width));
    const areaHeight = Math.max(1, Math.round(context.workArea.height));
    const width = Math.min(areaWidth, Math.max(
      Math.ceil(context.minimumSize.width),
      Math.round(areaWidth / 2),
    ));
    const height = Math.min(areaHeight, Math.max(
      Math.ceil(context.minimumSize.height),
      Math.round(areaHeight / 2),
    ));
    selection = {
      x: Math.round((areaWidth - width) / 2),
      y: Math.round((areaHeight - height) / 2),
      width,
      height,
    };
    renderSelection();
    document.body.style.cursor = "move";
  }

  function handleArrowKey(event) {
    const delta = {
      ArrowLeft: { x: -KEYBOARD_STEP, y: 0 },
      ArrowRight: { x: KEYBOARD_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_STEP },
      ArrowDown: { x: 0, y: KEYBOARD_STEP },
    }[event.key];
    if (!delta || !context || dragging) return false;
    if (!selection) {
      createCenteredSelection();
      return true;
    }
    const initial = { ...selection };
    if (event.shiftKey) {
      const mode = delta.x ? "e" : "s";
      const startPoint = {
        x: initial.x + initial.width,
        y: initial.y + initial.height,
      };
      selection = geometry.updateSelection(
        mode,
        startPoint,
        { x: startPoint.x + delta.x, y: startPoint.y + delta.y },
        initial,
        context.workArea,
      );
      document.body.style.cursor = geometry.cursorForMode(mode);
    } else {
      const startPoint = { x: initial.x, y: initial.y };
      selection = geometry.updateSelection(
        "move",
        startPoint,
        { x: startPoint.x + delta.x, y: startPoint.y + delta.y },
        initial,
        context.workArea,
      );
      document.body.style.cursor = "move";
    }
    renderSelection();
    return true;
  }

  document.body.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (!context || event.button !== 0
      || (target && typeof target.closest === "function" && target.closest("#actions"))) return;
    if (activePointerId !== null) {
      if (event.pointerId !== activePointerId) return;
      // Recover if an earlier stream lost its terminal event. A fresh down from
      // the same physical mouse is authoritative and starts a new transaction.
      finishPointerInteraction(event, false);
    }
    dragging = true;
    activePointerId = event.pointerId;
    start = pointerPoint(event);
    initialSelection = selection ? { ...selection } : null;
    dragMode = geometry.hitTestSelection(selection, start);
    selection = geometry.updateSelection(dragMode, start, start, initialSelection, context.workArea);
    document.body.style.cursor = geometry.cursorForMode(dragMode);
    try { document.body.setPointerCapture(event.pointerId); } catch {}
    renderSelection();
  });
  document.body.addEventListener("pointermove", (event) => {
    if (!context) return;
    const point = pointerPoint(event);
    if (!dragging || !start) { updateHoverCursor(point); return; }
    if (event.pointerId !== activePointerId) return;
    updateFromPoint(point);
  });
  document.body.addEventListener("pointerup", (event) => finishPointerInteraction(event));
  // A normal capture release also emits lostpointercapture, sometimes after a
  // new mouse gesture has already reused the same pointerId. Treating that
  // delayed event as cancellation can roll the new drag back to its start.
  // pointercancel is the authoritative interruption signal; keep the last
  // visible rectangle instead of surprising the user with an undo.
  document.body.addEventListener("pointercancel", (event) => finishPointerInteraction(event, false));
  confirmButton.addEventListener("click", () => {
    if (isSelectionValid()) api.confirm(selection);
  });
  cancelButton.addEventListener("click", () => api.cancel());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      api.cancel();
      return;
    }
    const target = event.target;
    const nativeButtonAction = target && typeof target.closest === "function" && target.closest("button");
    if (!nativeButtonAction && handleArrowKey(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" && !dragging && !nativeButtonAction && isSelectionValid()) {
      event.preventDefault();
      api.confirm(selection);
    }
  });

  api.onState((nextContext) => {
    context = nextContext;
    strings = STRINGS[context.lang] || STRINGS.en;
    document.documentElement.lang = context.lang;
    titleElement.textContent = strings.title;
    hintElement.textContent = strings.hint;
    confirmButton.textContent = strings.confirm;
    cancelButton.textContent = strings.cancel;
    dragging = false;
    activePointerId = null;
    start = null;
    initialSelection = null;
    selection = null;
    renderSelection();
    document.body.style.cursor = "crosshair";
    api.applied();
  });
  api.ready();
})();
