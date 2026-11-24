import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, CircleAlert, Copy } from 'lucide-preact';

/** The outcome of the latest copy, shown for a moment: '' once that moment is over. */
type Outcome = '' | 'done' | 'failed';

/**
 * Copy text to the clipboard. `outcome` is set for a moment after each attempt; each attempt
 * restarts that moment. The outcome goes to a polite live region, so the control keeps its own name.
 * A rejected write (permission denied, insecure context) says so: silence would read as success.
 */
function useCopy(text: string) {
  const [outcome, setOutcome] = useState<Outcome>('');
  const timer = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    let next: Outcome = 'done';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'failed';
    }
    clearTimeout(timer.current);
    setOutcome(next);
    timer.current = window.setTimeout(() => setOutcome(''), next === 'failed' ? 2400 : 1400);
  };
  return { outcome, copy };
}

const MESSAGE: Record<Outcome, string> = { '': '', done: 'Copied', failed: 'Copy failed' };

const Announce = ({ outcome }: { outcome: Outcome }) => <span class="sr-only" role="status">{MESSAGE[outcome]}</span>;

export function CopyIconButton({ text, label, small }: { text: string; label: string; small?: boolean }) {
  const { outcome, copy } = useCopy(text);
  const size = small ? 14 : 16;
  return (
    <>
      <button type="button" class={'icon-btn copy' + (small ? ' copy-sm' : '') + (outcome ? ' is-' + outcome : '')} onClick={copy} aria-label={label} title={outcome === 'failed' ? MESSAGE.failed : label}>
        {outcome === 'done' ? <Check size={size} /> : outcome === 'failed' ? <CircleAlert size={size} /> : <Copy size={size} />}
      </button>
      <Announce outcome={outcome} />
    </>
  );
}

export function CopyTextButton({ text, label, icon }: { text: string; label: string; icon: ComponentChildren }) {
  const { outcome, copy } = useCopy(text);
  return (
    <>
      <button type="button" class={'btn btn-quiet' + (outcome ? ' is-' + outcome : '')} onClick={copy} aria-label={label}>
        {outcome === 'done' ? <Check size={14} /> : outcome === 'failed' ? <CircleAlert size={14} /> : icon} {MESSAGE[outcome] || label}
      </button>
      <Announce outcome={outcome} />
    </>
  );
}
