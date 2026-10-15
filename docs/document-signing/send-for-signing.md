# Sending a Document for Signing

## Step 1: Upload the Document

From the **E-Signatures** page, click **Send for Signing** and upload your document. PDF is recommended; other formats are converted automatically.

If you start from a PDF in **Files** and it contains interactive form fields, Paralegix asks
before flattening it. Flattening preserves the filled appearance but turns the interactive
fields into fixed page content, which prevents those fields from changing after the signing
request begins. The flattened signing copy is separate from the original file.

You are then offered a choice. **Open signing** takes you into the full field designator described below, for a document that needs signature fields placed. For a document that just needs to go out quickly, without placing fields, use one of the other options instead: **Copy link**, **Send to client portal** (delivers it through in-app messaging), or **Send a signing link via email**.

## Step 2: Place Signature Fields

The document opens in the field designator. Click anywhere on a page to place a field, then configure it:

- **Type**: Signature, Initials, Date, Text, or Checkbox
- **Signer**: Which role this field belongs to (e.g. "Client", "Witness")
- **Required**: Whether the signer must complete this field before submitting
- **Label**: Optional label shown to the signer

You can drag fields to reposition them and resize them by dragging the corner handle.
Fields are color-coded by signer, so the same signer keeps the same color throughout the
document.

## Step 3: Configure Signers

In the **Signers** panel, add each person who needs to sign:

| Setting | Description |
|---|---|
| **Role label** | How this signer is referred to (e.g. "Client", "Notary") |
| **Signing order** | The sequence number, only relevant for sequential routing |
| **Delivery method** | How the signing link is delivered |
| **Name / Email** | Optionally pre-fill from a known client or firm member |
| **Access code** | Optional code the signer must enter before viewing |

### Delivery Methods

| Method | When to use |
|---|---|
| **Send via Email** | Send a link to an external email address |
| **Copy Signing Link** | Get the link yourself to send however you like |
| **Send in Paralegix** | Deliver it in-app: to the client's portal if the signer is a client, or to a firm member's dashboard if the signer is on your team |

## Step 4: Choose Routing Mode

- **Sequential**: Signers sign in the order you set. Each person is notified only after the previous one completes.
- **Parallel**: Everyone is notified at once and can sign in any order.

## Step 5: Send

Click **Send**. Paralegix:

1. Creates a secure signing session
2. Generates a unique link for each signer
3. Sends notifications via the chosen delivery method
4. Tracks progress in your signing history

## Saving as a Signing Template

If you'll be using the same field layout and signer configuration again (e.g. a standard retainer agreement), click **Save Template** before sending. You can reload it on future documents instead of placing fields from scratch.

See [Signing Templates](/document-signing/signing-templates) for more.
