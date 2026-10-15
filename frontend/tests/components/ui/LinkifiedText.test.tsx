/**
 * `LinkifiedText`: free text (event notes, a meeting location, a chat message)
 * with its URLs turned into links, built from React nodes rather than HTML.
 *
 * The rule that matters is the scheme allow-list. Event notes come from Google
 * and Outlook as well as from the firm, so the text is not ours: a
 * `javascript:` URL rendered as a live link runs in the viewer's session the
 * moment someone clicks it.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import LinkifiedText from '@/components/ui/LinkifiedText';

function linksIn(container: HTMLElement) {
  return Array.from(container.querySelectorAll('a'));
}

it('links a plain https URL, opening it in a new tab without an opener', () => {
  render(<LinkifiedText text="Join at https://meet.example.com/abc-def today" />);
  const link = screen.getByRole('link', { name: 'https://meet.example.com/abc-def' });
  expect(link).toHaveAttribute('href', 'https://meet.example.com/abc-def');
  expect(link).toHaveAttribute('target', '_blank');
  expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});

it('keeps the text around a link exactly as written', () => {
  const { container } = render(<LinkifiedText text={'Line one\nSee http://example.com for more'} />);
  expect(container.textContent).toBe('Line one\nSee http://example.com for more');
});

it('links mailto and tel URLs', () => {
  render(<LinkifiedText text="Email mailto:clerk@court.gov or call tel:+15551234567" />);
  expect(screen.getByRole('link', { name: 'mailto:clerk@court.gov' })).toHaveAttribute('href', 'mailto:clerk@court.gov');
  expect(screen.getByRole('link', { name: 'tel:+15551234567' })).toHaveAttribute('href', 'tel:+15551234567');
});

it('links bare email and phone addresses without treating dates as phones', () => {
  const { container } = render(<LinkifiedText text="clerk@court.gov, +1 (415) 555-0123 and +15551234567 on 2026-10-05" />);
  expect(screen.getByRole('link', { name: 'clerk@court.gov' })).toHaveAttribute('href', 'mailto:clerk@court.gov');
  expect(screen.getByRole('link', { name: '+1 (415) 555-0123' })).toHaveAttribute('href', 'tel:+14155550123');
  expect(screen.getByRole('link', { name: '+15551234567' })).toHaveAttribute('href', 'tel:+15551234567');
  expect(linksIn(container)).toHaveLength(3);
  expect(container.textContent).toContain('2026-10-05');
});

it('never links a javascript: URL, bare or inside a markdown link', () => {
  const { container } = render(
    <LinkifiedText text="javascript:alert(1) and [click me](javascript:alert(2))" />,
  );
  expect(linksIn(container)).toHaveLength(0);
  expect(container.textContent).toBe('javascript:alert(1) and [click me](javascript:alert(2))');
});

it('does not link a data: or vbscript: URL', () => {
  const { container } = render(<LinkifiedText text="data:text/html,hi vbscript:msgbox" />);
  expect(linksIn(container)).toHaveLength(0);
});

it('renders a markdown link as its label pointing at its URL', () => {
  render(<LinkifiedText text="Agenda: [the docket](https://court.example.gov/docket/12)" />);
  expect(screen.getByRole('link', { name: 'the docket' })).toHaveAttribute('href', 'https://court.example.gov/docket/12');
});

it('leaves sentence punctuation after a URL out of the link', () => {
  render(<LinkifiedText text="Details at https://example.com/a. Then (see https://example.com/b)." />);
  expect(screen.getByRole('link', { name: 'https://example.com/a' })).toHaveAttribute('href', 'https://example.com/a');
  expect(screen.getByRole('link', { name: 'https://example.com/b' })).toHaveAttribute('href', 'https://example.com/b');
});

it('keeps a closing parenthesis that belongs to the URL', () => {
  render(<LinkifiedText text="https://en.wikipedia.org/wiki/Bail_(law)" />);
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://en.wikipedia.org/wiki/Bail_(law)');
});

it('renders plain text untouched when there is no URL', () => {
  const { container } = render(<LinkifiedText text="Courtroom 4B, bring exhibits" />);
  expect(linksIn(container)).toHaveLength(0);
  expect(container.textContent).toBe('Courtroom 4B, bring exhibits');
});

it('applies the caller link class', () => {
  render(<LinkifiedText text="https://example.com" linkClassName="custom-link" />);
  expect(screen.getByRole('link')).toHaveClass('custom-link');
});
