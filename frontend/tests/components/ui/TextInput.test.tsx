import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TextInput from '@/components/ui/TextInput';
import Textarea from '@/components/ui/Textarea';
import { FULL_INPUT_CLS, INPUT_CLS } from '@/components/ui/inputClasses';

/**
 * Byte-exact assertions, for the same reason as FieldLabel's.
 *
 * `TextInput` and `Textarea` replaced 66 inline `className` strings whose whole
 * point was that nothing on screen moved. The literal below is the string those
 * sites rendered, copied out of the pre-migration codebase. It is written in a
 * different order there than in `FULL_INPUT_CLS`; Tailwind resolves the cascade
 * from the generated stylesheet rather than from the attribute, so the two render
 * identically, and the class-SET assertion below is what actually pins that.
 */
const PRE_MIGRATION_CLS =
  'w-full rounded-md border border-input-border bg-input-bg text-on-surface '
  + 'placeholder:text-on-surface-muted px-3 py-2 text-sm focus:outline-none '
  + 'focus-visible:ring-2 focus-visible:ring-focus-ring';

describe('TextInput', () => {
  it('renders exactly the classes the 63 inline sites rendered', () => {
    render(<TextInput aria-label="Amount" />);
    const input = screen.getByLabelText('Amount');
    expect(input.className).toBe(FULL_INPUT_CLS);
    expect(input.className.split(' ').sort()).toEqual(PRE_MIGRATION_CLS.split(' ').sort());
  });

  it('stays a superset of INPUT_CLS, so it lines up with a Dropdown trigger beside it', () => {
    // The shared metrics are px-3 py-2 text-sm. If FULL_INPUT_CLS ever stops
    // containing INPUT_CLS, inputs and dropdowns in one filter row fall out of
    // alignment, which is exactly the drift these constants exist to prevent.
    render(<TextInput aria-label="Search" />);
    const rendered = new Set(screen.getByLabelText('Search').className.split(' '));
    INPUT_CLS.split(' ').forEach((cls) => expect(rendered.has(cls)).toBe(true));
  });

  it('renders a bare input with no wrapper element', () => {
    const { container } = render(<TextInput aria-label="Name" />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('INPUT');
  });

  it('appends className after the base classes rather than replacing them', () => {
    render(<TextInput aria-label="Code" className="uppercase" />);
    expect(screen.getByLabelText('Code').className).toBe(`${FULL_INPUT_CLS} uppercase`);
  });

  it('forwards native input props', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<TextInput id="matter" type="text" placeholder="Matter name" maxLength={5} onChange={onChange} />);
    const input = screen.getByPlaceholderText('Matter name');
    expect(input).toHaveAttribute('id', 'matter');
    expect(input).toHaveAttribute('maxlength', '5');
    await user.type(input, 'ab');
    expect(onChange).toHaveBeenCalled();
  });

  it('forwards ref, which three migrated call sites rely on for focus', () => {
    const ref = createRef<HTMLInputElement>();
    render(<TextInput ref={ref} aria-label="Focus target" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });
});

describe('Textarea', () => {
  it('renders the same control metrics as TextInput', () => {
    render(<Textarea aria-label="Notes" />);
    expect(screen.getByLabelText('Notes').className).toBe(FULL_INPUT_CLS);
  });

  it('renders a bare textarea and forwards rows', () => {
    const { container } = render(<Textarea aria-label="Notes" rows={4} />);
    expect(container.children).toHaveLength(1);
    expect(container.firstElementChild?.tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Notes')).toHaveAttribute('rows', '4');
  });

  it('appends className, which the migrated sites use for resize-none', () => {
    render(<Textarea aria-label="Notes" className="resize-none" />);
    expect(screen.getByLabelText('Notes').className).toBe(`${FULL_INPUT_CLS} resize-none`);
  });
});
