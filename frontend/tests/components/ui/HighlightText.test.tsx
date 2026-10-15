import { render } from '@testing-library/react';
import { highlightText } from '@/components/ui/HighlightText';

describe('highlightText utility', () => {
  it('returns plain string when text or query is empty', () => {
    expect(highlightText('Sample Text', '')).toBe('Sample Text');
    expect(highlightText('', 'query')).toBe('');
    expect(highlightText(null, 'query')).toBe('');
  });

  it('bolds case-insensitive matches inside text', () => {
    const node = highlightText('John Doe Smith', 'doe');
    const { container } = render(<div>{node}</div>);

    const strongEl = container.querySelector('strong');
    expect(strongEl).toBeInTheDocument();
    expect(strongEl?.textContent).toBe('Doe');
  });

  it('escapes regex metacharacters properly', () => {
    const node = highlightText('Formula (a+b)*c result', '(a+b)');
    const { container } = render(<div>{node}</div>);

    const strongEl = container.querySelector('strong');
    expect(strongEl).toBeInTheDocument();
    expect(strongEl?.textContent).toBe('(a+b)');
  });
});
