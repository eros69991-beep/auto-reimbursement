import { Component, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** 「返回」按钮去哪个地址、叫什么：店内是首页；公账区没有首页，回到「上传回单」 */
  home?: { hash: string; name: string };
  /**
   * 页面地址一变（这个值变了），就放掉出错页、重新渲染子页面。
   * 不然出的是「一渲染就崩」的页面时，点「返回」只是把地址改了，出错页还占着，人回不去。
   */
  resetKey?: string;
};
type State = { error: Error | null };

const STORE_HOME = { hash: '#home', name: '首页' };

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

  override componentDidUpdate(prevProps: Props, prevState: State): void {
    // prevState.error 为 null 说明这次更新里才出的错（地址变了、新页面一渲染就崩）：
    // 这时再重来一遍还是崩，白白多渲染一次，等下一次地址变化再放手
    if (this.state.error !== null && prevState.error !== null && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      const home = this.props.home ?? STORE_HOME;
      return (
        <main className="page-content">
          <h2>页面出错了</h2>
          <p role="alert">页面渲染时发生错误，请返回{home.name}重试；若反复出现，请联系维护人员。</p>
          <p>
            <button type="button" onClick={() => { this.setState({ error: null }); window.location.hash = home.hash; }}>
              返回{home.name}
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
