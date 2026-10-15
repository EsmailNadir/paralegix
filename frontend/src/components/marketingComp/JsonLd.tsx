/**
 * Renders a `<script type="application/ld+json">` block. Centralized so every
 * page serializes structured data the same way instead of repeating
 * `dangerouslySetInnerHTML` boilerplate.
 */
export default function JsonLd({ data }: { data: object }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
