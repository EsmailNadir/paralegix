# Templates

Templates let your firm create reusable document layouts with dynamic fields. Instead of drafting the same contract or letter from scratch each time, you build it once, then fill in the client-specific details when you need it.

## Supported Formats

Every template starts from a document. You can upload:

- **PDF**
- **DOCX / DOC**
- **ODT, RTF, TXT** (also accepted on upload, converted automatically)

File size limit: **50 MB**

## Two Ways to Build a Template

### Document Overlay (the default)

Uploading a file creates a **Document Overlay** template right away. The document is rendered as a real PDF and opens in the overlay editor, where you click to pin fields directly on top of it, exactly where the blanks go. This is the fastest way to turn an existing document (a retainer letter, an intake form, a court form) into a fillable template without retyping it.

If you'd rather build an editable template instead, choose **Use the full editor instead** from the overlay editor. This is a one-way switch, offered only right after upload, before anything has been saved.

### The Full Editor (HTML / DOCX)

The full editor is the older, editable path:

- **HTML**: build a document directly in the in-browser rich-text editor
- **DOCX / DOC**: upload a Word document and edit its converted HTML, or keep it as a merge-field DOCX

Once a template is saved, its authoring mode is fixed. Document Overlay templates stay Document Overlay, and full-editor templates stay HTML or DOCX; there's no converting one into another later.

## The Templates Library

Open **Templates** from the sidebar. The library has two tabs:

- **Folders** groups your templates the way your firm files them, with subfolders as deep as you need.
- **All templates** is the flat list of every template in the firm, which is the quickest way to find one by name.

Each tab shows a count so you can see at a glance how much is filed and how much exists in total.

## Creating a Template

1. Navigate to **Templates** from the sidebar.
2. Click **New Template** (or drag a file onto the panel).
3. Upload your document. It opens as a Document Overlay template, ready for you to pin fields onto it.
4. Click anywhere on the page to place a field, or add a repeater for content that repeats down the page.
5. Click **Save**.

To build an HTML template from scratch, or an editable merge-field DOCX, choose **Use the full editor instead** right after uploading.

## Fields

### Document Overlay fields

In the overlay editor, you place a field by clicking on the page where a value should print, then give it a name. Each field is one of:

| Type | Description |
|---|---|
| **Text** | Free-form text |
| **Date** | A date value |
| **Checkbox** | On/off |

Fields can be dragged to reposition and resized from their corner handle.

#### Matching the document's own font

In **Select** mode, click a line of the document (or drag across it) to read its font. The toolbar shows the family, the size in points, and the weight and slant of that text, and the line is highlighted on the page. The readout stays while you switch to **Field** mode and draw a box. With a text, date or text box field selected, click **Match** to give it the sampled font, size, weight and slant.

#### Font size

The size you choose is a maximum. Text that does not fit the box wraps, then shrinks by whole points until it fits, both on the canvas and in the printed document. When that happens the toolbar shows the size the text actually renders at ("fits at 9"). Enlarge the box or shorten the text to get the chosen size back. **Auto** picks a size from the box height, between 10 and 18 points.

#### Keyboard shortcuts

With a box selected (and nothing being typed into):

| Keys | Action |
|---|---|
| **Delete** / **Backspace** | Delete the box |
| **Arrow keys** | Nudge the box by a quarter percent of the page (hold **Shift** for one percent) |
| **Cmd/Ctrl + D** | Duplicate the box beside the original (standalone boxes only) |
| **Cmd/Ctrl + Z** / **Cmd/Ctrl + Shift + Z** | Undo / redo box changes (typing inside a text box has its own undo) |
| **Esc** | Deselect |

The toolbar's undo and redo buttons do the same.

#### Text boxes and field chips

A text box holds fixed text with its own bold, italic and color per run, and can carry a **field chip** (an inline reference to a field, inserted with **+ Field**) that fills with that field's value. A field referenced only by a chip is still asked for when the template is filled, so it never prints blank.

### HTML / DOCX placeholder fields

In the full editor, placeholders are inserted inline in the document text, written as `{field_name}`. When you fill the template, you're prompted to enter a value for each one.

Common placeholders the editor suggests:

| Category | Examples |
|---|---|
| Client | `{client_name}`, `{client_email}`, `{client_phone}` |
| Matter | `{matter_name}`, `{matter_number}`, `{practice_area}` |
| Firm | `{firm_name}`, `{firm_address}`, `{attorney_name}` |
| Date | `{date}`, `{today}`, `{effective_date}` |

You can also define your own custom placeholder names.

## Repeating Sections

For content that repeats (e.g. a table of invoice line items or a list of witnesses), you can define a **repeater**.

- In the full editor, a repeater wraps a block of placeholders; when filling the template you add as many rows as needed and each row gets its own field values.
- In the Document Overlay editor, a repeater is a set of field boxes anchored to a starting row on the page; when filling the template, added rows print one below the other down the page.

## Filling a Template

See [Filling a Template](/templates/fill) for the full flow. It works the same way for Document Overlay, DOCX, and HTML templates.

## Organizing Templates

Templates are grouped into **folders**, managed from the **Folders** tab. From there you can:

- Create folders and subfolders, and rename or delete them
- Move a template into a different folder
- Search across all templates by name

Each template row also carries **Fill**, **Preview**, **Edit template**, **Move to folder**, and **Delete template** actions.

## Previewing a Template

Click **Preview** on any template to see it rendered read-only: the document itself for a Document Overlay or DOCX template, or the formatted HTML for an HTML template. This shows the template as-is, with fields still blank; use **Fill** to see it with real values filled in.

## Editing an Existing Template

Open the **⋮** menu on any template and choose **Edit template** to reopen it in its editor (the Document Overlay editor or the full editor, matching how it was built). Any changes you save will apply the next time the template is filled. Previously generated documents are not affected.
