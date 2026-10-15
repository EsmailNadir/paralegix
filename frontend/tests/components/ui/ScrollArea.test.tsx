import React from 'react';
import { render } from '@testing-library/react';
import ScrollArea from '@/components/ui/ScrollArea';

describe('ScrollArea', () => {
  beforeEach(() => {
    // Match fine pointer query so custom scrollbars mount
    window.matchMedia = jest.fn().mockImplementation((query) => ({
      matches: query.includes('pointer: fine'),
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }));
  });

  it('hides both tracks and thumbs when content fits without overflowing', () => {
    const { container } = render(
      <ScrollArea className="w-[400px] h-[300px]">
        <div style={{ width: '200px', height: '100px' }}>Short content</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector('.overflow-auto');
    expect(viewport).not.toBeNull();

    // Verify track containers start hidden
    const tracks = container.querySelectorAll('[aria-hidden="true"]');
    expect(tracks.length).toBe(2);
    tracks.forEach((track) => {
      expect((track as HTMLElement).style.opacity).toBe('0');
      expect((track as HTMLElement).style.pointerEvents).toBe('none');
    });
  });

  it('renders viewport with overflow-auto so platform scrollbars do not lock open', () => {
    const { container } = render(
      <ScrollArea>
        <div>Content</div>
      </ScrollArea>,
    );

    const viewport = container.querySelector('.overflow-auto');
    expect(viewport).not.toBeNull();
    expect(viewport?.className).toContain('overflow-auto');
    expect(viewport?.className).not.toContain('overflow-scroll');
  });
});
