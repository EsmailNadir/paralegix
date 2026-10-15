/**
 * Tooltip: how the label reaches assistive technology. An icon-only control has
 * no name of its own, so the tooltip names it. A control that already shows text
 * is named by that text, and the tooltip only describes it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import Tooltip from '@/components/ui/Tooltip';

function TrashIcon() {
  return <svg aria-hidden="true" data-testid="icon" />;
}

describe('an icon-only control', () => {
  it('is named by the tooltip text', () => {
    render(
      <Tooltip title="Delete invoice">
        <button type="button">
          <TrashIcon />
        </button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Delete invoice' })).toBeInTheDocument();
  });

  it('keeps a name the call site already gave it', () => {
    render(
      <Tooltip title="Remove this line from the invoice">
        <button type="button" aria-label="Remove line">
          <TrashIcon />
        </button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Remove line' })).toBeInTheDocument();
  });

  it('treats whitespace-only children as having no text', () => {
    render(
      <Tooltip title="Archive">
        <button type="button">
          {' '}
          <TrashIcon />
        </button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Archive' })).toBeInTheDocument();
  });
});

describe('a control with visible text', () => {
  it('keeps its own text as its name', () => {
    render(
      <Tooltip title="View the member roster">
        <button type="button">Globex Corp</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Globex Corp' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View the member roster' })).not.toBeInTheDocument();
  });

  it('finds text nested inside child elements', () => {
    render(
      <Tooltip title="Open matter">
        <button type="button">
          <TrashIcon />
          <span>
            <strong>Smith</strong> v. Jones
          </span>
        </button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: 'Smith v. Jones' })).toBeInTheDocument();
  });

  it('counts a number as visible text', () => {
    render(
      <Tooltip title="Unread messages">
        <button type="button">{3}</button>
      </Tooltip>,
    );

    expect(screen.getByRole('button', { name: '3' })).toBeInTheDocument();
  });

  it('is described by the tooltip while it is open', async () => {
    render(
      <Tooltip title="View the member roster" enterDelay={0}>
        <button type="button">Globex Corp</button>
      </Tooltip>,
    );
    const button = screen.getByRole('button', { name: 'Globex Corp' });

    await userEvent.hover(button);

    expect(await screen.findByRole('tooltip')).toHaveTextContent('View the member roster');
    expect(button).toHaveAccessibleDescription('View the member roster');
  });

  it('adds the tooltip to a description the control already had', async () => {
    render(
      <>
        <p id="hint">Opens in a new tab</p>
        <Tooltip title="View the member roster" enterDelay={0}>
          <button type="button" aria-describedby="hint">
            Globex Corp
          </button>
        </Tooltip>
      </>,
    );
    const button = screen.getByRole('button', { name: 'Globex Corp' });

    await userEvent.hover(button);

    await screen.findByRole('tooltip');
    expect(button).toHaveAccessibleDescription('Opens in a new tab View the member roster');
  });
});
