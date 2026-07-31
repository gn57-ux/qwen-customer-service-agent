/**
 * 根骨架（需求文档 §4.0）：本 feature 只出空壳占位，具体实现由后续 feature 填充：
 *   - Header（顶栏，fixed + h-16）与 LeftSidebar（左栏会话列表）→ feature 4
 *   - MainChat（中间对话区 + 输入区）→ feature 5
 *   - RightPanel（右侧处理依据）→ feature 6
 * 这里先按最终目标结构占位（含 mt-16 为 fixed 顶栏预留空间、断点显隐类），
 * 后续 feature 直接把占位元素替换成对应组件即可，不需要改这层骨架。
 */
import { ClientProvider } from "./client-context.tsx";

export function App() {
  return (
    <ClientProvider>
      <div className="bg-page-bg font-body-md text-text-primary antialiased h-screen flex flex-col overflow-hidden">
        {/* TODO(feature 4): <Header /> —— fixed top-0 w-full z-50 h-16 */}
        <div className="flex-1 mt-16 flex overflow-hidden w-full max-w-[1920px] mx-auto">
          {/* TODO(feature 4): <LeftSidebar /> */}
          <aside className="hidden md:flex w-[220px] flex-shrink-0" />
          {/* TODO(feature 5): <MainChat /> */}
          <main className="flex-1 min-w-0" />
          {/* TODO(feature 6): <RightPanel /> */}
          <aside className="hidden min-[1100px]:flex w-[300px] xl:w-[320px] flex-shrink-0" />
        </div>
      </div>
    </ClientProvider>
  );
}
