"use strict";

(function initLanguagePicker(root) {
  let nextPickerId = 1;

  function normalizeOptions(options) {
    if (!Array.isArray(options)) return [];
    return options.map((option) => {
      if (typeof option === "string") return { value: option, label: option };
      if (!option || option.value == null) return null;
      return {
        value: String(option.value),
        label: option.label == null ? String(option.value) : String(option.label),
      };
    }).filter(Boolean);
  }

  function createLanguagePicker(config = {}) {
    const options = normalizeOptions(config.options);
    const ariaLabel = config.ariaLabel == null ? "" : String(config.ariaLabel);
    const picker = document.createElement("div");
    const extraClassName = config.className == null ? "" : String(config.className).trim();
    picker.className = `language-picker${extraClassName ? ` ${extraClassName}` : ""}`;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "language-picker-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const valueEl = document.createElement("span");
    valueEl.className = "language-picker-value";
    const chevron = document.createElement("span");
    chevron.className = "language-picker-chevron";
    chevron.setAttribute("aria-hidden", "true");
    trigger.appendChild(valueEl);
    trigger.appendChild(chevron);

    const menu = document.createElement("div");
    menu.className = "language-picker-menu";
    menu.id = `settings-picker-menu-${nextPickerId++}`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-hidden", "true");
    trigger.setAttribute("aria-controls", menu.id);
    if (ariaLabel) menu.setAttribute("aria-label", ariaLabel);

    const optionElements = [];
    for (const option of options) {
      const optionEl = document.createElement("button");
      optionEl.type = "button";
      optionEl.className = "language-picker-option";
      optionEl.setAttribute("role", "option");
      optionEl.setAttribute("data-lang", option.value);
      optionEl.textContent = option.label;
      menu.appendChild(optionEl);
      optionElements.push({ data: option, element: optionEl });
    }

    picker.appendChild(trigger);
    picker.appendChild(menu);

    let activeValue = "";
    let committedValue = "";
    let isOpen = false;
    let disposed = false;
    let disabled = config.disabled === true || optionElements.length === 0;
    let pending = config.pending === true;
    let changeSeq = 0;
    let latestRequestSeq = 0;
    const pendingChanges = new Map();
    let reflowScheduled = false;
    let reflowFrame = null;

    const MENU_GAP_PX = 6;
    const DEFAULT_MENU_MAX_HEIGHT_PX = 240;

    function findOption(value) {
      const wanted = value == null ? "" : String(value);
      return optionElements.find((entry) => entry.data.value === wanted) || null;
    }

    function paintValue(value) {
      const entry = findOption(value) || optionElements[0] || null;
      activeValue = entry ? entry.data.value : "";
      valueEl.textContent = entry ? entry.data.label : "";
      if (ariaLabel) {
        trigger.setAttribute(
          "aria-label",
          valueEl.textContent ? `${ariaLabel}: ${valueEl.textContent}` : ariaLabel,
        );
      }
      for (const item of optionElements) {
        const selected = item.data.value === activeValue;
        item.element.classList.toggle("selected", selected);
        item.element.setAttribute("aria-selected", selected ? "true" : "false");
        item.element.tabIndex = isOpen && selected ? 0 : -1;
      }
    }

    function paintInteractivity() {
      picker.classList.toggle("disabled", disabled);
      picker.classList.toggle("pending", pending);
      trigger.disabled = disabled || (config.lockWhilePending === true && pending);
      trigger.setAttribute("aria-disabled", trigger.disabled ? "true" : "false");
    }

    function focusElement(element) {
      if (!element || typeof element.focus !== "function") return;
      try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
    }

    function finiteNumber(value) {
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    }

    function findPlacementBoundary() {
      let current = picker.parentNode;
      while (current) {
        const hasBoundary = typeof current.hasAttribute === "function"
          ? current.hasAttribute("data-language-picker-boundary")
          : (typeof current.getAttribute === "function"
            && current.getAttribute("data-language-picker-boundary") != null);
        if (hasBoundary) return current;
        current = current.parentNode;
      }
      return null;
    }

    function getPlacementBounds() {
      const viewportHeight = finiteNumber(root && root.innerHeight)
        || finiteNumber(document && document.documentElement && document.documentElement.clientHeight);
      if (!viewportHeight || viewportHeight <= 0) return null;

      let top = 0;
      let bottom = viewportHeight;
      const boundary = findPlacementBoundary();
      if (boundary && typeof boundary.getBoundingClientRect === "function") {
        const rect = boundary.getBoundingClientRect();
        const boundaryTop = finiteNumber(rect && rect.top);
        const boundaryBottom = finiteNumber(rect && rect.bottom);
        if (boundaryTop != null && boundaryBottom != null && boundaryBottom > boundaryTop) {
          top = Math.max(top, boundaryTop);
          bottom = Math.min(bottom, boundaryBottom);
        }
      }
      return bottom > top ? { top, bottom } : null;
    }

    function ensureVisible() {
      if (disposed || typeof trigger.getBoundingClientRect !== "function") return;
      const boundary = findPlacementBoundary();
      if (!boundary) return;
      const bounds = getPlacementBounds();
      const triggerRect = trigger.getBoundingClientRect();
      const triggerTop = finiteNumber(triggerRect && triggerRect.top);
      const triggerBottom = finiteNumber(triggerRect && triggerRect.bottom);
      if (!bounds || triggerTop == null || triggerBottom == null) return;

      let delta = 0;
      if (triggerTop < bounds.top + MENU_GAP_PX) {
        delta = triggerTop - bounds.top - MENU_GAP_PX;
      } else if (triggerBottom > bounds.bottom - MENU_GAP_PX) {
        delta = triggerBottom - bounds.bottom + MENU_GAP_PX;
      }
      if (!delta) return;

      const currentScrollTop = finiteNumber(boundary.scrollTop) || 0;
      boundary.scrollTop = Math.max(0, currentScrollTop + delta);
    }

    function positionMenu() {
      picker.classList.remove("open-up");
      picker.classList.remove("menu-scrollable");
      menu.style.maxHeight = "";
      if (typeof trigger.getBoundingClientRect !== "function") return;

      const bounds = getPlacementBounds();
      const triggerRect = trigger.getBoundingClientRect();
      const triggerTop = finiteNumber(triggerRect && triggerRect.top);
      const triggerBottom = finiteNumber(triggerRect && triggerRect.bottom);
      if (!bounds || triggerTop == null || triggerBottom == null) return;

      const contentHeight = finiteNumber(menu.scrollHeight) || DEFAULT_MENU_MAX_HEIGHT_PX;
      const offsetHeight = finiteNumber(menu.offsetHeight) || contentHeight;
      const clientHeight = finiteNumber(menu.clientHeight) || contentHeight;
      const naturalHeight = contentHeight + Math.max(0, offsetHeight - clientHeight);
      const availableAbove = Math.max(0, triggerTop - bounds.top - MENU_GAP_PX);
      const availableBelow = Math.max(0, bounds.bottom - triggerBottom - MENU_GAP_PX);
      const openUp = availableBelow < naturalHeight && availableAbove > availableBelow;
      const availableHeight = openUp ? availableAbove : availableBelow;
      const maxHeight = Math.floor(Math.min(
        DEFAULT_MENU_MAX_HEIGHT_PX,
        naturalHeight,
        availableHeight,
      ));

      picker.classList.toggle("open-up", openUp);
      picker.classList.toggle("menu-scrollable", maxHeight < naturalHeight);
      menu.style.maxHeight = maxHeight + "px";
    }

    function reflow() {
      if (disposed) return;
      ensureVisible();
      if (isOpen) positionMenu();
    }

    function scheduleReflow() {
      if (disposed || reflowScheduled) return;
      reflowScheduled = true;
      const run = () => {
        reflowScheduled = false;
        reflowFrame = null;
        reflow();
      };
      if (root && typeof root.requestAnimationFrame === "function") {
        reflowFrame = root.requestAnimationFrame(run);
      } else {
        run();
      }
    }

    function setOpen(next, { focusTrigger = false } = {}) {
      if (disposed) return;
      isOpen = !!next && optionElements.length > 0 && !trigger.disabled;
      picker.classList.toggle("open", isOpen);
      trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      menu.setAttribute("aria-hidden", isOpen ? "false" : "true");
      paintValue(activeValue);
      if (isOpen) {
        positionMenu();
        const selected = findOption(activeValue);
        focusElement(selected && selected.element);
      } else if (focusTrigger) {
        focusElement(trigger);
      }
    }

    function settleChange(seq, next, succeeded) {
      if (disposed || !pendingChanges.has(seq)) return;
      pendingChanges.delete(seq);
      if (succeeded) committedValue = next;

      const latestPending = pendingChanges.get(latestRequestSeq);
      paintValue(latestPending || committedValue);
      pending = pendingChanges.size > 0;
      paintInteractivity();
    }

    function choose(value) {
      if (disposed || trigger.disabled) return;
      const entry = findOption(value);
      if (!entry) return;
      if (entry.data.value === activeValue) {
        setOpen(false, { focusTrigger: true });
        return;
      }

      const previous = committedValue;
      paintValue(entry.data.value);
      setOpen(false, { focusTrigger: true });
      const seq = ++changeSeq;
      latestRequestSeq = seq;
      pendingChanges.set(seq, entry.data.value);
      pending = true;
      paintInteractivity();
      let result;
      try {
        result = typeof config.onChange === "function"
          ? config.onChange(entry.data.value, previous)
          : undefined;
      } catch (_) {
        settleChange(seq, entry.data.value, false);
        return;
      }
      Promise.resolve(result).then((outcome) => {
        const succeeded = outcome !== false && !(outcome && outcome.status === "error");
        settleChange(seq, entry.data.value, succeeded);
      }, () => {
        settleChange(seq, entry.data.value, false);
      });
    }

    function moveFocus(index, delta) {
      if (!optionElements.length) return;
      const nextIndex = (index + delta + optionElements.length) % optionElements.length;
      focusElement(optionElements[nextIndex].element);
    }

    trigger.addEventListener("click", () => setOpen(!isOpen));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
        return;
      }
      if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        setOpen(!isOpen);
        return;
      }
      if (event.key === "Escape" && isOpen) {
        event.preventDefault();
        setOpen(false, { focusTrigger: true });
        return;
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setOpen(true);
        const target = event.key === "Home" ? optionElements[0] : optionElements[optionElements.length - 1];
        focusElement(target && target.element);
      }
    });

    for (const item of optionElements) {
      item.element.addEventListener("click", () => choose(item.data.value));
      item.element.addEventListener("keydown", (event) => {
        const index = optionElements.indexOf(item);
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false, { focusTrigger: true });
          return;
        }
        if (event.key === "Enter" || event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          choose(item.data.value);
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(index, event.key === "ArrowDown" ? 1 : -1);
          return;
        }
        if (event.key === "Home" || event.key === "End") {
          event.preventDefault();
          const target = event.key === "Home" ? optionElements[0] : optionElements[optionElements.length - 1];
          focusElement(target && target.element);
        }
      });
    }

    const closeOnOutsideClick = (event) => {
      if (!isOpen || picker.contains(event && event.target)) return;
      setOpen(false);
    };
    const closeOnEscape = (event) => {
      if (!isOpen || !event || event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false, { focusTrigger: true });
    };
    if (document && typeof document.addEventListener === "function") {
      document.addEventListener("click", closeOnOutsideClick);
      document.addEventListener("keydown", closeOnEscape);
    }
    if (root && typeof root.addEventListener === "function") {
      root.addEventListener("resize", scheduleReflow);
    }

    paintValue(config.value);
    committedValue = activeValue;
    paintInteractivity();

    return {
      element: picker,
      ensureVisible,
      reflow,
      setValue(value) {
        if (disposed) return;
        changeSeq++;
        latestRequestSeq = changeSeq;
        pendingChanges.clear();
        paintValue(value);
        committedValue = activeValue;
      },
      setDisabled(value) {
        if (disposed) return;
        disabled = value === true || optionElements.length === 0;
        if (disabled) setOpen(false);
        paintInteractivity();
      },
      setPending(value) {
        if (disposed) return;
        pending = value === true;
        if (pending && config.lockWhilePending === true) setOpen(false);
        paintInteractivity();
      },
      getValue() {
        return activeValue;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        changeSeq++;
        pendingChanges.clear();
        if (reflowScheduled && reflowFrame != null
            && root && typeof root.cancelAnimationFrame === "function") {
          root.cancelAnimationFrame(reflowFrame);
        }
        reflowScheduled = false;
        reflowFrame = null;
        if (document && typeof document.removeEventListener === "function") {
          document.removeEventListener("click", closeOnOutsideClick);
          document.removeEventListener("keydown", closeOnEscape);
        }
        if (root && typeof root.removeEventListener === "function") {
          root.removeEventListener("resize", scheduleReflow);
        }
      },
    };
  }

  root.ClawdLanguagePicker = {
    createLanguagePicker,
    createSettingsSelect: createLanguagePicker,
  };
})(globalThis);
