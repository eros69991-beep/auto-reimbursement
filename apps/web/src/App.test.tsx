import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from './App';

describe('App', () => {
  it('shows the automatic reimbursement assistant title', () => {
    render(<App />);

    expect(
      screen.getByRole('heading', { name: 'Automatic Reimbursement Assistant' })
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '首页' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '上传凭证' })).toBeInTheDocument();
  });
});
