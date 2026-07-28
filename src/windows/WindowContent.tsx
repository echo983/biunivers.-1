import type { AppDefinition } from "../types/desktop";
import { AppRenderer } from "../apps/AppRenderer";
import { ErrorBoundary } from "../components/ErrorBoundary";

interface WindowContentProps {
  app: AppDefinition;
}

export function WindowContent({ app }: WindowContentProps) {
  return (
    <ErrorBoundary>
      <div className="app-window-root__content">
        <AppRenderer app={app} />
      </div>
    </ErrorBoundary>
  );
}
