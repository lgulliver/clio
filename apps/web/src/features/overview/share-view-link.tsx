import { useRouter } from '@tanstack/react-router';
import { useEffect, useId, useRef, useState } from 'react';
import type { OverviewSearch } from './view-search';

export function ShareViewLink({ search }: { search: OverviewSearch }) {
  const router = useRouter();
  const href = new URL(router.buildLocation({ to: '/', search }).href, window.location.origin).href;
  const current = useRef(href);
  current.current = href;
  const mounted = useRef(true);
  const field = useRef<HTMLInputElement>(null);
  const [manual, setManual] = useState(false);
  const [copied, setCopied] = useState('');
  const id = useId();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (manual) {
      field.current?.focus();
      field.current?.select();
    }
  }, [manual]);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(href);
      if (mounted.current && current.current === href) {
        setCopied(href);
        setManual(false);
      }
    } catch {
      if (mounted.current && current.current === href) {
        setManual(true);
        setCopied('');
      }
    }
  }
  return (
    <div className="mb-4">
      <button type="button" className="control" onClick={() => void copy()}>
        Copy view link
      </button>
      <p role="status" className="mt-2 text-sm text-clio-muted">
        {copied === href
          ? 'View link copied.'
          : 'Links require workspace access and reopen the first service page.'}
      </p>
      {manual && (
        <div className="mt-2">
          <label htmlFor={id}>View link — select and copy</label>
          <input
            ref={field}
            id={id}
            className="field w-full"
            readOnly
            value={href}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
