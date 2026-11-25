import { describe, expect, it } from 'vitest';
import { createEmptyVault } from '../data/defaults';
import { makeContactNote, isContactNote, contactSourceNotes } from './contacts';
import { buildPortableCollection, parsePortableFile, portableCollectionHash, importPortableCollection } from './portableOrion';

describe('Space contact notes', () => {
  it('creates independent notes with literal names, Unicode, and an optional organization', () => {
    const ada = makeContactNote('  Ada [Ng]  ', '  Planet Studio  ')!;
    expect(ada).toMatchObject({ title: 'Ada [Ng]', body: '', contact: { version: 1, organization: 'Planet Studio' } });
    expect(makeContactNote(ada.title)?.id).not.toBe(ada.id);
    expect(makeContactNote('王 偉', '   ')).toMatchObject({ title: '王 偉', slug: expect.any(String), contact: { version: 1 } });
    expect(isContactNote({ ...ada, title: '' })).toBe(true);
    expect(isContactNote({ ...ada, kind: 'person', contact: undefined })).toBe(false);
    expect(makeContactNote('   ')).toBeUndefined();
    expect(makeContactNote('Ada\nNg')).toBeUndefined();
    expect(makeContactNote('Ada', '😀'.repeat(101))).toBeUndefined();
  });

  it('finds explicit links in the supplied Space and ignores names, code, images and unused references', () => {
    const contact = makeContactNote('Sam')!;
    const url = `orion-note://${contact.id}`;
    const link = `[Sam](${url})`;
    const source = (id: string, body: string) => ({ ...contact, contact: undefined, id, body });
    const direct = source('meeting', link);
    const reference = source('call', `Spoke to [Sam][who].\n\n[who]: ${url}`);
    const example = source('examples', `---\ncontact: ${link}\n---\n\nSam\n\n\`${link}\`\n\n~~~\n${link}\n~~~\n\n!${link}\n\n[unused]: ${url}\n\n[Sam](${url}-other)`);
    expect(contactSourceNotes(contact.id, [{ ...contact, body: link }, example, direct, reference])).toEqual([direct, reference]);
    expect(contactSourceNotes(contact.id, [{ ...direct, body: 'Meeting over.' }, reference])).toEqual([reference]);
  });

  it('exports selected contacts, preserves included links and strips excluded contact details', async () => {
    const vault = createEmptyVault('Clients');
    const contact = makeContactNote('Sam', 'Lua Studio')!;
    const source = { ...contact, contact: undefined, id: 'source', title: 'Meeting', body: `Met [Sam](orion-note://${contact.id}).` };
    vault.spaces[0].notes = [source, contact];
    const single = buildPortableCollection(vault.spaces[0], [source.id]);
    expect(JSON.stringify(single)).not.toContain('Lua Studio');
    expect(single.collection.notes[0].body).not.toContain(contact.id);
    const file = parsePortableFile(JSON.stringify(buildPortableCollection(vault.spaces[0], [source.id, contact.id])));
    const imported = importPortableCollection(vault, file, await portableCollectionHash(file), {});
    const notes = imported.vault.spaces.find(space => space.workspace.id === imported.spaceId)!.notes;
    expect(notes.filter(isContactNote).map(note => [note.id, note.title, note.contact])).toEqual([[contact.id, contact.title, contact.contact]]);
    expect(notes[0].body).toContain(`orion-note://${contact.id}`);
    for (const invalid of [null, { version: 2 }, { version: 1, organization: '' }, { version: 1, extra: 'unrecognized' }]) {
      Object.assign(file.collection.notes[1], { contact: invalid });
      expect(() => parsePortableFile(JSON.stringify(file))).toThrow('invalid contact');
    }
  });
});
