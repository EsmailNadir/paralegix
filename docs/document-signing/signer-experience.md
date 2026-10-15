# Signer Experience

This page describes what happens from the signer's perspective after a document is sent for signing.

## Receiving the Request

The signer receives an email with a secure link. The link is unique to them and expires or becomes invalid once the session is completed or cancelled.

For **portal delivery**, the signer can also access the document directly from their Paralegix client portal.

## Security Gates

If the sending attorney configured security on the document, the signer will be prompted before they can view it.

### Access Code
The signer must enter a code provided to them by the attorney (shared separately, e.g. by phone). This prevents anyone who intercepts the email from opening the document.

## Signing the Document

The document opens as one continuous scroll. Every page is stacked top to bottom, so the signer scrolls through the document the way they would read any other PDF rather than stepping page by page.

Depending on how the attorney set up the document, the signer will see one of two views:

### Guided Signing (Designated Fields)
The signer only sees and interacts with the fields placed by the attorney. A progress indicator shows how many required fields remain.

For each field:
- **Signature / Initials**: Opens a drawing pad to sign with mouse, finger, or stylus
- **Date**: Opens a date picker
- **Text**: Free-form text input
- **Checkbox**: Toggle on/off

Once all required fields are complete, the **Submit** button becomes active.

### Full Editor
For documents sent without pre-placed fields, the signer can add annotations anywhere (signatures, text, or checkboxes) using the annotation toolbar.

## Submitting

After completing all fields, the signer clicks **Submit**. They may be asked to:

- Confirm their consent (checkbox + typed name)

Once submitted:
- The signer's values are stamped onto the PDF
- The attorney is notified
- If the session is **sequential**, the next signer receives their link
- If the session is **parallel** and everyone has signed, the session is marked complete and the attorney receives the final document

## Sequential Waiting

If a signer is not yet the active signer in a sequential session, they'll see a waiting screen when they open their link. They'll receive a follow-up email once it's their turn.

## After Signing

The signer sees a confirmation screen. The attorney receives:

- An email confirmation
- The completed signed document
- A **signing certificate** with an audit log of who signed, when, and from where
