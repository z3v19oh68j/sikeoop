import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * 抽屉 / 弹层的键盘处理：打开时把焦点放进去，Tab 只在里面转圈，Esc 关闭，
 * 关闭后把焦点还给打开它的那个元素（比如被点开的卡片）。box 元素要带 tabIndex={-1}。
 */
export function useModalFocus(box: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const el = box.current;
    el?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (!el || !el.isConnected) return;
      // 页面被藏起来（弹层不可见）时，不拦任何按键。
      if (el.closest("[hidden]") || el.getClientRects().length === 0) return;
      const at = document.activeElement;
      const inside = el.contains(at);
      const lost = !at || at === document.body;
      // 焦点在别的东西上（比如叠在上面的命令面板）：放行。
      if (!inside && !lost) return;
      if (e.key === "Escape") {
        // 输入法组合中的 Esc 只是取消候选字，不关弹层。
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) { e.preventDefault(); el.focus({ preventScroll: true }); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (!inside || at === el) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
      else if (e.shiftKey && at === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [box]);
}
