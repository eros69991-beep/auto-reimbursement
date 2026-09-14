import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('shows the automatic reimbursement assistant title', () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'Automatic Reimbursement Assistant' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上传凭证' })).toBeInTheDocument();
  });

  it('opens a batch preview from its hash route', () => {
    window.location.hash = '#batches/batch-1/preview';
    render(<App />);
    expect(screen.getByRole('heading', { name: '生成预览' })).toBeInTheDocument();
  });
});
