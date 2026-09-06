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
    const viewportPlacement = config.viewportPlacement === "up"
      || config.viewportPlacement === "down"
      ? config.viewportPlacement
      : null;
    const usesViewportPlacement = viewportPlacement !== null;
    const picker = document.createElement("div");
    const extraClassName = config.className == null ? "" : String(config.className).trim();
    picker.className = `language-picker${extraClassName ? ` ${extraClassName}` : ""}`;
    picker.classList.toggle("viewport-fixed", usesViewportPlacement);

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "language-picker-trigger";
    trigger.setAttribute("role", "combobox");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    if (config.focusKey != null && String(config.focusKey).trim()) {
      trigger.setAttribute("data-settings-focus-key", String(config.focusKey).trim());
    }

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
    let pendingFocusTarget = null;
    let reflowScheduled = false;
    let reflowFrame = null;
    let menuUnmountTimer = null;
    let menuUnmountTransitionHandler = null;
    let menuLifecycleSeq = 0;
    let scrollBoundary = null;

    const MENU_GAP_PX = 6;
    const VIEWPORT_EDGE_INSET_PX = 12;
    const DEFAULT_MENU_MAX_HEIGHT_PX = 240;
    const PREFERRED_PLACEMENT_MIN_HEIGHT_PX = 120;
    const MENU_CLOSE_FALLBACK_MIN_MS = 180;
    const MENU_CLOSE_SAFETY_MS = 40;

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

    function isInteractionLocked() {
      return disabled || (config.lockWhilePending === true && pending);
    }

    function paintInteractivity() {
      picker.classList.toggle("disabled", disabled);
      picker.classList.toggle("pending", pending);
      // A transient save must not disable the focused trigger: Chromium moves
      // focus to BODY when a button becomes disabled. aria-disabled plus the
      // event guards below keep it locked without losing keyboard position.
      trigger.disabled = disabled;
      trigger.setAttribute("aria-disabled", isInteractionLocked() ? "true" : "false");
      trigger.setAttribute("aria-busy", pending ? "true" : "false");
    }

    function focusElement(element) {
      if (!element || typeof element.focus !== "function") return;
      try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
    }

    function restoreFocusIfLost(element) {
      if (!element || element.isConnected === false || typeof element.focus !== "function") return;
      const active = document.activeElement;
      if (active && active !== document.body && active !== element && active.isConnected !== false) return;
      focusElement(element);
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
      const viewportWidth = finiteNumber(root && root.innerWidth)
        || finiteNumber(document && document.documentElement && document.documentElement.clientWidth);
      let left = 0;
      let right = viewportWidth && viewportWidth > 0 ? viewportWidth : null;
      const boundary = findPlacementBoundary();
      if (boundary && typeof boundary.getBoundingClientRect === "function") {
        const rect = boundary.getBoundingClientRect();
        const boundaryTop = finiteNumber(rect && rect.top);
        const boundaryBottom = finiteNumber(rect && rect.bottom);
        const boundaryLeft = finiteNumber(rect && rect.left);
        const boundaryRight = finiteNumber(rect && rect.right);
        if (boundaryTop != null && boundaryBottom != null && boundaryBottom > boundaryTop) {
          top = Math.max(top, boundaryTop);
          bottom = Math.min(bottom, boundaryBottom);
        }
        if (boundaryLeft != null && boundaryRight != null && boundaryRight > boundaryLeft) {
          left = Math.max(left, boundaryLeft);
          right = right == null ? boundaryRight : Math.min(right, boundaryRight);
        }
      }
      if (usesViewportPlacement) {
        top += VIEWPORT_EDGE_INSET_PX;
        bottom -= VIEWPORT_EDGE_INSET_PX;
        left += VIEWPORT_EDGE_INSET_PX;
        if (right != null) right -= VIEWPORT_EDGE_INSET_PX;
      }
      return bottom > top ? { top, bottom, left, right } : null;
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
      resetFixedMenuGeometry();
      if (typeof trigger.getBoundingClientRect !== "function") return;

      const bounds = getPlacementBounds();
      const triggerRect = trigger.getBoundingClientRect();
      const triggerTop = finiteNumber(triggerRect && triggerRect.top);
      const triggerBottom = finiteNumber(triggerRect && triggerRect.bottom);
      const triggerLeft = finiteNumber(triggerRect && triggerRect.left);
      const triggerRight = finiteNumber(triggerRect && triggerRect.right);
      const triggerWidth = finiteNumber(triggerRect && triggerRect.width)
        || (triggerLeft != null && triggerRight != null ? triggerRight - triggerLeft : null);
      if (!bounds || triggerTop == null || triggerBottom == null) return;

      const contentHeight = finiteNumber(menu.scrollHeight) || DEFAULT_MENU_MAX_HEIGHT_PX;
      const offsetHeight = finiteNumber(menu.offsetHeight) || contentHeight;
      const clientHeight = finiteNumber(menu.clientHeight) || contentHeight;
      const naturalHeight = contentHeight + Math.max(0, offsetHeight - clientHeight);
      const availableAbove = Math.max(0, triggerTop - bounds.top - MENU_GAP_PX);
      const availableBelow = Math.max(0, bounds.bottom - triggerBottom - MENU_GAP_PX);
      const preferredMinimum = Math.min(naturalHeight, PREFERRED_PLACEMENT_MIN_HEIGHT_PX);
      let openUp;
      if (viewportPlacement === "up") {
        openUp = availableAbove >= preferredMinimum || availableBelow <= availableAbove;
      } else if (viewportPlacement === "down") {
        openUp = availableBelow < preferredMinimum && availableAbove > availableBelow;
      } else {
        openUp = availableBelow < naturalHeight && availableAbove > availableBelow;
      }
      const availableHeight = openUp ? availableAbove : availableBelow;
      const maxHeight = Math.floor(Math.min(
        DEFAULT_MENU_MAX_HEIGHT_PX,
        naturalHeight,
        availableHeight,
      ));

      picker.classList.toggle("open-up", openUp);
      picker.classList.toggle("menu-scrollable", maxHeight < naturalHeight);
      menu.style.maxHeight = maxHeight + "px";
      if (usesViewportPlacement) {
        const renderedHeight = Math.min(naturalHeight, maxHeight);
        const maxWidth = bounds.right == null ? null : Math.max(0, bounds.right - bounds.left);
        const renderedWidth = triggerWidth == null
          ? null
          : (maxWidth == null ? triggerWidth : Math.min(triggerWidth, maxWidth));
        let menuLeft = triggerLeft;
        if (menuLeft != null) {
          if (bounds.right != null && renderedWidth != null) {
            menuLeft = Math.min(menuLeft, bounds.right - renderedWidth);
          }
          menuLeft = Math.max(bounds.left, menuLeft);
          menu.style.left = `${menuLeft}px`;
        }
        if (renderedWidth != null) menu.style.width = `${renderedWidth}px`;
        const menuTop = openUp
          ? Math.max(bounds.top, triggerTop - MENU_GAP_PX - renderedHeight)
          : Math.min(triggerBottom + MENU_GAP_PX, bounds.bottom - renderedHeight);
        menu.style.top = `${Math.max(bounds.top, menuTop)}px`;
        menu.style.right = "auto";
        menu.style.bottom = "auto";
      }
    }

    function resetFixedMenuGeometry() {
      menu.style.maxHeight = "";
      if (!usesViewportPlacement) return;
      menu.style.top = "";
      menu.style.right = "";
      menu.style.bottom = "";
      menu.style.left = "";
      menu.style.width = "";
    }

    function cancelMenuUnmount() {
      menuLifecycleSeq += 1;
      if (menuUnmountTransitionHandler) {
        menu.removeEventListener("transitionend", menuUnmountTransitionHandler);
        menuUnmountTransitionHandler = null;
      }
      if (menuUnmountTimer != null && root && typeof root.clearTimeout === "function") {
        root.clearTimeout(menuUnmountTimer);
      }
      menuUnmountTimer = null;
    }

    function resetMenuLayout() {
      picker.classList.remove("open-up");
      picker.classList.remove("menu-scrollable");
      resetFixedMenuGeometry();
      menu.scrollTop = 0;
    }

    function detachScrollBoundary() {
      if (!scrollBoundary || typeof scrollBoundary.removeEventListener !== "function") return;
      scrollBoundary.removeEventListener("scroll", closeOnBoundaryScroll);
      scrollBoundary = null;
    }

    function attachScrollBoundary() {
      if (!usesViewportPlacement) return;
      const nextBoundary = findPlacementBoundary();
      if (nextBoundary === scrollBoundary) return;
      detachScrollBoundary();
      if (!nextBoundary || typeof nextBoundary.addEventListener !== "function") return;
      scrollBoundary = nextBoundary;
      scrollBoundary.addEventListener("scroll", closeOnBoundaryScroll);
    }

    function revealOptionInMenu(option) {
      if (!option) return;
      const optionTop = finiteNumber(option.offsetTop);
      const optionHeight = finiteNumber(option.offsetHeight);
      const viewportHeight = finiteNumber(menu.clientHeight);
      if (optionTop == null || optionHeight == null || !viewportHeight || viewportHeight <= 0) return;

      const viewportTop = finiteNumber(menu.scrollTop) || 0;
      const optionBottom = optionTop + optionHeight;
      const viewportBottom = viewportTop + viewportHeight;
      if (optionTop < viewportTop) {
        menu.scrollTop = optionTop;
      } else if (optionBottom > viewportBottom) {
        menu.scrollTop = optionBottom - viewportHeight;
      }
    }

    function focusOption(option) {
      revealOptionInMenu(option);
      focusElement(option);
    }

    function finalizeMenuUnmount(expectedSeq = menuLifecycleSeq) {
      if (disposed || isOpen || expectedSeq !== menuLifecycleSeq) return;
      if (menuUnmountTimer != null && root && typeof root.clearTimeout === "function") {
        root.clearTimeout(menuUnmountTimer);
      }
      menuUnmountTimer = null;
      if (menuUnmountTransitionHandler) {
        menu.removeEventListener("transitionend", menuUnmountTransitionHandler);
        menuUnmountTransitionHandler = null;
      }
      picker.classList.remove("menu-mounted");
      resetMenuLayout();
    }

    function shouldAnimateMenuClose() {
      if (!root || typeof root.getComputedStyle !== "function") return false;
      if (typeof root.matchMedia === "function"
          && root.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
      return true;
    }

    function parseCssTimeList(value) {
      return String(value || "").split(",").map((part) => {
        const token = part.trim();
        const amount = Number.parseFloat(token);
        if (!Number.isFinite(amount) || amount < 0) return 0;
        return token.endsWith("ms") ? amount : amount * 1000;
      });
    }

    function getMenuCloseFallbackMs() {
      try {
        const style = root.getComputedStyle(menu);
        const durations = parseCssTimeList(style && style.transitionDuration);
        const delays = parseCssTimeList(style && style.transitionDelay);
        const itemCount = Math.max(durations.length, delays.length);
        let longestTransitionMs = 0;
        for (let index = 0; index < itemCount; index += 1) {
          const duration = durations.length > 0 ? durations[index % durations.length] : 0;
          const delay = delays.length > 0 ? delays[index % delays.length] : 0;
          longestTransitionMs = Math.max(longestTransitionMs, duration + delay);
        }
        return Math.max(
          MENU_CLOSE_FALLBACK_MIN_MS,
          Math.ceil(longestTransitionMs + MENU_CLOSE_SAFETY_MS),
        );
      } catch (_) {
        return MENU_CLOSE_FALLBACK_MIN_MS;
      }
    }

    function mountMenu() {
      cancelMenuUnmount();
      resetMenuLayout();
      picker.classList.add("menu-mounted");
    }

    function scheduleMenuUnmount() {
      cancelMenuUnmount();
      const expectedSeq = menuLifecycleSeq;
      if (!shouldAnimateMenuClose() || !root || typeof root.setTimeout !== "function") {
        finalizeMenuUnmount(expectedSeq);
        return;
      }
      menuUnmountTransitionHandler = (event) => {
        if (!event || event.target !== menu || event.propertyName !== "opacity") return;
        finalizeMenuUnmount(expectedSeq);
      };
      menu.addEventListener("transitionend", menuUnmountTransitionHandler);
      menuUnmountTimer = root.setTimeout(() => {
        finalizeMenuUnmount(expectedSeq);
      }, getMenuCloseFallbackMs());
    }

    function reflow() {
      if (disposed) return;
      if (!usesViewportPlacement) ensureVisible();
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
      const nextOpen = !!next && optionElements.length > 0 && !isInteractionLocked();
      if (nextOpen) {
        isOpen = true;
        attachScrollBoundary();
        mountMenu();
        positionMenu();
        // positionMenu reads layout after the menu is mounted, so the browser
        // has a hidden starting frame before the visible transition begins.
        picker.classList.add("open");
      } else {
        isOpen = false;
        detachScrollBoundary();
        picker.classList.remove("open");
        scheduleMenuUnmount();
      }
      trigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
      menu.setAttribute("aria-hidden", isOpen ? "false" : "true");
      paintValue(activeValue);
      if (isOpen) {
        const selected = findOption(activeValue);
        focusOption(selected && selected.element);
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
      if (!pending) {
        const focusTarget = pendingFocusTarget;
        pendingFocusTarget = null;
        restoreFocusIfLost(focusTarget);
      }
    }

    function choose(value) {
      if (disposed || isInteractionLocked()) return;
      const entry = findOption(value);
      if (!entry) return;
      if (entry.data.value === activeValue) {
        setOpen(false, { focusTrigger: true });
        return;
      }

      const previous = committedValue;
      paintValue(entry.data.value);
      setOpen(false, { focusTrigger: true });
      pendingFocusTarget = trigger;
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
      focusOption(optionElements[nextIndex].element);
    }

    trigger.addEventListener("click", () => setOpen(!isOpen));
    trigger.addEventListener("keydown", (event) => {
      if (isInteractionLocked()) return;
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
        focusOption(target && target.element);
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
          focusOption(target && target.element);
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
    function closeOnBoundaryScroll() {
      if (!isOpen) return;
      const active = document.activeElement;
      const shouldRestoreFocus = active
        && typeof menu.contains === "function"
        && menu.contains(active);
      setOpen(false, { focusTrigger: shouldRestoreFocus });
    }
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
        pending = false;
        paintInteractivity();
        const focusTarget = pendingFocusTarget;
        pendingFocusTarget = null;
        restoreFocusIfLost(focusTarget);
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
        cancelMenuUnmount();
        detachScrollBoundary();
        isOpen = false;
        picker.classList.remove("open");
        picker.classList.remove("menu-mounted");
        resetMenuLayout();
        disposed = true;
        pendingFocusTarget = null;
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
