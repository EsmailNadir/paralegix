import { render, screen, fireEvent } from '@testing-library/react';
import Avatar from '@/components/ui/Avatar';

describe('Avatar', () => {
  it('renders initials when no photoUrl is provided', () => {
    render(<Avatar name="John Watson" email="watson@bakerstreet.test" />);

    const fallback = screen.getByLabelText('John Watson');
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent('JW');
  });

  it('renders image element when photoUrl is given', () => {
    render(
      <Avatar
        name="Sherlock Holmes"
        photoUrl="https://example.com/avatar.jpg"
      />,
    );

    const img = screen.getByRole('img', { name: 'Sherlock Holmes' });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', 'https://example.com/avatar.jpg');
  });

  it('falls back to initials when image fails to load', () => {
    render(
      <Avatar
        name="Irene Adler"
        photoUrl="https://example.com/broken.jpg"
      />,
    );

    const img = screen.getByRole('img', { name: 'Irene Adler' });
    fireEvent.error(img);

    const fallback = screen.getByLabelText('Irene Adler');
    expect(fallback).toBeInTheDocument();
    expect(fallback).toHaveTextContent('IA');
  });
});
