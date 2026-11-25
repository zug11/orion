import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSnapshot } from '../types';
import { isSelectedAIConfigured } from '../lib/ai';
import type { SpaceDiscoveryMatch } from '../lib/spaceDiscovery';

const NO_TERMS: readonly string[] = [];
const NO_MATCHES: readonly SpaceDiscoveryMatch[] = [];

export function useSpacePickerSearch(open: boolean, input: string, spaces: readonly AppSnapshot[], active: AppSnapshot) {
  const query = input.trim();
  const configured = isSelectedAIConfigured(active.settings);
  const hasNotes = spaces.some(space => space.notes.length > 0);
  // A query that is cleared and retyped is a new search, even if its text is identical.
  const scope = useMemo(() => ({ query }), [open, query, active.workspace.id, active.settings.model, configured]);
  const [expansion, setExpansion] = useState<{
    scope: typeof scope; state: 'loading' | 'ready' | 'failed'; terms?: readonly string[];
  }>();
  const currentExpansion = expansion?.scope === scope ? expansion : undefined;
  const terms = currentExpansion?.terms ?? NO_TERMS;
  const [results, setResults] = useState<{
    scope: typeof scope; spaces: readonly AppSnapshot[]; terms: readonly string[];
    matches: readonly SpaceDiscoveryMatch[]; failed?: boolean;
  }>();
  const provider = useRef<AbortController | null>(null);
  useEffect(() => () => { provider.current?.abort(); provider.current = null; }, [scope]);

  useEffect(() => {
    if (!open || !query || !hasNotes) {
      setResults(undefined);
      setExpansion(undefined);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const { searchSpaceContents } = await import('../lib/spaceDiscovery');
        controller.signal.throwIfAborted();
        const matches = await searchSpaceContents(spaces, query, terms, controller.signal);
        if (!controller.signal.aborted) setResults({ scope, spaces, terms, matches });
      } catch {
        if (!controller.signal.aborted) setResults({ scope, spaces, terms, matches: NO_MATCHES, failed: true });
      }
    }, terms.length ? 0 : 120);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [scope, spaces, terms, open, query, hasNotes]);

  async function searchByMeaning() {
    if (!open || !query || !configured || !hasNotes || provider.current || currentExpansion?.state === 'ready') return;
    const controller = new AbortController();
    provider.current = controller;
    setExpansion({ scope, state: 'loading' });
    try {
      const { expandSpaceSearchQuery } = await import('../lib/spaceDiscoveryExpansion');
      controller.signal.throwIfAborted();
      const alternatives = await expandSpaceSearchQuery(query, active.settings, controller.signal);
      if (!controller.signal.aborted) setExpansion({ scope, state: 'ready', terms: alternatives.length ? alternatives : NO_TERMS });
    } catch {
      if (!controller.signal.aborted) setExpansion({ scope, state: 'failed' });
    } finally {
      if (provider.current === controller) provider.current = null;
    }
  }
  const current = results?.scope === scope && results.spaces === spaces ? results : undefined;
  return {
    matches: current?.matches ?? NO_MATCHES,
    localPending: Boolean(open && query && hasNotes && current?.terms !== terms),
    localFailed: current?.failed,
    hasNotes, configured, meaningState: currentExpansion?.state, searchByMeaning,
  };
}
