import { App, MarkdownView, Notice, TFile, TFolder, WorkspaceLeaf } from 'obsidian';

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
  {
    type: 'function',
    name: 'search_vault',
    description: 'Search all vault notes by filename and content. Returns matching file paths and excerpts.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for (case-insensitive)' },
        limit: { type: 'number', description: 'Max results to return (default 5, max 10)' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'open_file',
    description: 'Open a vault note by filename or path in a new tab.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename or path of the note to open (e.g. "My Note" or "folder/My Note.md")',
        },
      },
      required: ['filename'],
    },
  },
  {
    type: 'function',
    name: 'get_links',
    description: 'Get all outgoing wikilinks from the current document.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'create_document',
    description:
      'Create a new note at the given vault path with optional content, then open it. ' +
      'Intermediate folders are created automatically. ' +
      'Returns an error if the file already exists.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Vault-relative path for the new note, e.g. "Daily/2026-05-20.md". ' +
            'The .md extension is added automatically if omitted.',
        },
        content: {
          type: 'string',
          description: 'Initial content for the note (optional, defaults to empty).',
        },
        open: {
          type: 'boolean',
          description: 'Whether to open the new note in a tab after creation (default true).',
        },
      },
      required: ['path'],
    },
  },
  {
    type: 'function',
    name: 'list_folder',
    description:
      'List the files and subfolders inside a vault folder. ' +
      'Use this to browse the vault structure before deciding where to create a document.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Vault-relative folder path to list, e.g. "Daily" or "Projects/Active". ' +
            'Use "" or "/" for the vault root.',
        },
      },
      required: ['path'],
    },
  },
];

// Receives the view that VoiceView has been tracking via active-leaf-change,
// which correctly follows tab switches even when the Voice panel has focus.
function getActiveEditor(view: MarkdownView | null) {
  return view?.file ? view.editor : null;
}

export async function executeToolCall(
  name: string,
  args: Record<string, unknown>,
  app: App,
  activeView: MarkdownView | null = null
): Promise<string> {
  const editor = getActiveEditor(activeView);

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

  if (name === 'search_vault') {
    const query = String(args.query ?? '').toLowerCase();
    const limit = Math.min(Number(args.limit ?? 5), 10);
    if (!query) return 'Error: query is required';

    const files = app.vault.getMarkdownFiles();
    const results: { path: string; excerpt: string; score: number }[] = [];

    for (const file of files) {
      const nameMatch = file.basename.toLowerCase().includes(query);
      let content = '';
      try {
        content = await app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const lower = content.toLowerCase();
      const contentIdx = lower.indexOf(query);
      if (!nameMatch && contentIdx === -1) continue;

      const score = (nameMatch ? 10 : 0) + (contentIdx !== -1 ? 1 : 0);
      let excerpt = '';
      if (contentIdx !== -1) {
        const start = Math.max(0, contentIdx - 60);
        const end = Math.min(content.length, contentIdx + query.length + 120);
        excerpt =
          (start > 0 ? '…' : '') +
          content.slice(start, end).replace(/\n+/g, ' ').trim() +
          (end < content.length ? '…' : '');
      }
      results.push({ path: file.path, excerpt, score });
    }

    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, limit);
    if (top.length === 0) return `No results found for "${args.query}"`;
    return top
      .map((r, i) => {
        const lines = [`${i + 1}. ${r.path}`];
        if (r.excerpt) lines.push(`   "${r.excerpt}"`);
        return lines.join('\n');
      })
      .join('\n\n');
  }

  if (name === 'open_file') {
    const filename = String(args.filename ?? '');
    if (!filename) return 'Error: filename is required';
    const file =
      app.metadataCache.getFirstLinkpathDest(filename, '') ??
      app.vault.getAbstractFileByPath(filename);
    if (!file || !(file instanceof TFile)) return `Error: file not found: "${filename}"`;
    try {
      // Reuse an existing leaf if the file is already open somewhere.
      let existingLeaf: WorkspaceLeaf | null = null;
      app.workspace.iterateAllLeaves((l) => {
        if (l.view instanceof MarkdownView && l.view.file?.path === file.path) {
          existingLeaf = l;
        }
      });
      if (existingLeaf) {
        app.workspace.revealLeaf(existingLeaf);
        new Notice(`Voice: switched to ${file.name}`);
        return `Switched to already-open ${file.path}`;
      }
      const leaf = app.workspace.getLeaf('tab');
      await leaf.openFile(file);
      new Notice(`Voice: opened ${file.name}`);
      return `Opened ${file.path}`;
    } catch (e) {
      return `Error opening file: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === 'get_links') {
    if (!activeView?.file) return 'Error: no document open';
    const cache = app.metadataCache.getFileCache(activeView.file);
    const links = cache?.links ?? [];
    if (links.length === 0) return 'No outgoing links found in current document';
    const unique = [...new Set(links.map((l) => l.original))];
    return `Links in ${activeView.file.name}:\n` + unique.map((l) => `- ${l}`).join('\n');
  }

  if (name === 'create_document') {
    let notePath = String(args.path ?? '').trim();
    if (!notePath) return 'Error: path is required';
    if (!notePath.endsWith('.md')) notePath += '.md';
    const shouldOpen = args.open !== false;
    const content = String(args.content ?? '');

    // Check for existing file
    const existing = app.vault.getAbstractFileByPath(notePath);
    if (existing) return `Error: file already exists at "${notePath}"`;

    try {
      // Create intermediate folders
      const folderPath = notePath.includes('/') ? notePath.slice(0, notePath.lastIndexOf('/')) : '';
      if (folderPath && !app.vault.getAbstractFileByPath(folderPath)) {
        await app.vault.createFolder(folderPath);
      }
      const file = await app.vault.create(notePath, content);
      if (shouldOpen) {
        const leaf = app.workspace.getLeaf('tab');
        await leaf.openFile(file);
      }
      new Notice(`Voice: created ${file.name}`);
      return `Created ${notePath}${shouldOpen ? ' and opened it' : ''}`;
    } catch (e) {
      return `Error creating document: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  if (name === 'list_folder') {
    const folderPath = String(args.path ?? '').replace(/^\//, '');
    const folder =
      folderPath === '' || folderPath === '/'
        ? app.vault.getRoot()
        : app.vault.getAbstractFileByPath(folderPath);

    if (!folder || !(folder instanceof TFolder)) {
      return `Error: folder not found: "${folderPath || '/'}"`;
    }

    const children = folder.children.slice().sort((a, b) => {
      // Folders first, then files
      const aIsFolder = a instanceof TFolder ? 0 : 1;
      const bIsFolder = b instanceof TFolder ? 0 : 1;
      if (aIsFolder !== bIsFolder) return aIsFolder - bIsFolder;
      return a.name.localeCompare(b.name);
    });

    if (children.length === 0) return `Folder "${folderPath || '/'}" is empty`;

    const lines = children.map((c) =>
      c instanceof TFolder ? `📁 ${c.name}/` : `📄 ${c.name}`
    );
    return `Contents of "${folderPath || '/'}":${lines.map((l) => `\n  ${l}`).join('')}`;
  }

  return `Error: unknown tool "${name}"`;
}
