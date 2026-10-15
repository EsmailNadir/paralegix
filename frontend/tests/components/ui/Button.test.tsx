import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import Button from '@/components/ui/Button';

describe('Button', () => {
  /**
   * Byte-exact, because `secondary` absorbed the `outline` variant. The two
   * rendered identical class strings, so the merge was a rename; if this string
   * drifts, 114 buttons that used to say `outline` changed appearance. The edge
   * is `border-control-border`, not `border-outline`: a button's boundary is the
   * only thing marking where it begins, so it owes 3:1 where a divider does not.
   */
  it('renders the exact secondary class string the outline variant also rendered', () => {
    render(<Button type="secondary">Cancel</Button>);
    expect(screen.getByRole('button', { name: 'Cancel' }).className).toContain(
      'bg-surface text-on-surface border border-control-border hover:bg-surface-hover focus-visible:ring-focus-ring',
    );
  });

  it('renders children with default htmlType="button"', () => {
    render(<Button>Click me</Button>);

    const btn = screen.getByRole('button', { name: 'Click me' });
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute('type', 'button');
  });

  it('supports custom htmlType="submit"', () => {
    render(<Button htmlType="submit">Submit Form</Button>);

    const btn = screen.getByRole('button', { name: 'Submit Form' });
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('calls onClick when clicked', () => {
    const handleClick = jest.fn();

    render(<Button onClick={handleClick}>Action</Button>);

    fireEvent.click(screen.getByRole('button', { name: 'Action' }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('disables the button and does not fire onClick when disabled is true', () => {
    const handleClick = jest.fn();

    render(<Button disabled={true} onClick={handleClick}>Disabled Action</Button>);

    const btn = screen.getByRole('button', { name: 'Disabled Action' });
    expect(btn).toBeDisabled();

    fireEvent.click(btn);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('shows loading state, disables button, and suppresses icon while loading', () => {
    const handleClick = jest.fn();

    render(
      <Button
        loading={true}
        onClick={handleClick}
        icon={<span data-testid="test-icon">icon</span>}
      >
        Save Changes
      </Button>
    );

    const btn = screen.getByRole('button', { name: /Save Changes/ });
    expect(btn).toBeDisabled();
    expect(screen.queryByTestId('test-icon')).not.toBeInTheDocument();

    fireEvent.click(btn);
    expect(handleClick).not.toHaveBeenCalled();
  });

  it('renders icon when not loading', () => {
    render(
      <Button
        loading={false}
        icon={<span data-testid="test-icon">icon</span>}
      >
        Export
      </Button>
    );

    expect(screen.getByTestId('test-icon')).toBeInTheDocument();
  });

  /**
   * The compact size is the page / panel header action. It replaced hand-copied
   * class strings at a dozen call sites, so its metrics are pinned exactly.
   */
  it('renders the header action metrics at size="compact"', () => {
    render(<Button size="compact">New form</Button>);
    const cls = screen.getByRole('button', { name: 'New form' }).className;
    expect(cls).toContain('shrink-0 gap-1.5 px-3.5 py-2 text-xs rounded-xl');
    expect(cls).toContain('bg-accent-solid text-accent-foreground');
    expect(cls).not.toContain('rounded-md');
  });

  it('keeps the rounded-md edge on the form sizes', () => {
    render(<Button size="small">Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' }).className).toContain('px-3 py-1.5 text-xs rounded-md');
  });

  it('passes other native attributes through, so a Tooltip can attach its handlers', () => {
    const onMouseEnter = jest.fn();
    render(
      <Button onMouseEnter={onMouseEnter} data-testid="wrapped">
        Share
      </Button>,
    );
    const btn = screen.getByTestId('wrapped');
    fireEvent.mouseEnter(btn);
    expect(onMouseEnter).toHaveBeenCalledTimes(1);
  });
});


it('exposes the native button through a ref for focus restoration', () => {
  const buttonRef = React.createRef<HTMLButtonElement>();
  render(<Button ref={buttonRef}>Edit</Button>);
  expect(buttonRef.current).toBe(screen.getByRole('button', { name: 'Edit' }));
  buttonRef.current!.focus();
  expect(screen.getByRole('button', { name: 'Edit' })).toHaveFocus();
});
