import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

let broken = true;

function Page(): React.JSX.Element {
  if (broken) throw new Error('页面坏了');
  return <p>页面正常</p>;
}

describe('error page', () => {
  beforeEach(() => {
    broken = true;
    window.location.hash = '#pool';
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    window.location.hash = '';
  });

  it('shows the page as it is when nothing is wrong', () => {
    broken = false;
    render(<ErrorBoundary><Page /></ErrorBoundary>);

    expect(screen.getByText('页面正常')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows an error page instead of a blank screen, and keeps the reason in the console', () => {
    render(<ErrorBoundary><Page /></ErrorBoundary>);

    expect(screen.getByRole('heading', { name: '页面出错了' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('页面渲染时发生错误，请返回首页重试；若反复出现，请联系维护人员。');
    expect(screen.getByRole('button', { name: '刷新重试' })).toBeInTheDocument();
    expect(console.error).toHaveBeenCalledWith('[ErrorBoundary] 页面渲染失败', expect.objectContaining({ message: '页面坏了' }), expect.anything());
  });

  it('leads back to the store home when it is not told otherwise, and shows the page again', () => {
    render(<ErrorBoundary><Page /></ErrorBoundary>);
    broken = false;

    fireEvent.click(screen.getByRole('button', { name: '返回首页' }));

    expect(window.location.hash).toBe('#home');
    expect(screen.getByText('页面正常')).toBeInTheDocument();
  });

  it('leads back to the place it was told to, under the name it was given', () => {
    render(<ErrorBoundary home={{ hash: '#company/upload', name: '上传回单' }}><Page /></ErrorBoundary>);

    expect(screen.getByRole('alert')).toHaveTextContent('请返回上传回单重试');
    expect(screen.queryByRole('button', { name: '返回首页' })).not.toBeInTheDocument();
    broken = false;
    fireEvent.click(screen.getByRole('button', { name: '返回上传回单' }));

    expect(window.location.hash).toBe('#company/upload');
    expect(screen.getByText('页面正常')).toBeInTheDocument();
  });

  // 一渲染就崩的页面：点「返回」时它还在原地，只能等地址真的变了，换上新的那一页
  describe('when the page keeps breaking', () => {
    const reported = (): number => vi.mocked(console.error).mock.calls.filter(([text]) => text === '[ErrorBoundary] 页面渲染失败').length;

    it('stays on the error page after "back" while the address has not moved yet, and gives way when it does', () => {
      const view = render(<ErrorBoundary resetKey="#pool"><Page /></ErrorBoundary>);

      fireEvent.click(screen.getByRole('button', { name: '返回首页' }));

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(window.location.hash).toBe('#home');
      view.rerender(<ErrorBoundary resetKey="#home"><p>首页正常</p></ErrorBoundary>);

      expect(screen.getByText('首页正常')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('gives way to the next page on an address change without anybody pressing a button', () => {
      const view = render(<ErrorBoundary resetKey="#pool"><Page /></ErrorBoundary>);

      view.rerender(<ErrorBoundary resetKey="#history"><p>历史页</p></ErrorBoundary>);

      expect(screen.getByText('历史页')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('does not retry the page while the address stays the same, and does not loop', () => {
      const view = render(<ErrorBoundary resetKey="#pool"><Page /></ErrorBoundary>);
      expect(reported()).toBe(1);

      view.rerender(<ErrorBoundary resetKey="#pool"><Page /></ErrorBoundary>);
      view.rerender(<ErrorBoundary resetKey="#pool"><p>别的内容</p></ErrorBoundary>);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.queryByText('别的内容')).not.toBeInTheDocument();
      expect(reported()).toBe(1);
    });

    it('shows the error page for a new page that breaks the moment it is shown, reporting it once, and recovers on the next move', () => {
      broken = false;
      const view = render(<ErrorBoundary resetKey="#home"><p>首页正常</p></ErrorBoundary>);
      broken = true;

      view.rerender(<ErrorBoundary resetKey="#pool"><Page /></ErrorBoundary>);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(reported()).toBe(1);
      view.rerender(<ErrorBoundary resetKey="#history"><p>历史页</p></ErrorBoundary>);
      expect(screen.getByText('历史页')).toBeInTheDocument();
    });

    it('tries a page that breaks again the next time the address moves, and shows the error page again if it still breaks', () => {
      const view = render(<ErrorBoundary resetKey="#pool"><Page /></ErrorBoundary>);

      view.rerender(<ErrorBoundary resetKey="#pending"><Page /></ErrorBoundary>);

      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(reported()).toBe(2);
    });
  });
});
