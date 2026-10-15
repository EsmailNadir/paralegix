import { render, screen, fireEvent } from '@testing-library/react';
import AdminAccessRequired from '@/components/adminComp/AdminAccessRequired';

/**
 * Eight admin pages carried this screen. Seven said the same thing and one, the
 * firm detail page, said less. The short wording is the reason `description` is
 * a prop rather than fixed text, so it is what this pins.
 */
describe('AdminAccessRequired', () => {
  it('names the setting that grants access, which seven pages rely on', () => {
    render(<AdminAccessRequired onBack={jest.fn()} />);

    expect(screen.getByText('Admin Access Required')).toBeInTheDocument();
    expect(screen.getByText(/Ask an existing admin to set/)).toBeInTheDocument();
    expect(screen.getByText('isAdmin: true')).toBeInTheDocument();
  });

  it('says only that access is missing when the caller overrides it', () => {
    render(
      <AdminAccessRequired
        description="Your account does not have admin access."
        onBack={jest.fn()}
      />,
    );

    expect(screen.getByText('Your account does not have admin access.')).toBeInTheDocument();
    expect(screen.queryByText('isAdmin: true')).not.toBeInTheDocument();
  });

  it('leaves the way back to the caller, since the pages navigate differently', () => {
    const handleBack = jest.fn();
    render(<AdminAccessRequired onBack={handleBack} />);

    fireEvent.click(screen.getByRole('button', { name: 'Back to Dashboard' }));
    expect(handleBack).toHaveBeenCalledTimes(1);
  });
});
