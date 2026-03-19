// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent.js';

describe('MarkdownContent', () => {
  it('renders headings, emphasis, lists, and inline code', () => {
    render(
      <MarkdownContent
        content={'## 标题\n\n- **第一项**\n- 第二项包含 `code`\n\n访问 [OpenClaw](https://example.com)'}
      />,
    );

    expect(screen.getByText('标题')).toBeInTheDocument();
    expect(screen.getByText('第一项').tagName).toBe('STRONG');
    expect(screen.getByText(/第二项包含/)).toBeInTheDocument();
    expect(screen.getByText('code').tagName).toBe('CODE');
    expect(screen.getByRole('link', { name: 'OpenClaw' })).toHaveAttribute('href', 'https://example.com');
  });
});
