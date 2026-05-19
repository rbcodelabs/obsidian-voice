import { App, MarkdownView, Notice } from 'obsidian';

export const DOCUMENT_TOOLS = [
  {
    type: 'function',
    name: 'get_document',
    description: 'Get the full content of the currently open document.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'append_note',
    description: 'Append a timestamped note block to the end of the document.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The note content to append.',
        },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'insert_at_cursor',
    description: 'Insert text at the current cursor position in the editor.',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Text to insert at the cursor.',
        },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'replace_document',
    description:
      'Replace the entire document content with new content. Use sparingly: prefer append_note or insert_at_cursor for targeted changes.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The new full document content.',
        },
      },
      required: ['content'],
    },
  },
];

function getActiveEditor(app: App) {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) return null;
  return view.editor;
}

export function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  app: App
): string {
  const editor = getActiveEditor(app);

  if (name === 'get_document') {
    if (!editor) return 'Error: no document is currently open.';
    return editor.getValue();
  }

  if (name === 'append_note') {
    if (!editor) return 'Error: no document is currently open.';
    const text = String(args.text ?? '');
    const timestamp = new Date().toISOString();
    const noteBlock = `\n\n> [!NOTE] Voice Note: ${timestamp}\n> ${text.replace(/\n/g, '\n> ')}`;
    const current = editor.getValue();
    editor.setValue(current + noteBlock);
    new Notice('Voice: appended note');
    return `Appended note at ${timestamp}`;
  }

  if (name === 'insert_at_cursor') {
    if (!editor) return 'Error: no document is currently open.';
    const text = String(args.text ?? '');
    editor.replaceSelection(text);
    new Notice('Voice: inserted text at cursor');
    return 'Inserted text at cursor position.';
  }

  if (name === 'replace_document') {
    if (!editor) return 'Error: no document is currently open.';
    const content = String(args.content ?? '');
    editor.setValue(content);
    new Notice('Voice: replaced document content');
    return 'Document replaced successfully.';
  }

  return `Error: unknown tool "${name}"`;
}
