import { render, screen } from '@testing-library/react';
import ContactCategoryBadge from '@/components/ui/ContactCategoryBadge';
import { CONTACT_CATEGORY_META } from '@/constants/statusMeta';

/**
 * The badge that says what a contact IS.
 *
 * Its whole job is to turn a stored category value into the one label and colour
 * the product uses for it everywhere. Two things can go wrong and neither looks
 * broken on screen: an unrecognised value can render as itself (leaking a raw
 * `guardian_ad_litem` into the UI), and `children` can lose the colour that says
 * what the person is.
 *
 * The labels are read from `CONTACT_CATEGORY_META` rather than retyped, so this
 * file cannot drift from the vocabulary the rest of the app renders.
 */
describe('ContactCategoryBadge', () => {
  it('renders the label for a known category', () => {
    render(<ContactCategoryBadge category="expert" />);

    expect(screen.getByText(CONTACT_CATEGORY_META.expert.label)).toBeInTheDocument();
  });

  it('renders the right label for every category the backend allows', () => {
    // The values are the `contacts_category_check` set. One test per category is
    // not worth writing, but a category that renders as "Other" because it was
    // never added to the map is exactly the silent failure this catches.
    const categories = [
      'opposing_counsel', 'opposing_party', 'co_counsel', 'judge', 'witness',
      'expert', 'adjuster', 'court_clerk', 'mediator', 'guardian_ad_litem',
      'court_reporter', 'vendor', 'other',
    ];

    for (const category of categories) {
      const { unmount } = render(<ContactCategoryBadge category={category} />);
      expect(screen.getByText(CONTACT_CATEGORY_META[category].label)).toBeInTheDocument();
      unmount();
    }
  });

  it('falls back to Other for a null category', () => {
    render(<ContactCategoryBadge category={null} />);

    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('falls back to Other for a value it does not know, rather than showing it raw', () => {
    render(<ContactCategoryBadge category="not_a_real_category" />);

    // The failure this prevents is a stored value reaching the screen verbatim,
    // which is how `guardian_ad_litem` ends up in front of a client.
    expect(screen.queryByText('not_a_real_category')).not.toBeInTheDocument();
    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('lets children replace the word while keeping the category colour', () => {
    const { container } = render(
      <ContactCategoryBadge category="judge">Hon. Jane Smith</ContactCategoryBadge>,
    );

    expect(screen.getByText('Hon. Jane Smith')).toBeInTheDocument();
    expect(screen.queryByText('Judge')).not.toBeInTheDocument();
    // The colour is the point of passing children: an attendee list names the
    // PERSON and colours them by what they are. Compared against the plain badge
    // rather than asserted as a literal class, so a palette change cannot break
    // this without changing the meaning.
    const withChildren = container.firstElementChild?.className;
    const { container: plain } = render(<ContactCategoryBadge category="judge" />);
    expect(withChildren).toBe(plain.firstElementChild?.className);
  });

  it('applies an extra className alongside its own', () => {
    const { container } = render(
      <ContactCategoryBadge category="witness" className="ml-2" />,
    );

    expect(container.firstElementChild?.className).toContain('ml-2');
  });
});
