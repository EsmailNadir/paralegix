import { render, screen } from '@testing-library/react';
import DuplicateNameWarning from '@/components/ui/DuplicateNameWarning';

describe('DuplicateNameWarning', () => {
  it('renders nothing when duplicateName is empty or null', () => {
    const { container } = render(
      <DuplicateNameWarning duplicateName={null} entityLabel="matter" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders polite advisory warning with entity label and name', () => {
    render(
      <DuplicateNameWarning
        duplicateName="Smith Contract"
        entityLabel="matter"
      />,
    );

    const status = screen.getByRole('status');
    expect(status).toBeInTheDocument();
    expect(status).toHaveTextContent('A matter named “Smith Contract” already exists. You can still continue.');
  });
});
