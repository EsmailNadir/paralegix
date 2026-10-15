import { render, screen, fireEvent } from '@testing-library/react';
import PasswordInput from '@/components/ui/PasswordInput';

/**
 * The seven auth password fields each spelled this out. Two behaviours differed
 * between the copies and both have to survive the merge: the login toggle is
 * reachable by Tab, and the register and invite toggles are not.
 */
describe('PasswordInput', () => {
  const renderField = (props: Partial<React.ComponentProps<typeof PasswordInput>> = {}) =>
    render(
      <PasswordInput
        id="password"
        name="password"
        value="hunter2"
        onChange={jest.fn()}
        placeholder="Enter your password"
        {...props}
      />,
    );

  it('hides the value until the toggle is pressed, and hides it again', () => {
    renderField();

    const field = screen.getByPlaceholderText('Enter your password');
    expect(field).toHaveAttribute('type', 'password');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);
    expect(field).toHaveAttribute('type', 'text');

    const pressed = screen.getByRole('button', { name: 'Hide password' });
    expect(pressed).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(pressed);
    expect(field).toHaveAttribute('type', 'password');
  });

  it('keeps the toggle in the tab order by default, as the login form has it', () => {
    renderField();
    expect(screen.getByRole('button', { name: 'Show password' })).not.toHaveAttribute('tabindex');
  });

  it('skips the toggle when the caller asks, as the register forms do', () => {
    renderField({ toggleTabIndex: -1 });
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('tabindex', '-1');
  });

  it('passes the error wiring through, which only the login field sets', () => {
    renderField({ 'aria-invalid': true, 'aria-describedby': 'login-error' });

    const field = screen.getByPlaceholderText('Enter your password');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', 'login-error');
  });

  it('reports what the user types', () => {
    const handleChange = jest.fn();
    renderField({ onChange: handleChange });

    fireEvent.change(screen.getByPlaceholderText('Enter your password'), {
      target: { value: 'correct horse' },
    });
    expect(handleChange).toHaveBeenCalled();
  });
});
