'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/** A gap in the page numbers, standing for every page it hides. */
export const GAP = 'gap' as const;

/** How many consecutive page numbers sit around the current one. */
const SPAN = 5;

/**
 * The page numbers worth drawing, and where the run is broken.
 *
 * The first and last pages are always reachable in one click — they are the
 * two a reader asks for by name — and a window slides between them. The window
 * keeps its width at both ends rather than shrinking, so the control does not
 * change size as the reader walks through it.
 */
export function pageItems(page: number, pages: number): (number | typeof GAP)[] {
  if (pages <= SPAN + 2) return Array.from({ length: pages }, (_, index) => index + 1);

  const start = Math.max(1, Math.min(page - Math.floor(SPAN / 2), pages - SPAN + 1));
  const end = Math.min(pages, start + SPAN - 1);

  // A gap costs a click and gives back a page the reader could have had
  // directly, so where it would stand for a single page, that page is drawn.
  const items: (number | typeof GAP)[] = [];
  if (start > 1) {
    items.push(1);
    if (start === 3) items.push(2);
    else if (start > 3) items.push(GAP);
  }
  for (let n = start; n <= end; n += 1) items.push(n);
  if (end < pages) {
    if (end === pages - 2) items.push(pages - 1);
    else if (end < pages - 2) items.push(GAP);
    items.push(pages);
  }
  return items;
}

/** A page number typed into the gap, or null if it is not one. */
export function parsePage(text: string, pages: number): number | null {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < 1 || value > pages) return null;
  return value;
}

interface PagerProps {
  page: number;
  pages: number;
  onPage(page: number): void;
}

/**
 * Page navigation for a list that does not fit on one screen.
 *
 * The gap is not decoration: on a hundred pages the window can only ever offer
 * a handful, and clicking the gap is how a reader reaches the ninety-first
 * without pressing next ninety times.
 */
export function Pager({ page, pages, onPage }: PagerProps) {
  const [typingAt, setTypingAt] = useState<number | null>(null);

  if (pages <= 1) return null;

  const go = (next: number): void => {
    setTypingAt(null);
    if (next !== page) onPage(next);
  };

  return (
    <nav aria-label="Pages" className="flex shrink-0 items-center justify-center gap-1">
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={page <= 1}
        aria-label="Previous page"
        onClick={() => go(page - 1)}
      >
        <ChevronLeft className="size-4" />
      </Button>

      {pageItems(page, pages).map((item, index) =>
        item === GAP ? (
          typingAt === index ? (
            <PageInput
              // biome-ignore lint/suspicious/noArrayIndexKey: the slot is the identity
              key={`gap-${index}`}
              pages={pages}
              onCommit={go}
              onCancel={() => setTypingAt(null)}
            />
          ) : (
            <Button
              // biome-ignore lint/suspicious/noArrayIndexKey: the slot is the identity
              key={`gap-${index}`}
              variant="ghost"
              size="sm"
              className="size-7 px-0 font-mono text-xs text-muted-foreground"
              aria-label={`Go to a page between 1 and ${pages}`}
              onClick={() => setTypingAt(index)}
            >
              …
            </Button>
          )
        ) : (
          <Button
            key={item}
            variant={item === page ? 'secondary' : 'ghost'}
            size="sm"
            aria-current={item === page ? 'page' : undefined}
            className={cn(
              'size-7 px-0 font-mono text-xs tabular',
              item === page && 'font-semibold',
            )}
            onClick={() => go(item)}
          >
            {item}
          </Button>
        ),
      )}

      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        disabled={page >= pages}
        aria-label="Next page"
        onClick={() => go(page + 1)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </nav>
  );
}

/** The gap, once it has been clicked: type a page and press Enter. */
function PageInput({
  pages,
  onCommit,
  onCancel,
}: {
  pages: number;
  onCommit(page: number): void;
  onCancel(): void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    field.current?.focus();
  }, []);

  const valid = parsePage(text, pages);

  return (
    <Input
      ref={field}
      value={text}
      inputMode="numeric"
      aria-label={`Page number, 1 to ${pages}`}
      placeholder={String(pages)}
      className={cn(
        'h-7 w-14 px-1 text-center font-mono text-xs tabular',
        text !== '' && valid === null && 'border-destructive',
      )}
      onChange={(event) => setText(event.target.value)}
      onBlur={onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && valid !== null) onCommit(valid);
        if (event.key === 'Escape') onCancel();
      }}
    />
  );
}
