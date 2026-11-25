import { nanoid } from 'nanoid';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, RootContent } from 'mdast';
import { slugifyTitle } from '../data/defaults';
import type { Note } from '../types';
import { splitMarkdownFrontmatter } from './markdown';

export const MAX_CONTACT_LABEL_LENGTH = 200;

function validLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_CONTACT_LABEL_LENGTH
    && value === value.trim() && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

export function isContactMetadata(value: unknown): value is NonNullable<Note['contact']> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.version === 1 && Object.keys(record).every(key => key === 'version' || key === 'organization')
    && (!('organization' in record) || validLabel(record.organization));
}

export function isContactNote(note: Note): note is Note & { contact: NonNullable<Note['contact']> } {
  return isContactMetadata(note.contact);
}

const parser = unified().use(remarkParse).use(remarkGfm);
const linkCache = new WeakMap<Note, ReadonlySet<string>>();

function linkedNoteUrls(note: Note): ReadonlySet<string> {
  const urls = new Set<string>();
  const definitions = new Map<string, string>();
  const references = new Set<string>();
  function visit(node: Root | RootContent) {
    if (node.type === 'link' && node.url.startsWith('orion-note://')) urls.add(node.url);
    if (node.type === 'linkReference') references.add(node.identifier);
    if (node.type === 'definition' && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ('children' in node) node.children.forEach(visit);
  }
  visit(parser.parse(splitMarkdownFrontmatter(note.body).content));
  for (const id of references) {
    const url = definitions.get(id);
    if (url?.startsWith('orion-note://')) urls.add(url);
  }
  linkCache.set(note, urls);
  return urls;
}

export function contactSourceNotes(contactId: string, notes: readonly Note[]): Note[] {
  const target = `orion-note://${contactId}`;
  return notes.filter(note => {
    if (note.id === contactId) return false;
    const cached = linkCache.get(note);
    if (cached) return cached.has(target);
    return note.body.includes(target) && linkedNoteUrls(note).has(target);
  });
}

export function makeContactNote(name: string, organization?: string): Note | undefined {
  const title = name.trim();
  const company = organization?.trim();
  if (!validLabel(title) || (company && !validLabel(company))) return undefined;
  const id = `note-${nanoid(10)}`;
  const now = new Date().toISOString();
  return {
    id, title, slug: slugifyTitle(title) || id, summary: '', body: '',
    aliases: [], tags: [], kind: 'article', status: 'ready', conceptIds: [], sourceIds: [],
    createdAt: now, updatedAt: now,
    contact: company ? { version: 1, organization: company } : { version: 1 },
  };
}
