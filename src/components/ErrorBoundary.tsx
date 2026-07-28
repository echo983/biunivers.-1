import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("An internal application crashed", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="window-error" role="alert">
          此应用出现错误。请关闭窗口后重试。
        </div>
      );
    }

    return this.props.children;
  }
}
