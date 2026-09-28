import { Component, type ReactNode } from 'react';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * 页面级兜底：任何渲染异常（包括存量脏数据）只显示错误页，
 * 不能让整个应用白屏且无法恢复。
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: unknown): void {
    console.error('[ErrorBoundary] 页面渲染失败', error, info);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <main className="page-content">
          <h2>页面出错了</h2>
          <p role="alert">页面渲染时发生错误，请返回首页重试；若反复出现，请联系维护人员。</p>
          <p>
            <button type="button" onClick={() => { this.setState({ error: null }); window.location.hash = '#home'; }}>
              返回首页
            </button>{' '}
            <button type="button" onClick={() => window.location.reload()}>
              刷新重试
            </button>
          </p>
        </main>
      );
    }
    return this.props.children;
  }
}
