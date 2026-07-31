/**
 * 抽屉（F-012/F-013/F-014）。<1100px 时右抽屉复用 `EvidencePanelContent`，
 * <768px 时左抽屉复用 `SessionListContent`——本组件只负责容器：定位、遮罩、
 * 动画、响应式隐藏、Esc 关闭、焦点管理与焦点陷阱，不关心里面渲染什么
 * （design.md 模块 4）。
 *
 * 规格：0 圆角（全局样式已强制）、`transition 200ms ease-out`、
 * 遮罩 `rgba(36,49,66,0.4)`（= `#243142` 40%，取自 `text-primary` 色值）。
 *
 * Codex Review P2 修复（共 4 处，累计两轮）：
 * 1. 视口变宽越过抽屉对应的桌面断点时必须隐藏——断点与对应侧栏/触发按钮互补：
 *    右抽屉 `min-[1100px]:hidden`，左抽屉 `md:hidden`。
 * 2. 关闭时不能立刻卸载——`isClosing` 在 render 阶段同步派生（不放进
 *    useEffect，避免晚一整个 render 才响应，导致退场动画根本没机会开始），
 *    退场动画播完（`ANIMATION_MS`）才真正卸载；`role="dialog"` 仍随 `open`
 *    立刻摘除，可访问性优先于动画。
 * 3. 打开时也要有真实的过渡：`entered` 初始为 false（挂载即渲染"收起"位置），
 *    下一个宏任务才翻到 true（渲染"展开"位置）——浏览器在这两次样式重算之间
 *    真正执行 200ms 的 transform 过渡，而不是直接以最终态出现。收起则同步
 *    （在 render 阶段随 `isClosing` 一起置 false），不需要等下一轮。
 * 4. `aria-modal="true"` 必须配焦点陷阱：Tab/Shift+Tab 不能把焦点带出面板，
 *    否则键盘用户会操作到视觉上被遮罩盖住的背景内容。
 * 5. 焦点陷阱只解决了"面板可见时不让焦点跑出去"，但如果抽屉在窄屏打开后，
 *    视口被拉宽越过桌面断点，`hideAtDesktopClass` 只是视觉上把它藏起来——
 *    `open` 依然是 true，文档级 Tab 监听依然在把焦点困在一个已经被 CSS
 *    隐藏、用户根本看不见的面板里，桌面版常驻侧栏反而键盘不可达。用
 *    `matchMedia` 监听同一个断点，一旦越过就调用 `onClose()`，从根源上
 *    让"视觉隐藏"与"是否还持有焦点陷阱"保持一致（Codex Review P2）。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

const ANIMATION_MS = 200;

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side: "left" | "right";
  /** 抽屉面板背景色，与被复用内容原本所在栏位一致（F-014："背景同原栏位"） */
  bgClassName: string;
  widthClassName: string;
  children: ReactNode;
}

export function Drawer({ open, onClose, side, bgClassName, widthClassName, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  // 用 ref 存最新的 onClose——见下方 focus effect 的依赖数组说明。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // isClosing/entered 都在 render 阶段同步派生（React 官方認可的"根据 prop
  // 变化调整 state"模式），不放进 useEffect——effect 要等 commit 之后才跑，
  // 会比 prop 变化晚一整个 render。
  const [isClosing, setIsClosing] = useState(false);
  const [entered, setEntered] = useState(false);
  const prevOpenRef = useRef(open);
  if (prevOpenRef.current !== open) {
    prevOpenRef.current = open;
    if (!open) {
      // 关闭：立刻同步翻回"收起"位置，退场动画从这一帧就开始播放
      setIsClosing(true);
      setEntered(false);
    }
    // 打开：entered 先维持 false（挂载在"收起"位置），不在这里同步翻真——
    // 那样浏览器只会看到一次样式重算，没有"从收起到展开"这两帧可过渡。
  }

  // 退场动画播完之后才真正卸载。
  useEffect(() => {
    if (!isClosing) return;
    const timeout = setTimeout(() => setIsClosing(false), ANIMATION_MS);
    return () => clearTimeout(timeout);
  }, [isClosing]);

  // 打开时，挂载后的下一个宏任务才把 entered 翻真——留出一帧"收起"位置的
  // 样式重算，CSS transition 才有真实的过渡可以播放（Codex Review P2）。
  useEffect(() => {
    if (!open || entered) return;
    const timeout = setTimeout(() => setEntered(true), 0);
    return () => clearTimeout(timeout);
  }, [open, entered]);

  // 视口越过抽屉对应的桌面断点时自动关闭——否则只是视觉上隐藏，焦点陷阱
  // 依然困住一个用户看不见的面板，桌面栏位反而键盘不可达（Codex Review P2）。
  useEffect(() => {
    if (!open || typeof window.matchMedia !== "function") return;
    const query = side === "right" ? "(min-width: 1100px)" : "(min-width: 768px)";
    const mql = window.matchMedia(query);
    const handleChange = () => {
      if (mql.matches) onCloseRef.current();
    };
    handleChange(); // 打开的那一刻视口可能已经在桌面区间，同样要立刻关闭
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [open, side]);

  // 只依赖 `open` 本身——App 里传的是内联箭头函数，每次父组件重渲染（哪怕跟抽屉
  // 毫无关系，比如聊天流式更新）都会拿到新的函数引用；如果放进依赖数组，每次
  // 无关重渲染都会导致这个 effect 清理再重跑，重新执行时 document.activeElement
  // 已经是抽屉面板本身，previouslyFocusedRef 就会被错误覆写成"抽屉自己"。
  useEffect(() => {
    if (!open) return;

    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      // 焦点陷阱：aria-modal="true" 意味着 Tab/Shift+Tab 不该把焦点带到
      // 视觉上被遮罩盖住的背景内容里（Codex Review P2）。
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (!panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // 关闭后焦点归还触发按钮，不留给浏览器默认落到 <body>（可访问性要求）
      previouslyFocusedRef.current?.focus();
    };
  }, [open]);

  const shouldRender = open || isClosing;
  if (!shouldRender) return null;

  const isRight = side === "right";
  // 与触发按钮、对应桌面侧栏互补的断点：右抽屉/右栏用 min-[1100px]，左抽屉/
  // 左栏用 md——越过这个宽度桌面栏位本就常驻显示，抽屉必须隐藏。
  const hideAtDesktopClass = isRight ? "min-[1100px]:hidden" : "md:hidden";
  const translateClass = entered ? "translate-x-0" : isRight ? "translate-x-full" : "-translate-x-full";

  return (
    <div className={`fixed inset-0 z-[60] ${hideAtDesktopClass}`}>
      <div
        className={`absolute inset-0 bg-[rgba(36,49,66,0.4)] transition-opacity duration-200 ease-out
                   ${entered ? "opacity-100" : "opacity-0"}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role={open ? "dialog" : undefined}
        aria-modal={open || undefined}
        tabIndex={-1}
        className={`absolute top-0 ${isRight ? "right-0" : "left-0"} h-full ${widthClassName} ${bgClassName}
                   flex flex-col overflow-y-auto no-scrollbar
                   transition-transform duration-200 ease-out focus:outline-none ${translateClass}`}
      >
        {children}
      </div>
    </div>
  );
}
